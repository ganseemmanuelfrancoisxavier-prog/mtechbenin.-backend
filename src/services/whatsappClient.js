const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const QRCode = require("qrcode");
const logger = require("../utils/logger");
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { extraireAdressage, messageTropAncien } = require("./whatsappMessage");
const { fichiersElaguables, intervalleElagageMs } = require("./whatsappElagage");
// L'alerte de session perdue part par E-MAIL, jamais par WhatsApp : c'est
// precisement WhatsApp qui est tombe. `email.js` ne require pas ce fichier, il
// n'y a donc pas de cycle.
const emailSvc = require("./email");

const prisma = new PrismaClient();

// ── Dossier de la session WhatsApp ────────────────────────────────────────────
//
// Le defaut reste `/tmp` : c'est ce qu'impose Render, dont le disque n'est pas
// persistant et dont seul `/tmp` est inscriptible. La session y est donc
// ephemere, et c'est pour cela qu'elle est aussi conservee en base.
//
// Sur un VPS, `/tmp` est un mauvais choix : `systemd-tmpfiles` le purge
// periodiquement, y compris pendant que le service tourne. Pointer
// `WHATSAPP_SESSION_PATH` vers un dossier persistant (p. ex.
// `/var/lib/mtechbenin/whatsapp-session`) evite un rechargement depuis la base
// a chaque redemarrage — et surtout la purge silencieuse d'une session vivante.
const SESSION_PATH =
  process.env.WHATSAPP_SESSION_PATH || path.join("/tmp", "whatsapp-session");

let sock = null;

// Une seule alerte par panne, pas une par tentative de reconnexion.
//
// Ce drapeau seul NE SUFFISAIT PAS, et le defaut a coute cher : il etait remis
// a `false` des qu'une connexion s'ouvrait, sans exiger qu'elle tienne. Or une
// session invalide produit exactement ce profil — Baileys se connecte, se fait
// deconnecter aussitot, recommence trois secondes plus tard. Chaque cycle
// rearmait le drapeau puis renvoyait un e-mail : jusqu'a vingt par minute.
//
// D'ou deux verrous, et non un :
//   • le drapeau, qui empeche de re-signaler une panne deja signalee ;
//   • un intervalle minimum entre deux alertes, qui tient meme si le drapeau
//     est rearme a tort. C'est le vrai filet : il ne depend d'aucune
//     hypothese sur le comportement de Baileys.
let _alerteDeconnexionEnvoyee = false;
let _deconnecteDepuis = null;
let _derniereAlerteSession = 0;
let _minuteurRearmement = null;

const INTERVALLE_MIN_ALERTE_MS = 60 * 60 * 1000;

// Une connexion doit TENIR avant qu'on considere la panne finie. Sans ce
// delai, un `open` d'une demi-seconde suffisait a rearmer l'alerte.
const STABILITE_AVANT_REARMEMENT_MS = 5 * 60 * 1000;
let isReady = false;
let _saveTimer = null;
// Empreinte du dernier contenu réellement écrit en base. Sert à ne pas
// réécrire une session identique — voir saveSessionToDb.
let _derniereEmpreinte = null;

// Gestionnaire des messages entrants, injecté par src/app.js. Ce fichier gère
// la session ; il n'a pas à connaître la logique métier des abonnements.
let gestionnaireMessages = null;

// Journalise la forme d'adressage UNE fois par démarrage (voir la boucle
// `messages.upsert`). Un booléen suffit : ce n'est pas un compteur, c'est un
// « déjà dit ».
let adressageJournalise = false;

function setGestionnaireMessages(fn) {
  gestionnaireMessages = fn;
}

// Sauvegarde en DB au plus une fois toutes les 30s même si creds.update spam
function scheduleSaveSession() {
  if (_saveTimer) return; // une sauvegarde déjà planifiée, on ignore
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    await saveSessionToDb();
  }, 30_000);
}

function getClient() {
  return sock;
}
function isConnected() {
  return isReady;
}

// Force une sauvegarde immédiate (annule le throttle 30s) — utilisé à l'arrêt
// du process pour ne pas perdre une rotation de clé Baileys qui vient de se
// produire juste avant un redéploiement/restart Render.
async function flushSessionSave() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  await saveSessionToDb();
}

// ── Sauvegarde la session dans Supabase ───────────────────────────────────────
// Fichiers de session deja signales comme illisibles (voir saveSessionToDb).
const _fichiersIllisiblesSignales = new Set();

async function saveSessionToDb() {
  try {
    if (!fs.existsSync(SESSION_PATH)) return;

    const files = fs.readdirSync(SESSION_PATH);
    const data = {};
    // Ils se comptent par milliers : une ligne PAR fichier en faisait encore
    // 3 130 a chaque demarrage. On les resume en une seule.
    const nouveauxIllisibles = [];

    for (const file of files) {
      const filePath = path.join(SESSION_PATH, file);
      const content = fs.readFileSync(filePath, "utf-8");
      try {
        data[file] = JSON.parse(content);
      } catch {
        // Un fichier illisible est un fichier saisi en cours d'écriture par
        // Baileys, pas une donnée. L'enregistrer tel quel a déjà empoisonné la
        // session en production : `creds.json` s'est retrouvé stocké comme
        // chaîne vide, et le serveur repartait ensuite d'une identité neuve à
        // chaque démarrage tout en conservant les clés de l'ancienne. On
        // préfère garder la version précédente de ce fichier.
        //
        // Signale UNE fois par fichier. Certains fichiers (`lid-mapping-…`)
        // ne sont jamais lisibles : l'avertissement revenait a chaque
        // sauvegarde et faisait 99,4 % du journal du serveur (40 078 lignes
        // sur 40 313, mesure du 13/10/2026), si bien que le journal ne
        // couvrait plus que deux jours et demi.
        if (!_fichiersIllisiblesSignales.has(file)) nouveauxIllisibles.push(file);
      }
    }

    if (nouveauxIllisibles.length > 0) {
      for (const f of nouveauxIllisibles) _fichiersIllisiblesSignales.add(f);
      logger.warn(
        `${nouveauxIllisibles.length} fichier(s) de session illisible(s) — ignorés (signalés une seule fois)`,
        { exemples: nouveauxIllisibles.slice(0, 3) },
      );
    }

    // Sans identité valide, la session ne vaut rien : la réécrire écraserait
    // la dernière bonne version par un état inutilisable.
    const creds = data["creds.json"];
    if (!creds || typeof creds !== "object") {
      logger.warn("Session non sauvegardée : creds.json absent ou invalide");
      return;
    }

    // ── Deux gardes contre la consommation d'egress Supabase ────────────────
    //
    // La session Baileys pèse près de 2 Mo de JSON. Sans ces gardes, elle
    // ressortait de Supabase toutes les 30 secondes — plus de 200 Mo par
    // heure, alors que le quota gratuit est de 5 Go par MOIS. Une page
    // d'accueil complète, à côté, pèse 32 Ko.
    //
    // 1) On n'écrit pas si rien n'a changé. Baileys déclenche `creds.update`
    //    très souvent sans que le contenu diffère toujours.
    const empreinte = JSON.stringify(data);
    if (empreinte === _derniereEmpreinte) {
      return;
    }

    // 2) `select` limite ce que Postgres RENVOIE. Sans lui, `upsert` rend la
    //    ligne entière — c'est-à-dire les 2 Mo qu'on vient d'écrire, qui
    //    repartent aussitôt dans l'autre sens. On ne demande que l'identifiant.
    await prisma.whatsAppSession.upsert({
      where: { id: "main" },
      update: { data },
      create: { id: "main", data },
      select: { id: true },
    });

    _derniereEmpreinte = empreinte;
    // La TAILLE est journalisee, pas seulement le fait. Sans elle, on ne peut
    // pas repondre a « qu'est-ce qui consomme le quota ? » autrement qu'en
    // raisonnant sur le code — ce qui laisse une part d'incertitude au moment
    // ou l'on a besoin d'une reponse.
    logger.info(
      `💾 Session WhatsApp sauvegardée dans Supabase (${Object.keys(data).length} fichiers, ` +
        `${(empreinte.length / 1048576).toFixed(1)} Mo)`,
    );
  } catch (err) {
    logger.error("Erreur sauvegarde session Supabase", { err: err.message });
  }
}

// Previent l'exploitant que le bot ne peut plus rien envoyer.
//
// Le silence etait le vrai defaut : la session est tombee un matin, la table
// de session a ete purgee, et le bot a passe plus d'une journee muet sans que
// rien ne le signale. `/health` disait « disconnected », mais personne ne lit
// `/health`. Toutes les autres alertes de ce projet passent par WhatsApp —
// inutilisable ici, par construction.
async function alerterSessionPerdue(titre, detail) {
  if (_alerteDeconnexionEnvoyee) return;

  // Filet independant du drapeau : meme rearme a tort, une alerte de session
  // ne peut pas repartir avant une heure.
  const depuisDerniere = Date.now() - _derniereAlerteSession;
  if (_derniereAlerteSession && depuisDerniere < INTERVALLE_MIN_ALERTE_MS) {
    logger.warn(
      `Session WhatsApp toujours perdue — alerte deja envoyee il y a ${Math.round(depuisDerniere / 60000)} min, non repetee`,
    );
    _alerteDeconnexionEnvoyee = true;
    return;
  }

  _alerteDeconnexionEnvoyee = true;
  _derniereAlerteSession = Date.now();
  try {
    const envoye = await emailSvc.sendAdminAlert({
      sujet: titre,
      message: [
        detail,
        "",
        "Tant que la session n'est pas retablie, le bot ne peut RIEN envoyer :",
        "  • aucun code de verification aux clients,",
        "  • aucun identifiant apres un paiement,",
        "  • aucune alerte administrateur par WhatsApp,",
        "et il ne peut pas non plus RECEVOIR les messages « CODE » entrants.",
        "",
        "Pour retablir : ouvrez /api/whatsapp/qr/scan?token=<QR_SECRET> et",
        "scannez le QR depuis le telephone de la boutique.",
      ].join("\n"),
    });
    if (envoye) logger.info("Alerte e-mail envoyee : session WhatsApp perdue");
    else logger.error("Alerte session WhatsApp NON delivree — e-mail en echec");
  } catch (err) {
    logger.error("Alerte session WhatsApp echouee", { err: err.message });
  }
}

// Une deconnexion qui dure vaut une session perdue.
//
// L'alerte immediate ci-dessus ne couvre que le cas `loggedOut`. Baileys peut
// aussi boucler sur des reconnexions qui echouent — reseau, version, Supabase
// injoignable — sans jamais annoncer de deconnexion definitive. Le bot est
// alors tout aussi muet, et personne ne le sait.
//
// `unref()` : ce minuteur ne doit pas maintenir le processus en vie. Sans lui,
// un script qui se contente de charger ce module ne rendrait jamais la main.
const DELAI_ALERTE_MS = 10 * 60 * 1000;

// Apres une deconnexion DEFINITIVE (session revoquee cote telephone), le
// redemarrage ne sert qu'a reafficher un QR. Cinq minutes : assez court pour
// qu'un QR soit disponible quand l'exploitant se connecte, assez long pour ne
// pas transformer une panne en boucle.
const DELAI_APRES_DECONNEXION_MS = 5 * 60 * 1000;

// ── Élagage périodique de la session ────────────────────────────────────────
//
// La session grossit vite, et pas là où on l'imagine : mesuré en production,
// `sender-key-status@broadcast` — les clés servant à déchiffrer les STATUTS
// des contacts — repasse de 0 à 2 045 fichiers et 3,83 Mo en vingt heures,
// soit 35 % du poids total. Ce bot n'a jamais lu un statut et n'en lira jamais.
//
// Voir `whatsappElagage.js` pour le raisonnement complet, notamment pourquoi
// l'élagage se fait par NATURE et non par âge : les dates des fichiers sont
// réécrites au démarrage, et l'horodatage interne des sessions ne discrimine
// rien (la plus ancienne des 2 943 sessions mesurées avait 4 jours).
async function elaguerSession() {
  // Pas pendant une restauration ou une reconnexion : on ne touche pas à un
  // dossier que Baileys est en train de reconstruire.
  if (!isReady) return;
  if (!fs.existsSync(SESSION_PATH)) return;

  try {
    const cibles = fichiersElaguables(fs.readdirSync(SESSION_PATH));
    if (cibles.length === 0) return;

    let octets = 0;
    let supprimes = 0;
    for (const nom of cibles) {
      const chemin = path.join(SESSION_PATH, nom);
      try {
        octets += fs.statSync(chemin).size;
        fs.unlinkSync(chemin);
        supprimes += 1;
      } catch {
        // Un fichier disparu entre le relevé et la suppression n'est pas une
        // erreur : c'est le résultat voulu.
      }
    }

    // Indispensable, et c'est le piège de tout élagage ici : le chargement
    // depuis la base réécrit le dossier SANS le nettoyer. Sans cette
    // sauvegarde, les fichiers supprimés reviendraient au premier
    // redémarrage — l'élagage n'aurait servi à rien.
    //
    // `_derniereEmpreinte` est remise à zéro : le contenu a changé sur le
    // disque sans passer par `creds.update`, et la garde anti-réécriture
    // sauterait la sauvegarde en croyant la session inchangée.
    _derniereEmpreinte = null;
    await flushSessionSave();

    logger.info(
      `🧹 Session élaguée : ${supprimes} clé(s) de statut retirée(s) ` +
        `(${(octets / 1048576).toFixed(2)} Mo)`,
    );
  } catch (err) {
    // Un élagage raté ne doit jamais empêcher le bot de fonctionner.
    logger.warn("Élagage de session impossible", { err: err.message });
  }
}

const INTERVALLE_ELAGAGE_MS = intervalleElagageMs(process.env.WHATSAPP_ELAGAGE_HEURES);
if (INTERVALLE_ELAGAGE_MS > 0) {
  // Un premier passage peu apres le demarrage, sans attendre l'intervalle
  // complet : au redeploiement suivant la session porte deja son arriere de
  // cles de statut, et attendre 24 h pour le retirer n'aurait pas de sens.
  //
  // Cinq minutes de delai : le temps que la restauration depuis la base et la
  // connexion Baileys soient finies. `elaguerSession` verifie `isReady` de
  // toute facon — le delai evite simplement un passage a vide.
  const _premierElagage = setTimeout(() => {
    elaguerSession();
  }, 5 * 60 * 1000);
  if (typeof _premierElagage.unref === "function") _premierElagage.unref();

  const _elagage = setInterval(() => {
    elaguerSession();
  }, INTERVALLE_ELAGAGE_MS);
  // Ce minuteur ne doit pas maintenir le processus en vie.
  if (typeof _elagage.unref === "function") _elagage.unref();
  logger.info(
    `🧹 Élagage de session actif — toutes les ${INTERVALLE_ELAGAGE_MS / 3600000} h`,
  );
} else {
  logger.info("🧹 Élagage de session désactivé (WHATSAPP_ELAGAGE_HEURES)");
}

const _veille = setInterval(() => {
  if (isReady || !_deconnecteDepuis) return;
  if (Date.now() - _deconnecteDepuis < DELAI_ALERTE_MS) return;
  alerterSessionPerdue(
    "WhatsApp injoignable depuis plus de 10 minutes",
    "La session ne s'est pas retablie malgre les tentatives de reconnexion " +
      "automatiques. Un nouveau QR est probablement necessaire.",
  );
}, 60 * 1000);
_veille.unref();

// ── Charge la session depuis Supabase vers /tmp ───────────────────────────────
async function loadSessionFromDb() {
  try {
    const record = await prisma.whatsAppSession.findUnique({
      where: { id: "main" },
    });
    if (!record) {
      logger.info("📭 Aucune session en base — nouveau QR requis");
      return false;
    }

    const data = record.data || {};
    // Ce que cette lecture a REELLEMENT coute en trafic sortant. `findUnique`
    // ne porte pas de `select` — et il ne le peut pas, c'est le contenu qu'on
    // vient chercher — donc tout le blob remonte a chaque appel.
    const octetsLus = JSON.stringify(data).length;

    // Une session sans identité exploitable ne peut pas être restaurée : au
    // démarrage, Baileys repart d'une identité neuve mais hérite des milliers
    // de clés de l'ancienne. L'appairage semble alors réussir sur le téléphone
    // puis retombe aussitôt — c'est exactement ce qui rendait le QR
    // inopérant. Mieux vaut repartir de zéro et effacer la ligne fautive.
    const creds = data["creds.json"];
    if (!creds || typeof creds !== "object") {
      logger.warn(
        "Session en base inutilisable (creds.json absent ou vide) — suppression et nouveau QR",
      );
      await prisma.whatsAppSession.deleteMany({ where: { id: "main" } });
      _derniereEmpreinte = null;
      return false;
    }

    if (!fs.existsSync(SESSION_PATH)) {
      fs.mkdirSync(SESSION_PATH, { recursive: true });
    }

    for (const [file, content] of Object.entries(data)) {
      const filePath = path.join(SESSION_PATH, file);
      fs.writeFileSync(
        filePath,
        typeof content === "string" ? content : JSON.stringify(content),
        "utf-8",
      );
    }

    logger.info(
      `📥 Session WhatsApp chargée depuis Supabase (${Object.keys(data).length} fichiers, ` +
        `${(octetsLus / 1048576).toFixed(1)} Mo lus)`,
    );
    return true;
  } catch (err) {
    logger.error("Erreur chargement session Supabase", { err: err.message });
    return false;
  }
}

// ── Supprime la session (local + Supabase) ────────────────────────────────────
async function destroyAndClean() {
  isReady = false;
  if (sock) {
    try {
      sock.end();
    } catch {}
    sock = null;
  }
  // Vide le CONTENU du dossier, sans supprimer le dossier lui-même.
  //
  // `fs.rmSync(SESSION_PATH, { recursive: true })` échouait avec EBUSY : sur le
  // VPS ce chemin est un POINT DE MONTAGE Docker, qu'un processus ne peut pas
  // supprimer. Sur Render c'était un dossier ordinaire dans /tmp, et la
  // différence ne se voyait pas.
  //
  // La conséquence, observée en production pendant des jours : la session morte
  // survivait à son propre effacement. Baileys relisait les mêmes identifiants
  // révoqués, recevait un nouveau 401, rappelait `destroyAndClean`, échouait
  // encore — 590 fois par heure. Le quota d'envoi d'e-mails y est passé, et la
  // mémoire du processus avec.
  let supprimes = 0;
  // Dit à l'appelant si la session locale est REELLEMENT partie. De cette
  // reponse depend le delai avant nouvelle tentative : sans nettoyage, Baileys
  // relirait les memes identifiants revoques et la boucle repartirait.
  let videe = false;
  try {
    if (fs.existsSync(SESSION_PATH)) {
      for (const nom of fs.readdirSync(SESSION_PATH)) {
        try {
          fs.rmSync(path.join(SESSION_PATH, nom), { recursive: true, force: true });
          supprimes += 1;
        } catch {
          // Un fichier verrouillé isolé ne doit pas interrompre le nettoyage
          // des autres : c'est `creds.json` qui compte, et il partira.
        }
      }
      logger.info(`🗑️ Session locale vidée (${supprimes} entrée(s))`);
      videe = true;
    } else {
      videe = true; // rien à vider : le résultat voulu est déjà atteint
    }
  } catch (err) {
    logger.warn("Impossible de vider la session locale", { err: err.message });
  }
  // Supprime en base
  try {
    await prisma.whatsAppSession.deleteMany({ where: { id: "main" } });
    // Oublier l'empreinte est indispensable : sans ça, si la session
    // reconstruite se trouvait identique à l'ancienne, la garde
    // anti-réécriture sauterait la sauvegarde et la ligne, qu'on vient de
    // supprimer, ne serait jamais recréée.
    _derniereEmpreinte = null;
    logger.info("🗑️ Session Supabase supprimée");
  } catch {}

  return { videe };
}

// ── Init Baileys ──────────────────────────────────────────────────────────────
async function initWhatsApp() {
  try {
    // 1. Tente de charger la session existante depuis Supabase
    await loadSessionFromDb();

    // 2. Crée le dossier /tmp/whatsapp-session si absent
    if (!fs.existsSync(SESSION_PATH)) {
      fs.mkdirSync(SESSION_PATH, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    logger.info(`🔧 Baileys version WA : ${version.join(".")}`);

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require("pino")({ level: "silent" }),
      browser: ["MTECHBENIN", "Chrome", "1.0.0"],
      connectTimeoutMs: 60_000,
      retryRequestDelayMs: 2_000,
      keepAliveIntervalMs: 30_000,
      markOnlineOnConnect: true,
    });

    // ── Sauvegarde les credentials — locale immédiate, Supabase throttlée ──────
    // creds.update peut s'exécuter des centaines de fois par heure (1 par message
    // envoyé/reçu + rotations de clés). Écrire en Supabase à chaque fois génère
    // des GB d'egress. On throttle à 1 écriture DB max toutes les 30 secondes.
    sock.ev.on("creds.update", async () => {
      await saveCreds(); // sauvegarde locale dans /tmp — toujours immédiate
      scheduleSaveSession(); // sauvegarde Supabase — throttlée 30s
    });

    // ── Connexion / Déconnexion ───────────────────────────────────────────────
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        global.lastQR = qr;
        logger.info(
          "📱 Nouveau QR généré — accessible via /api/whatsapp/qr/scan",
        );
        try {
          const qrText = await QRCode.toString(qr, {
            type: "terminal",
            small: true,
          });
          console.log(qrText);
        } catch {}
      }

      if (connection === "open") {
        isReady = true;
        global.lastQR = null;
        _deconnecteDepuis = null;
        // La panne n'est pas finie parce qu'une connexion s'ouvre : elle est
        // finie quand la connexion TIENT. On rearme donc en differe, et la
        // deconnexion suivante annule ce minuteur — une session qui bat la
        // chamade ne rearme jamais rien.
        clearTimeout(_minuteurRearmement);
        _minuteurRearmement = setTimeout(() => {
          _alerteDeconnexionEnvoyee = false;
          logger.info("Connexion WhatsApp stable — alerte de session rearmee");
        }, STABILITE_AVANT_REARMEMENT_MS);
        if (typeof _minuteurRearmement.unref === "function") _minuteurRearmement.unref();
        logger.info("✅ WhatsApp connecté et prêt !");
        // Sauvegarde immédiate après connexion réussie
        await saveSessionToDb();
      }

      if (connection === "close") {
        isReady = false;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn("⚠️ WhatsApp déconnecté", { statusCode, shouldReconnect });
        if (!_deconnecteDepuis) _deconnecteDepuis = Date.now();
        // La connexion n'aura pas tenu : on annule le rearmement programme.
        clearTimeout(_minuteurRearmement);

        if (shouldReconnect) {
          const delay = statusCode === 408 ? 10_000 : 5_000;
          logger.info(
            `🔄 Reconnexion dans ${delay / 1000}s... (code ${statusCode})`,
          );
          setTimeout(() => initWhatsApp(), delay);
        } else {
          logger.info(
            "🗑️ Session expirée (loggedOut) — suppression et nouveau QR...",
          );
          // Cas sans retour possible : aucune reconnexion automatique ne
          // rattrapera une session deconnectee cote telephone. Il FAUT un
          // humain devant un QR, donc on le previent tout de suite.
          await alerterSessionPerdue(
            "WhatsApp deconnecte — un nouveau QR doit etre scanne",
            "La session WhatsApp a ete fermee (deconnexion depuis le telephone " +
              "ou expiration). Elle a ete supprimee et ne se retablira pas seule.",
          );
          const { videe } = await destroyAndClean();
          // Le delai depend de ce que le nettoyage a REELLEMENT pu faire.
          //
          // Nettoyage reussi : il ne reste aucun identifiant, la relance
          // affiche donc un QR et s'y arrete. Rien a marteler — on redemarre
          // vite pour que le QR soit disponible sans faire attendre.
          //
          // Nettoyage echoue : Baileys relirait les memes identifiants
          // revoques et recevrait un nouveau 401. C'est exactement la boucle
          // qui a tourne 590 fois par heure pendant des jours. On espace.
          const delai = videe ? 10_000 : DELAI_APRES_DECONNEXION_MS;
          logger.info(
            `🔄 Nouvelle session dans ${delai / 1000}s (nettoyage ${videe ? "réussi" : "ÉCHOUÉ"})`,
          );
          setTimeout(() => initWhatsApp(), delai);
        }
      }
    });

    // ── Messages entrants ─────────────────────────────────────────────────
    // Trois filtres, et chacun évite une nuisance réelle :
    //   • `fromMe` : sans lui, le bot réagit à ses propres envois et se
    //     répond en boucle.
    //   • les groupes (`@g.us`) : le numéro de la boutique en fréquente, et
    //     un bot qui parle dans un groupe est intrusif.
    //   • le mot-clé, vérifié plus loin par le gestionnaire : ce numéro sert
    //     au service client, le bot doit rester muet sur les conversations.
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" || !gestionnaireMessages) return;

      for (const msg of messages) {
        try {
          const jidBrut = msg.key?.remoteJid;
          if (!jidBrut || msg.key?.fromMe) continue;
          if (jidBrut.endsWith("@g.us")) continue;

          // Une seule ligne, au PREMIER message reçu après démarrage : elle
          // dit à l'exploitant laquelle des deux formes d'adressage arrive
          // réellement sur la session de production. Sans elle, un routage
          // muet par LID est indistinguable d'un client qui n'écrit pas.
          if (!adressageJournalise) {
            adressageJournalise = true;
            logger.info("Adressage WhatsApp constaté sur cette session", {
              addressingMode: msg.key?.addressingMode ?? "(absent)",
              forme: jidBrut.endsWith("@lid") ? "lid" : "jid",
              remoteJidAlt: msg.key?.remoteJidAlt ? "présent" : "absent",
            });
          }

          // Les messages rejoués à la reconnexion arrivent eux aussi en
          // `type: "notify"`. Voir whatsappMessage.js pour la tolérance.
          if (messageTropAncien(msg.messageTimestamp)) {
            logger.info("Message entrant arriéré ignoré (rejoué à la reconnexion)", {
              forme: jidBrut.endsWith("@lid") ? "lid" : "jid",
            });
            continue;
          }

          // `adresse` sert à répondre, `numero` à rapprocher des occupations :
          // sur un `@lid` ce ne sont PAS les mêmes chiffres.
          const adressage = extraireAdressage(msg.key);
          if (!adressage) {
            logger.warn(
              "Message entrant sans numéro exploitable (identifiant masqué sans remoteJidAlt) — sans réponse",
            );
            continue;
          }

          const texte =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "";
          if (!texte) continue;

          await gestionnaireMessages({
            adresse: adressage.adresse,
            numero: adressage.numero,
            texte,
          });
        } catch (err) {
          // Un message mal formé ne doit jamais interrompre la boucle ni
          // faire tomber la session.
          logger.warn("Erreur traitement message entrant", { err: err.message });
        }
      }
    });

    return sock;
  } catch (err) {
    logger.error("Erreur init WhatsApp Baileys", { err: err.message });
    setTimeout(() => initWhatsApp(), 10_000);
  }
}

module.exports = {
  initWhatsApp,
  getClient,
  isConnected,
  destroyAndClean,
  flushSessionSave,
  setGestionnaireMessages,
};
