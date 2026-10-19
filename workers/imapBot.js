// ─────────────────────────────────────────────────────────────────────────────
// BOT IMAP — surveille une ou plusieurs boîtes mail et redistribue les codes OTP
// des services de streaming aux clients qui ont réellement payé.
//
// Configuration (voir .env.example) :
//   IMAP_ACCOUNTS = JSON, plusieurs boîtes  ← recommandé
//   IMAP_EMAIL / IMAP_PASSWORD             ← ancienne config mono-boîte (toujours acceptée)
//
// La logique de routage (à qui envoyer) vit dans ./otpRouting.js.
// ─────────────────────────────────────────────────────────────────────────────

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const logger = require("../src/utils/logger");
const prisma = require("../src/services/prisma");
const whatsapp = require("../src/services/whatsapp");
const emailSvc = require("../src/services/email");
const {
  stripHtml,
  decideEnvoi,
  resolveTargetOrder,
  auditAccountCoverage,
  computeExpiry,
  estCourrielRecent,
  choisirDestinataire,
  envoyerCopieCadeau,
  loadServices,
} = require("./otpRouting");
const { classerCourriel } = require("./otpClassement");
const { cleCourriel, revendiquerCourriel, consignerCourriel } = require("./otpJournal");
const { reconcileSubscriptionOrders, reconcileIfStale } = require("./orderReconciler");
const { memeNumero } = require("../src/modules/subscriptions/demandeCode");
const { estAVie } = require("../src/modules/subscriptions/duree");

// Âge maximal d'un courriel encore digne d'être traité.
//
// `search({ seen: false })` sans borne remonte TOUT l'arriéré non lu d'une
// boîte. En ajoutant deux boîtes jamais surveillées à IMAP_ACCOUNTS, le bot a
// rejoué leur historique et expédié cinq codes périmés à deux clients.
//
// Une heure est large : un code de vérification vit quelques minutes. La
// fenêtre couvre donc un redéploiement ou une courte panne sans jamais
// ressusciter un code mort.
const FENETRE_FRAICHEUR_MS = Number(process.env.IMAP_FENETRE_MS) || 60 * 60 * 1000;
const {
  demandeOuverteDesComptes,
  marquerServie,
} = require("../src/modules/subscriptions/demandeCodeStore");

// ── Configuration des boîtes ─────────────────────────────────────────────────
function guessHost(email) {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (domain.includes("gmail") || domain.includes("googlemail")) return "imap.gmail.com";
  if (/(outlook|hotmail|live|msn)\./.test(domain + ".")) return "outlook.office365.com";
  if (domain.includes("yahoo")) return "imap.mail.yahoo.com";
  if (domain.includes("icloud") || domain === "me.com") return "imap.mail.me.com";
  return process.env.IMAP_HOST || "imap.gmail.com";
}

// Retire les guillemets qui entourent parfois la valeur. Dans un shell ou un
// fichier `.env`, on écrit `IMAP_ACCOUNTS='[...]'` et les apostrophes ne font
// pas partie de la valeur. Collées telles quelles dans l'interface de Render,
// elles en font partie — et `JSON.parse` échoue dès le premier caractère.
function retirerGuillemetsEnglobants(valeur) {
  const v = valeur.trim();
  const premier = v[0];
  if ((premier === "'" || premier === '"') && v.endsWith(premier)) {
    const interieur = v.slice(1, -1).trim();
    // On ne déballe que si le contenu ressemble à du JSON : sinon on risquerait
    // d'abîmer une valeur légitimement entre guillemets.
    if (interieur.startsWith("[") || interieur.startsWith("{")) return interieur;
  }
  return v;
}

// Interrupteur global : `IMAP_TEST_ONLY=true` bascule TOUTES les boîtes en
// mode test, quelle que soit la façon dont elles sont déclarées.
//
// Avant, cette variable n'agissait que sur l'ancienne configuration mono-boîte
// (`IMAP_EMAIL`/`IMAP_PASSWORD`). Un déploiement listant ses boîtes dans
// `IMAP_ACCOUNTS` — le cas courant — la posait à `true` en croyant tout
// neutraliser, et continuait pourtant à envoyer de vrais codes à de vrais
// clients. Le geste attendu quand on écrit « mode test » est global : il l'est
// désormais.
//
// Le réglage par boîte (`"testOnly": true` dans une entrée de `IMAP_ACCOUNTS`)
// reste disponible pour n'en neutraliser qu'une seule.
function modeTestGlobal() {
  return String(process.env.IMAP_TEST_ONLY || "").trim().toLowerCase() === "true";
}

function parseAccounts() {
  const accounts = [];
  const testPartout = modeTestGlobal();

  // Format multi-boîtes : IMAP_ACCOUNTS=[{"user":"a@gmail.com","pass":"xxx"}, …]
  const raw = process.env.IMAP_ACCOUNTS;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(retirerGuillemetsEnglobants(raw));
      if (!Array.isArray(parsed)) throw new Error("IMAP_ACCOUNTS doit être un tableau JSON");
      for (const entry of parsed) {
        const user = (entry.user || entry.email || "").trim();
        const pass = entry.pass || entry.password || "";
        if (!user || !pass) {
          logger.warn("📬 Entrée IMAP_ACCOUNTS ignorée — user ou pass manquant", { user });
          continue;
        }
        accounts.push({
          user,
          pass,
          host: entry.host || guessHost(user),
          port: Number(entry.port) || 993,
          label: entry.label || user,
          // Boîte de test : le routage est calculé et rapporté à l'admin, mais
          // aucun message ne part vers un client. Évite qu'un mail de test
          // déclenche un vrai envoi (les services link_access se résolvent par
          // service, donc sans lien avec la boîte d'origine).
          testOnly: testPartout || entry.testOnly === true || entry.test === true,
        });
      }
    } catch (err) {
      // Surtout ne pas journaliser `raw` ni le message brut de JSON.parse :
      // celui-ci recopie le début de la valeur, qui contient des mots de passe
      // d'application. On ne donne que de quoi situer l'erreur.
      const debut = retirerGuillemetsEnglobants(raw)[0] || "";
      logger.error(
        "📬 IMAP_ACCOUNTS illisible — la valeur doit être un tableau JSON sur une seule ligne, commençant par « [ » et sans guillemets autour",
        {
          commencePar: debut === "[" ? "[ (correct)" : `« ${debut} »`,
          longueur: raw.length,
        },
      );
    }
  }

  // Ancienne config mono-boîte — conservée pour ne pas casser un déploiement
  // existant, et fusionnée si elle désigne une boîte pas déjà listée.
  const legacyUser = (process.env.IMAP_EMAIL || "").trim();
  const legacyPass = process.env.IMAP_PASSWORD || "";
  if (legacyUser && legacyPass) {
    const already = accounts.some(
      (a) => a.user.toLowerCase() === legacyUser.toLowerCase(),
    );
    if (!already) {
      accounts.push({
        user: legacyUser,
        pass: legacyPass,
        host: process.env.IMAP_HOST || guessHost(legacyUser),
        port: Number(process.env.IMAP_PORT) || 993,
        label: legacyUser,
        testOnly: testPartout,
      });
    }
  }

  return accounts;
}

// ── Extraction des destinataires ─────────────────────────────────────────────
// Utile quand une boîte reçoit par renvoi : l'adresse du compte streaming est
// alors dans To/Delivered-To, pas dans le compte IMAP connecté.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Deux familles d'adresses, qui ne pesent pas pareil (refonte du 13/10/2026) :
//   • ECRITES — celles que le service a mises dans le message (To, Cc,
//     X-Original-To). Elles seules disent a quel foyer appartient le code.
//   • TRANSPORT — Bcc, Delivered-To, X-Forwarded-To, Envelope-To : par ou le
//     mail est arrive (renvoi, alias). Repli seulement.
function collectRecipients(parsed) {
  const ecrites = [];
  const transport = [];
  const adressesDe = (champ) => {
    if (champ?.value?.length) return champ.value.map((v) => v.address).filter(Boolean);
    if (champ?.text) return String(champ.text).match(EMAIL_RE) || [];
    return [];
  };
  for (const champ of [parsed.to, parsed.cc]) ecrites.push(...adressesDe(champ));
  transport.push(...adressesDe(parsed.bcc));

  const headers = parsed.headers;
  if (headers?.get) {
    const lire = (cle) => {
      const valeur = headers.get(cle);
      if (!valeur) return [];
      return (Array.isArray(valeur) ? valeur : [valeur]).flatMap(
        (v) => String(typeof v === "string" ? v : v?.text || "").match(EMAIL_RE) || [],
      );
    };
    ecrites.push(...lire("x-original-to"));
    for (const cle of ["delivered-to", "x-forwarded-to", "envelope-to"]) transport.push(...lire(cle));
  }
  return { ecrites: [...new Set(ecrites)], transport: [...new Set(transport)] };
}

// Le resultat DKIM/DMARC inscrit par le serveur de reception (Gmail) : le
// PREMIER en-tete `Authentication-Results`, celui du haut. Un faussaire peut en
// glisser un dans son mail, mais il se retrouve plus bas — c'est pourquoi on
// lit `headerLines`, qui garde l'ordre reel du mail, et pas une Map.
function enteteAuthentification(parsed) {
  // Sans en-tetes ordonnes, aucun repli : une Map ne dit pas lequel est celui
  // du serveur de reception. Le mail est alors traite comme non verifie.
  const ligne = (parsed.headerLines || []).find((h) => h.key === "authentication-results");
  return ligne ? String(ligne.line).replace(/^authentication-results:\s*/i, "") : "";
}

// L'expediteur, seulement s'il est UNIQUE : un seul en-tete From, une seule
// adresse. Avec deux, Gmail peut avoir verifie la signature sur l'un pendant que
// l'analyseur lit l'autre. Rend aussi l'adresse lue, pour reconnaitre nos
// propres mails, et `fiable` qui dit si la signature peut lui etre attribuee.
function expediteurDuMail(parsed) {
  const adresses = (parsed.from?.value || []).map((v) => v.address).filter(Boolean);
  const lignesFrom = (parsed.headerLines || []).filter((h) => h.key === "from").length;
  return {
    adresse: adresses[0] || "",
    fiable: adresses.length === 1 && lignesFrom <= 1,
  };
}

// ── Alertes admin ────────────────────────────────────────────────────────────
// Toutes les alertes de ce bot passaient par le seul canal WhatsApp. Quand la
// session Baileys tombe — ce qui arrive, et sans prévenir — l'admin cesse de
// recevoir les codes orphelins, ambigus ou non délivrés : le bot continue de
// lire les mails, mais plus personne ne le sait. C'est exactement ce qui a
// donné l'impression d'un bot mort pendant trois semaines.
//
// L'e-mail sert donc de repli : il ne part que si WhatsApp a échoué, pour ne
// pas doubler chaque alerte quand tout va bien.
// Alertes de CONFIGURATION deja envoyees, et quand.
//
// Certaines alertes se repetent a l'identique a chaque code recu : « aucun
// compte ne porte cette adresse », « plusieurs comptes correspondent ». Elles
// ne portent aucune information nouvelle d'une fois sur l'autre — c'est le
// meme reglage a corriger — mais elles arrivaient une par code. Sur deux jours
// de session WhatsApp tombee, ou TOUTES les alertes basculent sur l'e-mail,
// cela remplit une boite.
//
// En memoire volontairement : au redemarrage, l'exploitant merite d'etre
// prevenu a nouveau. Le but est d'espacer, pas de faire taire.
const _alertesConfigEnvoyees = new Map();
const FENETRE_ALERTE_CONFIG_MS = 60 * 60 * 1000;

// `cle` : uniquement pour les alertes de configuration, celles qui se repetent
// a l'identique. Une alerte qui porte un CODE que l'administrateur doit
// transmettre a la main n'en prend jamais — la faire taire ferait perdre le
// code, et le client attendrait pour rien.
async function notifyAdmin(message, sujet = "Alerte bot OTP", { cle } = {}) {
  if (cle) {
    const dernier = _alertesConfigEnvoyees.get(cle);
    if (dernier && Date.now() - dernier < FENETRE_ALERTE_CONFIG_MS) {
      logger.info("Alerte de configuration deja signalee recemment — non repetee", {
        cle,
        sujet,
      });
      return true;
    }
    _alertesConfigEnvoyees.set(cle, Date.now());
  }

  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;

  let envoyeWhatsapp = false;
  if (vendorPhone) {
    try {
      envoyeWhatsapp = await whatsapp.sendMessage(vendorPhone, message);
    } catch (err) {
      logger.error("Échec notification admin OTP", { err: err.message });
    }
  }
  if (envoyeWhatsapp) return true;

  try {
    const envoyeEmail = await emailSvc.sendAdminAlert({ sujet, message });
    if (envoyeEmail) {
      logger.info("Alerte admin repliée sur l'e-mail (WhatsApp indisponible)", { sujet });
      return true;
    }
  } catch (err) {
    logger.error("Repli e-mail de l'alerte admin échoué", { err: err.message });
  }

  logger.error("Alerte admin non délivrée — WhatsApp et e-mail en échec", { sujet });
  return false;
}

async function alertOrphanOTP({ otp, serviceLabel, mailbox, reason }) {
  await notifyAdmin(
    [
      `⚠️ *OTP reçu — aucun destinataire*`,
      ``,
      `Service : ${serviceLabel || "inconnu"}`,
      `Boîte : ${mailbox}`,
      `Code : *${otp}*`,
      ``,
      `Raison : ${reason}`,
      ``,
      `À transférer manuellement si besoin.`,
    ].join("\n"),
    `OTP ${serviceLabel || ""} sans destinataire`,
  );
}

// ── Verrou par commande ──────────────────────────────────────────────────────
// Les boîtes sont surveillées en parallèle dans le même process. Deux codes
// arrivant au même instant dans deux boîtes peuvent viser la même commande :
// sans verrou, les deux passent le contrôle « a déjà reçu son OTP » avant que
// l'un ait écrit son log, et partent tous les deux — la règle « un seul OTP par
// commande » serait contournée. On sérialise la section critique par commande.
const _orderLocks = new Map();

async function withOrderLock(orderId, fn) {
  while (_orderLocks.has(orderId)) {
    await _orderLocks.get(orderId);
  }
  // Pas d'await entre le test et la pose du verrou : en JS mono-thread, aucune
  // autre continuation ne peut s'intercaler ici.
  let release;
  const lock = new Promise((resolve) => {
    release = resolve;
  });
  _orderLocks.set(orderId, lock);
  try {
    return await fn();
  } finally {
    _orderLocks.delete(orderId);
    release();
  }
}

// Domaines dont les mails viennent de la plateforme elle-meme : l'expediteur
// reellement utilise par email.js, et le domaine de production en garde-fou
// (une variable mal reglee ne doit pas rouvrir la boucle).
const DOMAINES_INTERNES = [
  ...new Set(
    [String(emailSvc.getFrom?.() || "").match(/@([a-z0-9.-]+)/i)?.[1], "mtechbenin.com"]
      .filter(Boolean)
      .map((d) => d.toLowerCase()),
  ),
];

// ── Traitement d'un email ────────────────────────────────────────────────────
async function processEmail(parsed, mailboxEmail, { testOnly = false } = {}) {
  try {
    const from = parsed.from?.text || "";
    const subject = parsed.subject || "";
    const body = parsed.text || (parsed.html ? stripHtml(parsed.html) : "");

    // ── 1. Classement : de qui, de quoi, quel code (refonte du 13/10/2026) ──
    // Tout se joue dans `classerCourriel` (workers/otpClassement.js), pur et
    // teste sur les vrais mails Netflix : service lu dans le DOMAINE OFFICIEL
    // de l'expediteur, jamais dans l'objet ; code jamais lu dans un lien ni un
    // identifiant ; codes de gestion du compte reserves a l'administrateur.
    const { adresse: expediteur, fiable: expediteurFiable } = expediteurDuMail(parsed);
    const tousServices = await loadServices();
    const classement = classerCourriel({
      expediteur,
      sujet: subject,
      texte: body,
      // Expediteur ambigu : aucune signature ne peut lui etre attribuee.
      authentification: expediteurFiable ? enteteAuthentification(parsed) : "",
      services: tousServices,
      domainesInternes: DOMAINES_INTERNES,
    });

    if (classement.verdict === "interne" || classement.verdict === "hors-service") {
      logger.info(
        classement.verdict === "interne"
          ? "Courriel emis par la plateforme elle-meme — ignore"
          : "Email non pertinent — ignoré",
        { mailbox: mailboxEmail, subject, from },
      );
      return;
    }

    const services = classement.services;
    const serviceLabel =
      services.map((s) => s.name).join(" / ") ||
      (classement.servicesNommes || []).map((s) => s.name).join(" / ") ||
      "inconnu";
    const otp = classement.code;
    const destinataires = collectRecipients(parsed);

    // ── 2. Revendication : un mail n'est traite qu'une fois ─────────────────
    // La ligne de journal est creee AVANT tout envoi, sur le Message-ID (cle
    // unique en base). Un mail present dans deux boites, ou pris par deux
    // passes concurrentes, s'arrete ici la seconde fois.
    const ligne = await revendiquerCourriel({
      messageId: cleCourriel({
        messageId: parsed.messageId,
        expediteur,
        date: parsed.date,
        sujet: subject,
        code: otp,
      }),
      boite: mailboxEmail,
      adresseEcrite: destinataires.ecrites[0] || null,
      expediteur: String(expediteur || "").slice(0, 200),
      sujet: subject.slice(0, 300),
      service: serviceLabel,
      type: classement.type || classement.verdict,
      code: otp,
      recuLe: parsed.date instanceof Date ? parsed.date : null,
    });
    if (ligne === null) {
      logger.info("Courriel deja traite — ignore", { mailbox: mailboxEmail, subject });
      return;
    }

    if (classement.verdict === "information") {
      logger.info("Email de service sans code a transmettre — ignoré", {
        mailbox: mailboxEmail,
        service: serviceLabel,
        subject,
      });
      await consignerCourriel(ligne, {
        decision: "ignore",
        raison: "information (aucun code a transmettre)",
      });
      return;
    }

    // ── Codes et liens qui n'appartiennent qu'a l'administrateur ─────────────
    // Un code de GESTION modifie le compte lui-meme (paiement, e-mail, mot de
    // passe) : remis a un client, il lui donnerait la main sur le compte. Le
    // 12/10, celui d'une modification des informations du compte B etait
    // parti chez un client.
    if (classement.verdict === "gestion") {
      logger.info("Code de gestion du compte — transmis a l'admin seul", {
        mailbox: mailboxEmail,
        service: serviceLabel,
      });
      await notifyAdmin(
        [
          `🔑 *Code de gestion du compte ${serviceLabel}*`,
          ``,
          `Boîte : ${mailboxEmail}`,
          `Objet : ${subject}`,
          `Code : *${otp || "illisible — voir la boîte"}*`,
          ``,
          `Ce code modifie le compte lui-même (paiement, e-mail, mot de passe…).`,
          `Il n'est transmis à AUCUN client. Si vous n'êtes pas à l'origine de`,
          `cette demande, quelqu'un tente de modifier le compte.`,
        ].join("\n"),
        `Code de gestion du compte ${serviceLabel}`,
      );
      await consignerCourriel(ligne, { decision: "admin", raison: "code de gestion du compte" });
      return;
    }

    // Une demande d'identification PAR LIEN ne porte aucun code : le 07/10, le
    // bot en avait tire un faux code et l'avait envoye a un client.
    if (classement.verdict === "lien") {
      logger.info("Demande d'identification par lien — transmise a l'admin", {
        mailbox: mailboxEmail,
        service: serviceLabel,
      });
      await notifyAdmin(
        [
          `🔗 *Demande d'identification ${serviceLabel} — par lien*`,
          ``,
          `Boîte : ${mailboxEmail}`,
          `Un appareil demande à se connecter et attend une approbation.`,
          classement.lien
            ? `Approuver : ${classement.lien}`
            : `Lien d'approbation introuvable dans le mail — ouvrez la boîte.`,
          ``,
          `Le lien expire vite. Approuvez si la demande vient bien d'un client.`,
        ].join("\n"),
        `Demande d'identification ${serviceLabel}`,
      );
      await consignerCourriel(ligne, {
        decision: "admin",
        raison: "demande d'identification par lien",
      });
      return;
    }

    // Un objet qui nomme un service, avec un code, mais un expediteur qui n'est
    // pas ce service (renvoi manuel ?) : jamais transmis a un client.
    if (classement.verdict === "non-verifie") {
      logger.warn("Code d'un expediteur non verifie — non transmis", {
        mailbox: mailboxEmail,
        from,
        subject,
      });
      await notifyAdmin(
        [
          `⚠️ *Code reçu d'un expéditeur non vérifié*`,
          ``,
          `Boîte : ${mailboxEmail}`,
          `Expéditeur : ${expediteur}`,
          `Objet : ${subject}`,
          `Code : *${otp}*`,
          ``,
          `L'objet nomme ${serviceLabel}, mais le mail ne vient pas de ce service`,
          `(renvoi manuel, ou tentative de tromperie). Il n'a été transmis à`,
          `personne. Transmettez-le vous-même si vous savez d'où il vient.`,
        ].join("\n"),
        `Code non vérifié (${serviceLabel})`,
        { cle: `non-verifie:${String(expediteur).toLowerCase()}` },
      );
      await consignerCourriel(ligne, { decision: "admin", raison: "expediteur non verifie" });
      return;
    }

    logger.info(`🔐 OTP ${otp} détecté`, {
      mailbox: mailboxEmail,
      service: serviceLabel,
      type: classement.type,
      subject,
    });

    // ── 3. À qui appartient ce code ? ────────────────────────────────────────
    // Rattrape d'abord un éventuel achat panier pas encore converti : sans ça,
    // un client qui vient de payer serait considéré comme inexistant et son
    // code partirait au précédent acheteur. Throttlé : inutile de rescanner
    // tout l'historique à chaque email.
    await reconcileIfStale();

    const resolution = await resolveTargetOrder({
      mailboxEmail,
      recipientEmails: destinataires.transport,
      adressesEcrites: destinataires.ecrites,
      services,
    });

    // Un compte trouvé mais dont la décision reste à trancher (aucun ou
    // plusieurs occupants actifs) n'a ni `order` ni `reason` : ce n'est pas un
    // cas orphelin, c'est `decideEnvoi` qui doit se prononcer ci-dessous. Seule
    // la présence de `reason` signale un rapprochement réellement impossible.
    if (resolution.reason) {
      // Un refus ATTENDU n'est pas un incident : l'administrateur a coupe le
      // transfert pour ce service, et ces codes lui appartiennent. On le trace
      // — il doit rester possible de verifier qu'un code est bien arrive et
      // qu'on a choisi de ne pas le relayer — mais sans alerte.
      if (resolution.attendu) {
        logger.info(`Code non transmis — ${resolution.reason}`, {
          mailbox: mailboxEmail,
          service: serviceLabel,
        });
        await consignerCourriel(ligne, { decision: "ignore", raison: resolution.reason });
        return;
      }

      logger.warn(`⚠️ OTP orphelin — ${resolution.reason}`, {
        mailbox: mailboxEmail,
        service: serviceLabel,
      });
      await alertOrphanOTP({
        otp,
        serviceLabel,
        mailbox: mailboxEmail,
        reason: resolution.reason,
      });
      await consignerCourriel(ligne, { decision: "admin", raison: resolution.reason });
      return;
    }

    // Plus de fusion de comptes depuis la refonte du 13/10/2026 : quand deux
    // comptes sont possibles, `resolveTargetOrder` refuse (raison ci-dessus)
    // au lieu de reunir leurs occupations. `rapprochePar` dit si le compte a
    // ete designe par l'adresse ecrite par le service, ou par la boite.
    const { order, scope, candidates, compte, comptes, occupationsActives, rapprochePar } =
      resolution;
    if (order) {
      // `computeExpiry` calcule une date, et n'a donc pas de garde « a vie » :
      // c'est `isOrderActive` qui la porte. Appelee telle quelle sur un
      // abonnement sans terme — qui n'a volontairement pas d'`expiresAt` — elle
      // retomberait sur `plan.duration` et le journal annoncerait une echeance
      // fabriquee sur un acces vendu comme definitif.
      let expiryLabel = estAVie(order.plan) ? "sans échéance (à vie)" : "date inconnue";
      try {
        if (!estAVie(order.plan)) {
          expiryLabel = computeExpiry(order).toISOString().slice(0, 10);
        }
      } catch {
        // Les commandes issues d'une occupation (compte famille) ne portent
        // que `expiresAt`, pas `plan`/`amount`/`createdAt` : si `expiresAt`
        // manque sur une commande ancienne, le calcul de repli n'a pas de quoi
        // travailler. Un libellé approximatif ici ne bloque que le journal, pas
        // l'envoi.
      }
      logger.info(
        `🎯 Destinataire résolu (${scope}) : ${order.clientName} (${order.clientWhatsapp}) — ` +
          `commande ${order.id}, valide jusqu'au ${expiryLabel}`,
      );
    } else {
      logger.info(
        `🎯 Compte résolu (${scope}) — ${occupationsActives?.length ?? 0} occupant(s) actif(s), décision à trancher`,
      );
    }

    // Une demande ouverte sur ces comptes désigne le destinataire sans
    // ambiguïté. En portée `service` (link_access) il n'y a pas de compte,
    // donc pas de demande à chercher.
    //
    // L'appel est encadré, et ce n'est pas de la prudence de principe. Les
    // mails sont marqués `\Seen` EN BLOC avant traitement (voir
    // `processUnseen`) : celui-ci ne sera jamais relu. Si la table `OtpRequest`
    // manque parce que la migration a échoué — `appliquerMigrations` continue
    // sciemment — ou si la base hoquette sur cet appel précis, le `catch`
    // global de `processEmail` se contenterait de journaliser, et chaque code
    // du compte serait perdu sans que personne l'apprenne, là où le code de
    // l'étape 1 serait parti normalement. On dégrade donc vers ce comportement
    // d'étape 1 : sans demande, la décision revient à `decideEnvoi`, qui
    // alertera l'admin plutôt que de perdre le code.
    const idsComptes = (comptes || (compte ? [compte] : [])).map((c) => c.id);
    let demandeOuverte = null;
    if (idsComptes.length > 0) {
      try {
        demandeOuverte = await demandeOuverteDesComptes(idsComptes);
      } catch (err) {
        logger.warn(
          "Lecture des demandes de code indisponible — routage sans demande",
          { mailbox: mailboxEmail, service: serviceLabel, err: err.message },
        );
      }
    }

    // ── Le rapprochement est-il certain, ou deviné ? ─────────────────────────
    // Toute la règle vit dans `decideEnvoi` (workers/otpRouting.js), qui est
    // pure et testée. Elle refuse de trancher uniquement là où l'admin peut
    // vraiment corriger : les services famille.
    const decision = decideEnvoi({
      categorieService: compte ? "family" : order.service?.category,
      // Sans le scope, un service famille rapproche par SERVICE (boite non
      // declaree) repondait « aucun-occupant » : la resolution ne porte alors
      // aucune occupation, et le repli sur le dernier acheteur n'avait aucune
      // chance de s'appliquer.
      scope,
      occupationsActives,
      candidats: candidates,
      demandeOuverte,
    });

    // Pour un service famille, c'est l'occupation retenue qui désigne la
    // commande destinataire — pas celle devinée en amont.
    if (!decision.envoyer) {
      // « aucun-occupant » est un cas distinct de « ambigu » : il n'y a pas
      // trop de candidats, il n'y en a aucun. Ça arrive tant que la reprise de
      // données (scripts/migrate-comptes-occupations.js) n'a pas tourné, ou
      // tant qu'un client payé n'a pas encore été rattaché à un profil depuis
      // le panel — c'est-à-dire précisément dans la fenêtre qui suit un
      // déploiement, quand l'info est la plus utile. L'ancien message
      // affichait « 0 occupant(s) actif(s) » suivi d'une liste vide : aucune
      // piste pour transmettre le code à la main. On nomme la vraie cause et
      // on liste, à titre indicatif SEULEMENT, les commandes payées actives
      // sur ce service — sans jamais choisir de destinataire ni envoyer quoi
      // que ce soit : deviner le destinataire est le principe qu'on refuse de
      // rompre, occupation absente ou pas.
      if (decision.raison === "aucun-occupant") {
        logger.error(
          `⚠️ OTP non transmis (aucune occupation enregistrée) sur ${serviceLabel}`,
          { mailbox: mailboxEmail, service: serviceLabel },
        );

        // `compte` n'est PAS toujours défini ici : "aucun-occupant" remonte
        // aussi par le chemin `scope: "service"` de `resolveTargetOrder`, pris
        // quand le service n'a AUCUN `StreamingAccount` du tout (aucune boîte
        // ne peut donc matcher — le cas même où la reprise de données n'a
        // jamais tourné). Sur ce chemin, `resolution` ne porte pas `compte`,
        // seulement `order` (le dernier acheteur actif du service). On
        // retombe donc sur l'identifiant de service porté par la commande —
        // jamais sur un accès direct à `compte.serviceId`, qui lèverait.
        const serviceIdPourAlerte = compte?.serviceId ?? order?.serviceId ?? null;

        let commandesPayees = [];
        if (serviceIdPourAlerte) {
          try {
            commandesPayees = await prisma.subscriptionOrder.findMany({
              where: { serviceId: serviceIdPourAlerte, status: "CONFIRMED" },
              select: { clientName: true, clientWhatsapp: true },
              orderBy: { createdAt: "desc" },
              take: 6,
            });
          } catch (err) {
            logger.warn("Liste des commandes candidates indisponible", { err: err.message });
          }
        } else {
          // N'arrive normalement jamais (voir énumération ci-dessus), mais on
          // ne laisse pas planter l'alerte pour autant : elle part quand même,
          // simplement sans liste indicative.
          logger.warn("Service introuvable pour lister les commandes candidates", {
            mailbox: mailboxEmail,
            service: serviceLabel,
          });
        }

        await notifyAdmin(
          [
            `⚠️ *Code non transmis — aucune occupation enregistrée*`,
            ``,
            `Boîte : ${mailboxEmail}`,
            `Service : ${serviceLabel}`,
            `Code : *${otp}*`,
            ``,
            `Aucune occupation n'est enregistrée pour ce compte. Ce n'est pas`,
            `une ambiguïté (trop de candidats) mais une absence de données :`,
            `soit la reprise de données n'a pas encore tourné, soit aucun`,
            `client n'a encore été rattaché à un profil.`,
            ``,
            `À faire : lancer « node scripts/migrate-comptes-occupations.js`,
            `--appliquer », ou rattacher les clients à leur profil depuis le`,
            `panel.`,
            ``,
            commandesPayees.length > 0
              ? `Commandes payées actives sur ce service (indicatif — à vérifier` +
                ` avant tout envoi manuel) :`
              : `Aucune commande payée trouvée pour ce service.`,
            ...commandesPayees.map((o) => `• ${o.clientName} — ${o.clientWhatsapp}`),
          ].join("\n"),
          `Code ${serviceLabel} non transmis — aucune occupation enregistrée`,
        );
        await consignerCourriel(ligne, { decision: "admin", raison: "aucun client enregistre sur ce compte" });
        return;
      }

      logger.error(
        `⚠️ OTP non transmis (${decision.raison}) — ${decision.occupantsActifs} occupant(s) actif(s) sur ${serviceLabel}`,
        { mailbox: mailboxEmail, service: serviceLabel, occupantsActifs: decision.occupantsActifs },
      );

      // Sans cette liste, l'alerte est inexploitable : l'administrateur lit
      // « 3 candidats » et n'a personne a qui transmettre.
      //
      // Les occupations n'existent QUE sur le chemin « par compte ». Sur un
      // service link_access, ou quand aucun compte ne porte l'adresse, la
      // resolution ne remonte que des COMMANDES — et l'alerte affichait alors
      // un compte a rebours suivi du vide. On prend donc ce qu'on a, dans cet
      // ordre.
      const candidatsLisibles =
        occupationsActives?.length > 0
          ? occupationsActives
              .slice(0, 6)
              .map((o) => `• ${o.occupantName} — ${o.occupantWhatsapp} (profil ${o.profile.profile})`)
          : (candidates || [])
              .slice(0, 6)
              .map((o) => `• ${o.clientName} — ${o.clientWhatsapp}`);

      await notifyAdmin(
        [
          `⚠️ *Code non transmis — destinataire incertain*`,
          ``,
          `Boîte : ${mailboxEmail}`,
          `Service : ${serviceLabel}`,
          `Code : *${otp}*`,
          ``,
          `${decision.occupantsActifs} client(s) actif(s) en lice :`,
          ...(candidatsLisibles.length > 0
            ? candidatsLisibles
            : [`(liste indisponible — voir le panel)`]),
          ``,
          `Le code n'est parti chez personne : rien dans le message ne dit`,
          `lequel s'est connecté, et l'envoyer au hasard donnerait à un client`,
          `le code d'un autre — inutilisable pour lui, et perdu pour le vrai`,
          `demandeur, un code de foyer ne servant qu'une fois.`,
          ``,
          `Transmettez-le au bon client. Pour que les prochains partent seuls :`,
          `demandez à vos clients d'annoncer leur code depuis « Mon code », ou`,
          `rattachez chaque profil à son acheteur dans le panel.`,
        ].join("\n"),
        `Code ${serviceLabel} non transmis — destinataire incertain`,
      );
      await consignerCourriel(ligne, { decision: "admin", raison: `destinataire incertain (${decision.raison})` });
      return;
    }

    // Calcule APRES le garde-fou ci-dessus, et c'est tout l'objet du correctif :
    // il etait calcule avant, si bien qu'un code arrivant sans occupation NI
    // commande faisait lire `.clientWhatsapp` sur `null` et plantait le
    // traitement — juste avant le bloc qui savait pourtant traiter ce cas
    // proprement. Le mail etait deja marque \Seen : le code etait perdu.
    //
    // Reste avant la previsualisation du mode test, plus bas, pour que le
    // rapport et l'envoi reel designent la meme personne.
    const cible = choisirDestinataire(decision, order);
    if (!cible) {
      logger.error(
        "Envoi decide mais aucune commande cible — code non transmis",
        { mailbox: mailboxEmail, service: serviceLabel, raison: decision.raison },
      );
      await consignerCourriel(ligne, { decision: "echec", raison: "aucune commande cible" });
      return;
    }
    const { commandeCible, destinataire } = cible;


    // ── Mode test : on rapporte le routage sans rien envoyer au client ───────
    if (testOnly) {
      logger.info(
        `🧪 [TEST] Aucun envoi client — le code ${otp} serait allé à ` +
          `${destinataire.nom} (${destinataire.whatsapp})`,
      );
      await notifyAdmin(
        [
          `🧪 *Test bot OTP — aucun envoi client*`,
          ``,
          `Boîte : ${mailboxEmail}`,
          `Service : ${serviceLabel}`,
          `Code : *${otp}*`,
          ``,
          `Destinataire qui aurait reçu le code :`,
          `👤 ${destinataire.nom} — ${destinataire.whatsapp}`,
          // `memeNumero` et pas `!==` : les deux valeurs viennent de saisies
          // distinctes (l'occupation, la commande). Comparées en chaînes
          // brutes, deux écritures du MÊME numéro font apparaître un occupant
          // comme « acheteur distinct » de lui-même.
          ...(memeNumero(destinataire.whatsapp, commandeCible.clientWhatsapp)
            ? []
            : [`🛒 Acheteur : ${commandeCible.clientName} — ${commandeCible.clientWhatsapp}`]),
          `Rapprochement : ${scope === "account" ? "par compte (précis)" : "par service"}`,
          // En portee compte, `candidates` n'existe pas : c'est le nombre
          // d'occupations actives qui fait foi. Lire `candidates` ici
          // retombait toujours sur 1 et affichait une valeur fausse.
          `Clients actifs sur ce compte : ${
            resolution.occupationsActives?.length ?? candidates?.length ?? 1
          }`,
        ].join("\n"),
        `Test bot OTP ${serviceLabel}`,
      );
      await consignerCourriel(ligne, {
        decision: "ignore",
        raison: `mode test — serait parti chez ${destinataire.nom}`,
        destinataire: destinataire.nom,
        commandeId: commandeCible.id,
      });
      return;
    }

    // ── Section critique : contrôles + envoi + journalisation ────────────────
    // Sérialisée par commande pour qu'un second code visant la même commande ne
    // puisse pas passer les contrôles pendant que celui-ci est en cours d'envoi.
    // Porte sur `commandeCible` : pour un service famille, c'est l'occupation
    // retenue par `decideEnvoi` qui désigne la commande, pas celle devinée par
    // `resolveTargetOrder` en amont.
    await withOrderLock(commandeCible.id, async () => {
    // ── 4. Idempotence — ce code a-t-il déjà été traité pour cette commande ? ─
    // Évite de re-notifier l'admin si le même email est relu (redémarrage,
    // poll de rattrapage…).
    const alreadySeen = await prisma.oTPLog.findFirst({
      where: { orderId: commandeCible.id, otpCode: otp },
      select: { id: true },
    });
    if (alreadySeen) {
      logger.info(`OTP ${otp} déjà traité pour la commande ${commandeCible.id} — ignoré`);
      await consignerCourriel(ligne, {
        decision: "ignore",
        raison: "deja transmis a ce client",
        destinataire: destinataire.nom,
        commandeId: commandeCible.id,
      });
      return;
    }

    // ── 5. Envoi ─────────────────────────────────────────────────────────────
    //
    // Aucun quota par commande, volontairement. Une regle « un code par
    // abonnement, a vie » a existe ici a deux reprises : elle suppose qu'un
    // abonne n'a besoin d'un code qu'une fois. C'est faux — Netflix redemande
    // une verification de foyer a chaque nouvelle connexion, et un code perdu
    // (WhatsApp tombe, numero mal saisi) n'a alors plus aucun recours.
    //
    // En pratique chaque client recevait son premier code puis restait coupe
    // pour le reste de sa formule, tous les suivants finissant en
    // `imap-blocked`. Tant que la commande est payee et valide, son titulaire
    // recoit ses codes.
    const svcName = commandeCible.service?.name || serviceLabel;

    // `destinataire` a déjà été calculé plus haut (avant le mode test), pour
    // que la prévisualisation et l'envoi réel désignent la même personne.
    let waSent = false;
    if (destinataire.whatsapp) {
      waSent = await whatsapp.sendOTPToClient({
        clientWhatsapp: destinataire.whatsapp,
        clientName: destinataire.nom,
        serviceName: svcName,
        otpCode: otp,
      });
    }

    // Commande offerte : le destinataire du cadeau reçoit aussi le code.
    // Ne s'applique plus quand une occupation existe : l'occupant a déjà reçu
    // le code ci-dessus (c'est lui le destinataire du cadeau le cas échéant),
    // et un code de foyer est à usage unique — l'envoyer aussi à l'acheteur
    // donnerait à deux personnes un code dont un seul peut se servir.
    if (
      envoyerCopieCadeau({
        occupation: decision.occupation,
        isGift: commandeCible.isGift,
        giftWhatsapp: commandeCible.giftWhatsapp,
        destinataireWhatsapp: destinataire.whatsapp,
      })
    ) {
      const giftSent = await whatsapp.sendOTPToClient({
        clientWhatsapp: commandeCible.giftWhatsapp,
        clientName: commandeCible.giftName || commandeCible.clientName,
        serviceName: svcName,
        otpCode: otp,
      });
      waSent = waSent || giftSent;
      logger.info(`📨 OTP cadeau → ${commandeCible.giftWhatsapp} (${giftSent ? "OK" : "échec"})`);
    }

    // `emailSent` était posé à `true` dès que l'appel revenait sans exception.
    // Or `sendOTPToClient` n'en lève jamais : ce drapeau valait donc « vrai »
    // pour toute commande ayant une adresse, même quand Resend avait refusé le
    // message. Il est remonté à l'admin dans la notification ci-dessous et
    // sert à juger si le client a bien reçu son code — un faux positif laisse
    // un client sans code et l'admin persuadé du contraire. On lit désormais
    // le retour réel de la fonction.
    let emailSent = false;
    if (commandeCible.clientEmail) {
      try {
        emailSent = await emailSvc.sendOTPToClient({
          clientEmail: commandeCible.clientEmail,
          clientName: commandeCible.clientName,
          serviceName: svcName,
          otpCode: otp,
        });
      } catch (err) {
        logger.error("Échec envoi email OTP client", { err: err.message });
      }
      if (!emailSent) {
        logger.warn("OTP non délivré par e-mail", {
          to: commandeCible.clientEmail,
          service: svcName,
        });
      }
    }

    // ── 6. Journalisation ────────────────────────────────────────────────────
    // Écrit AVANT les notifications admin : si la notif échoue, le code reste
    // bien marqué comme délivré et ne partira pas une seconde fois.
    const journal = await prisma.oTPLog.create({
      data: {
        orderId: commandeCible.id,
        otpCode: otp,
        source: "imap",
        sentViaWhatsapp: waSent,
        sentViaEmail: emailSent,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await consignerCourriel(ligne, {
      decision: waSent || emailSent ? "envoye" : "echec",
      raison:
        `${decision.raison}` +
        (rapprochePar === "boite" ? " — compte designe par la boite (adresse ecrite inconnue)" : "") +
        (waSent || emailSent ? "" : " — WhatsApp et e-mail en echec"),
      destinataire: destinataire.nom,
      commandeId: commandeCible.id,
    });

    // La demande est close dès que le code est parti, pour qu'elle ne capte
    // pas aussi le suivant. On la clôt même si l'envoi a échoué : le code a
    // été consommé côté plateforme de toute façon, et une demande qui
    // survivrait à un échec capterait le code d'un autre client.
    if (decision.demandeId) {
      await marquerServie(decision.demandeId, journal?.id ?? null).catch((err) =>
        logger.warn("Cloture de la demande de code echouee", { err: err.message }),
      );
    }

    // ── 7. Notifications admin ───────────────────────────────────────────────
    // Tout ce qui suit doit nommer le destinataire RÉEL du code (`destinataire`,
    // calculé section 5 — l'occupant quand une occupation existe, l'acheteur
    // sinon). Un journal qui montre l'acheteur pour un code effectivement
    // reçu par l'occupant d'un cadeau induirait l'admin en erreur exactement
    // dans le cas qui appelle le plus une trace fiable : un litige « je n'ai
    // pas reçu mon code ». `commandeCible.clientName`/`clientWhatsapp` (qui
    // paie) sont transmis à part, sous `buyerName`/`buyerWhatsapp`, pour que
    // les deux gabarits les affichent explicitement quand ils diffèrent —
    // jamais en silence à la place l'un de l'autre.
    await whatsapp
      .sendOTPNotifToAdmin({
        otp,
        serviceName: svcName,
        clientName: destinataire.nom,
        clientWhatsapp: destinataire.whatsapp,
        waSent,
        emailSent,
        buyerName: commandeCible.clientName,
        buyerWhatsapp: commandeCible.clientWhatsapp,
      })
      .catch((err) => logger.warn("Notif admin WhatsApp échouée", { err: err.message }));

    await emailSvc
      .sendOTPNotifToAdmin({
        otp,
        serviceName: svcName,
        clientName: destinataire.nom,
        clientEmail: commandeCible.clientEmail,
        clientWhatsapp: destinataire.whatsapp,
        waSent,
        emailSent,
        buyerName: commandeCible.clientName,
        buyerWhatsapp: commandeCible.clientWhatsapp,
      })
      .catch((err) => logger.warn("Notif admin email échouée", { err: err.message }));

    // ── L'incident reste visible même quand le code est parti ───────────────
    //
    // Une demande ouverte depuis le formulaire public a servi un compte à
    // plusieurs occupants actifs. Le formulaire n'établit aucune identité : on
    // y déclare un numéro. Sans demande ouverte, `decideEnvoi` aurait répondu
    // « ambigu » et l'admin aurait été alerté — l'incident était visible et
    // rattrapable. Avec une demande ouverte, le code part et, sans cette
    // alerte, plus personne n'apprend rien : le sabotage deviendrait
    // silencieux. On ne bloque pas l'envoi pour autant (le client légitime ne
    // doit pas être puni parce qu'un tiers a pu saisir son numéro), on le
    // signale.
    if (decision.alerteAmbiguite) {
      logger.warn(
        `⚠️ Code envoyé (${decision.raison}) pour un compte à ${decision.occupantsActifs} occupants`,
        {
          mailbox: mailboxEmail,
          service: svcName,
          recipient: destinataire.whatsapp,
          occupantsActifs: decision.occupantsActifs,
        },
      );
      // Deux causes distinctes aboutissent ici, et le message doit dire
      // laquelle — sinon l'admin cherche un formulaire là où personne n'a rien
      // demandé.
      const surDemandeWeb = decision.raison === "demande-ouverte";
      await notifyAdmin(
        [
          surDemandeWeb
            ? `⚠️ *Code envoyé sur demande web — compte partagé*`
            : `⚠️ *Code envoyé au dernier acheteur — compte partagé*`,
          ``,
          `Boîte : ${mailboxEmail}`,
          `Compte : ${(comptes || []).map((c) => c.email).join(", ") || compte?.email || "—"}`,
          `Service : ${svcName}`,
          `Code : *${otp}*`,
          ``,
          `Destinataire retenu : ${destinataire.nom} — ${destinataire.whatsapp}`,
          `Occupants actifs sur ce compte : ${decision.occupantsActifs}`,
          ``,
          ...(surDemandeWeb
            ? [
                `La demande vient du formulaire public (/mon-code), qui ne vérifie`,
                `aucune identité. Si ce code était attendu par un AUTRE occupant,`,
                `renvoyez-le-lui et surveillez ce compte.`,
              ]
            : [
                `Personne n'avait demandé de code : le destinataire a été choisi`,
                `parce qu'il a acheté le plus récemment. Si ce code était attendu`,
                `par un AUTRE occupant, renvoyez-le-lui.`,
              ]),
        ].join("\n"),
        surDemandeWeb
          ? `Code ${svcName} envoyé sur demande web — compte partagé`
          : `Code ${svcName} envoyé au dernier acheteur — compte partagé`,
      );
    }

    if (!waSent && !emailSent) {
      logger.error(`❌ OTP ${otp} non délivré (WhatsApp et email en échec)`, {
        orderId: commandeCible.id,
        recipient: destinataire.whatsapp,
      });
      await notifyAdmin(
        [
          `❌ *OTP non délivré*`,
          ``,
          `Service : ${svcName}`,
          `Code : *${otp}*`,
          `Destinataire : ${destinataire.nom} — ${destinataire.whatsapp}`,
          // Même raison que dans le bloc mode test ci-dessus.
          ...(memeNumero(destinataire.whatsapp, commandeCible.clientWhatsapp)
            ? []
            : [`Acheteur : ${commandeCible.clientName} — ${commandeCible.clientWhatsapp}`]),
          ``,
          `WhatsApp et email ont échoué. À transmettre manuellement.`,
        ].join("\n"),
        `OTP ${svcName} non délivré`,
      );
    } else {
      logger.info(`✅ OTP ${otp} délivré — WA: ${waSent}, Email: ${emailSent}`, {
        recipient: destinataire.whatsapp,
        buyerWhatsapp: commandeCible.clientWhatsapp,
        orderId: commandeCible.id,
      });
    }
    }); // fin de la section critique verrouillée par commande
  } catch (err) {
    logger.error("Erreur traitement email", { mailbox: mailboxEmail, err: err.message });
  }
}

// ── État courant des boîtes ──────────────────────────────────────────────────
// Sans ce registre, rien ne permet de savoir depuis l'extérieur si une boîte
// est réellement connectée : il fallait ouvrir les journaux Render après chaque
// déploiement. Ne contient jamais de mot de passe.
const etatBoites = new Map();

function noterEtat(user, champs) {
  etatBoites.set(user, { ...(etatBoites.get(user) || {}), ...champs });
}

function getBotStatus() {
  return [...etatBoites.values()];
}

// ── Surveillance d'une boîte ─────────────────────────────────────────────────
// Chaque compte tourne dans sa propre boucle indépendante : la panne ou la
// reconnexion d'une boîte n'interrompt jamais les autres.
function watchAccount(account) {
  const tag = account.label;
  let reconnectDelay = 5000;
  const MAX_RECONNECT_DELAY = 60000;
  // imapflow a un socket timeout interne fixé à 5 min (SOCKET_TIMEOUT).
  // Si IDLE reste silencieux plus de 5 min sans paquet TCP, le socket expire.
  // On rafraîchit l'IDLE toutes les 4 min pour rester sous ce seuil.
  const IDLE_REFRESH_MS = 4 * 60 * 1000;
  // Polling fallback : filet de sécurité si un EXISTS est manqué
  const POLL_INTERVAL_MS = 4 * 60 * 1000;

  async function run() {
    const client = new ImapFlow({
      host: account.host,
      port: account.port,
      secure: true,
      auth: { user: account.user, pass: account.pass },
      logger: false,
      connectionTimeout: 15000,
      // On gère l'IDLE manuellement — désactive l'autoidle imapflow (15s après commande)
      disableAutoIdle: true,
    });

    // ── Mutex : interdit deux processings simultanés ───────────────────────
    let isProcessing = false;
    let pendingProcess = false;

    async function processUnseen() {
      if (!client.usable) return;

      if (isProcessing) {
        pendingProcess = true;
        return;
      }
      isProcessing = true;
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          // search() retourne des numéros de séquence.
          //
          // `since` dégrossit côté serveur, mais ne suffit PAS : la clé SINCE
          // d'IMAP est à granularité JOURNALIÈRE (RFC 3501). Elle ramène donc
          // tout le jour courant, pas la dernière heure. Le tri fin se fait
          // sur la date de chaque message, plus bas.
          const depuis = new Date(Date.now() - FENETRE_FRAICHEUR_MS);
          const seqs = await client.search({ seen: false, since: depuis });
          if (seqs.length > 0) {
            logger.info(`📬 [${tag}] ${seqs.length} email(s) non lu(s) à traiter`);

            // fetchAll() charge tout en mémoire AVANT tout STORE.
            // Exécuter messageFlagsAdd() à l'intérieur d'un for-await fetch()
            // envoie un STORE pendant que FETCH est actif : le serveur renvoie
            // un FETCH untagged pour la mise à jour des flags, ce qui coupe
            // prématurément le flux — les sources ne sont jamais lues.
            const messages = await client.fetchAll(seqs, { source: true });

            // Marquer TOUT en vu en un seul STORE (avant traitement)
            await client.messageFlagsAdd(seqs, ["\\Seen"]);

            let perimes = 0;
            for (const msg of messages) {
              const parsed = await simpleParser(msg.source);

              // Les messages restent marqués \Seen quoi qu'il arrive : un
              // courriel périmé ne doit pas être reconsidéré au prochain tour.
              if (!estCourrielRecent(parsed.date, Date.now(), FENETRE_FRAICHEUR_MS)) {
                perimes += 1;
                continue;
              }

              await processEmail(parsed, account.user, { testOnly: account.testOnly });
            }
            if (perimes > 0) {
              logger.info(
                `🕰️  [${tag}] ${perimes} email(s) trop ancien(s) — ignoré(s) sans envoi`,
              );
            }
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        logger.error(`Erreur lecture emails IMAP [${tag}]`, { err: err.message });
      } finally {
        isProcessing = false;
        if (pendingProcess) {
          pendingProcess = false;
          setImmediate(processUnseen);
        }
      }
    }

    // ── Brise l'IDLE via noop() — imapflow appelle preCheck() avant toute commande,
    //    ce qui envoie automatiquement DONE au serveur et sort de l'IDLE proprement
    async function breakIdle() {
      if (!client.usable) return;
      if (client.idling) {
        try { await client.noop(); } catch {}
      }
    }

    let pollTimer = null;

    try {
      await client.connect();
      reconnectDelay = 5000; // Reset backoff après connexion réussie
      logger.info(`✅ [${tag}] IMAP connecté — surveillance active`);
      noterEtat(account.user, {
        connecte: true,
        connecteDepuis: new Date().toISOString(),
        derniereErreur: null,
      });

      // ── Gestion erreurs socket (ETIMEOUT, ECONNRESET…) ───────────────────
      // Sans ce listener, Node.js crash sur un événement 'error' non écouté.
      // Le socket timeout imapflow (5 min) déclenche ETIMEOUT si l'IDLE reste
      // silencieux trop longtemps — le reconnect gère la suite.
      client.on("error", (err) => {
        logger.warn(`Erreur socket IMAP [${tag}]`, { code: err.code, err: err.message });
        // client.usable passe à false → la boucle while sort → reconnect
      });

      // ── Traite les emails non lus présents au démarrage ───────────────────
      await processUnseen();

      // ── Nouveau email en temps réel (EXISTS de IMAP) ──────────────────────
      // noop() déclenche preCheck() → DONE → IDLE se termine → la boucle while reprend
      client.on("exists", async ({ count, prevCount }) => {
        if (count > (prevCount ?? 0)) {
          logger.info(`📬 [${tag}] EXISTS — ${count - (prevCount ?? 0)} nouveau(x) email(s)`);
          await breakIdle();
        }
      });

      // ── Polling fallback ─────────────────────────────────────────────────
      // Filet de sécurité si un EXISTS est manqué (coupure réseau courte, etc.)
      pollTimer = setInterval(async () => {
        if (!client.usable) return;
        if (client.idling) {
          await breakIdle(); // Sortira d'IDLE → while loop appellera processUnseen
        } else {
          await processUnseen(); // Pas en IDLE (traitement en cours) — poll direct
        }
      }, POLL_INTERVAL_MS);

      // ── Boucle IDLE avec rafraîchissement automatique ────────────────────
      // idle(IDLE_REFRESH_MS) gère le keepalive en interne : à chaque expiration
      // il envoie DONE + redémarre IDLE (boucle interne imapflow).
      // La promesse idle() ne se résout QUE si quelque chose d'externe brise l'IDLE
      // (notre noop() via exists/poll, ou déconnexion).
      while (client.usable) {
        try {
          await client.idle(IDLE_REFRESH_MS);
        } catch (err) {
          if (client.usable) {
            logger.warn(`IDLE interrompu [${tag}]`, { err: err.message });
          }
          break;
        }
        // Sortie d'IDLE : traite les éventuels nouveaux emails
        await processUnseen();
      }
    } catch (err) {
      logger.error(`Erreur connexion IMAP [${tag}]`, { err: err.message });
      // imapflow renvoie « Command failed » aussi bien pour un mot de passe
      // refusé que pour un incident réseau. Il marque cependant les échecs
      // d'authentification, ce qui permet de nommer la cause la plus fréquente :
      // un mot de passe d'application absent, expiré ou mal recopié.
      noterEtat(account.user, {
        connecte: false,
        derniereErreur: err.authenticationFailed
          ? "Authentification refusée — vérifier le mot de passe d'application"
          : err.message,
        derniereErreurLe: new Date().toISOString(),
      });
    } finally {
      if (pollTimer) clearInterval(pollTimer);
      try { await client.logout(); } catch {}
    }

    // ── Reconnexion avec backoff exponentiel ──────────────────────────────
    logger.info(`🔄 [${tag}] Reconnexion IMAP dans ${reconnectDelay / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    run(); // Relance sans bloquer
  }

  run().catch((err) =>
    logger.error(`Erreur fatale BOT IMAP [${tag}]`, { err: err.message }),
  );
}

// ── Démarrage ────────────────────────────────────────────────────────────────
async function startImapBot() {
  const accounts = parseAccounts();

  if (accounts.length === 0) {
    logger.warn(
      "📬 IMAP non configuré — BOT OTP désactivé (renseigner IMAP_ACCOUNTS ou IMAP_EMAIL/IMAP_PASSWORD)",
    );
    return;
  }

  logger.info(
    `📬 BOT IMAP démarré — ${accounts.length} boîte(s) surveillée(s) : ` +
      accounts.map((a) => a.user + (a.testOnly ? " (TEST)" : "")).join(", "),
  );

  // Un mode test s'oublie : allumé, plus aucun client ne reçoit son code et
  // rien ne le signale à part cette ligne ; éteint alors qu'on le croyait
  // actif, un essai part à un vrai client. On l'annonce donc franchement dans
  // les deux sens, à chaque démarrage.
  if (modeTestGlobal()) {
    logger.warn(
      "🧪 IMAP_TEST_ONLY=true — MODE TEST GLOBAL : aucun code ne sera envoyé aux clients. " +
        "Les codes sont rapportés à l'admin sur WhatsApp. Retirez la variable pour reprendre les envois.",
    );
  } else {
    const enTest = accounts.filter((a) => a.testOnly).map((a) => a.user);
    if (enTest.length > 0) {
      logger.warn(
        `🧪 Mode test sur ${enTest.length} boîte(s) — aucun envoi client depuis : ${enTest.join(", ")}`,
      );
    }
  }

  // Registre renseigné avant toute tentative de connexion : une boîte
  // configurée mais injoignable doit apparaître comme telle, pas manquer.
  for (const a of accounts) {
    noterEtat(a.user, {
      boite: a.user,
      hote: a.host,
      port: a.port,
      testUniquement: a.testOnly,
      connecte: false,
      derniereErreur: null,
    });
  }

  // ── Réconciliation initiale : rend visibles au bot tous les abonnements
  // achetés via le panier (notamment les link_access, jamais convertis avant).
  try {
    const stats = await reconcileSubscriptionOrders();
    if (stats.created || stats.linked) {
      logger.info(
        `🔗 Réconciliation commandes : ${stats.created} abonnement(s) reconstruit(s), ` +
          `${stats.linked} rattaché(s) à leur commande panier` +
          (stats.errors ? `, ${stats.errors} en erreur` : ""),
      );
    }
  } catch (err) {
    logger.warn("Réconciliation initiale des commandes échouée", { err: err.message });
  }

  // ── Diagnostic : comptes famille dont la boîte n'est surveillée par personne.
  // Leurs OTP n'arriveraient jamais (faute de frappe dans l'admin, boîte non
  // ajoutée à la config…) — mieux vaut le voir au démarrage qu'en production.
  try {
    const uncovered = await auditAccountCoverage(accounts.map((a) => a.user));
    if (uncovered.length > 0) {
      logger.warn(
        `⚠️  ${uncovered.length} adresse(s) de compte famille ne sont surveillées par aucune boîte IMAP — ` +
          `leurs OTP ne seront jamais reçus :`,
      );
      for (const u of uncovered) {
        logger.warn(`   • ${u.email} — ${u.accounts} compte(s) [${u.services}]`);
      }

      // Pas d'e-mail ici, volontairement : ce diagnostic se déclenche à CHAQUE
      // démarrage, et le garde-fou anti-répétition de notifyAdmin vit en mémoire
      // du processus — il repart donc à zéro à chaque redéploiement. Avec le
      // déploiement continu, cela produisait un courriel par déploiement pour
      // une situation déjà connue de l'exploitant.
      //
      // Le journal ci-dessus suffit : on le consulte au démarrage, qui est
      // précisément le moment où l'on agit sur la configuration IMAP.
    }
  } catch (err) {
    logger.warn("Diagnostic couverture des comptes impossible", { err: err.message });
  }

  for (const account of accounts) {
    watchAccount(account);
  }
}

module.exports = { startImapBot, processEmail, parseAccounts, getBotStatus };
