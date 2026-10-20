
const {
  Boom,
} = require("@hapi/boom");
const QRCode = require("qrcode");
const logger = require("../utils/logger");
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const {
  extraireAdressage,
  messageTropAncien,
} = require("./whatsappMessage");
const {
  fichiersElaguables,
  intervalleElagageMs,
} = require("./whatsappElagage");
const emailSvc = require("./email");

// Baileys est un module ES Module.
// import() permet de le charger depuis ce fichier CommonJS.
let baileysPromise = null;

function getBaileys() {
  if (!baileysPromise) {
    baileysPromise = import("@whiskeysockets/baileys");
  }
  return baileysPromise;
}

const prisma = new PrismaClient();

const SESSION_PATH =
  process.env.WHATSAPP_SESSION_PATH ||
  path.join("/tmp", "whatsapp-session");

let sock = null;

let _alerteDeconnexionEnvoyee = false;
let _deconnecteDepuis = null;
let _derniereAlerteSession = 0;
let _minuteurRearmement = null;

const INTERVALLE_MIN_ALERTE_MS = 60 * 60 * 1000;
const STABILITE_AVANT_REARMEMENT_MS = 5 * 60 * 1000;

let isReady = false;
let _saveTimer = null;
let _derniereEmpreinte = null;
let gestionnaireMessages = null;
let adressageJournalise = false;

function setGestionnaireMessages(fn) {
  gestionnaireMessages = fn;
}

function scheduleSaveSession() {
  if (_saveTimer) return;

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

async function flushSessionSave() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }

  await saveSessionToDb();
}

const _fichiersIllisiblesSignales = new Set();

async function saveSessionToDb() {
  try {
    if (!fs.existsSync(SESSION_PATH)) return;

    const files = fs.readdirSync(SESSION_PATH);
    const data = {};
    const nouveauxIllisibles = [];

    for (const file of files) {
      const filePath = path.join(SESSION_PATH, file);
      const content = fs.readFileSync(filePath, "utf-8");

      try {
        data[file] = JSON.parse(content);
      } catch {
        if (!_fichiersIllisiblesSignales.has(file)) {
          nouveauxIllisibles.push(file);
        }
      }
    }

    if (nouveauxIllisibles.length > 0) {
      for (const f of nouveauxIllisibles) {
        _fichiersIllisiblesSignales.add(f);
      }

      logger.warn(
        `${nouveauxIllisibles.length} fichier(s) de session illisible(s) — ignorés`,
        { exemples: nouveauxIllisibles.slice(0, 3) }
      );
    }

    const creds = data["creds.json"];

    if (!creds || typeof creds !== "object") {
      logger.warn(
        "Session non sauvegardée : creds.json absent ou invalide"
      );
      return;
    }

    const empreinte = JSON.stringify(data);

    if (empreinte === _derniereEmpreinte) {
      return;
    }

    await prisma.whatsAppSession.upsert({
      where: { id: "main" },
      update: { data },
      create: { id: "main", data },
      select: { id: true },
    });

    _derniereEmpreinte = empreinte;

    logger.info(
      `Session WhatsApp sauvegardée dans Supabase (${Object.keys(data).length} fichiers, ` +
      `${(empreinte.length / 1048576).toFixed(1)} Mo)`
    );
  } catch (err) {
    logger.error("Erreur sauvegarde session Supabase", {
      err: err.message,
    });
  }
}

async function alerterSessionPerdue(titre, detail) {
  if (_alerteDeconnexionEnvoyee) return;

  const depuisDerniere = Date.now() - _derniereAlerteSession;

  if (
    _derniereAlerteSession &&
    depuisDerniere < INTERVALLE_MIN_ALERTE_MS
  ) {
    logger.warn(
      `Session WhatsApp toujours perdue — alerte non répétée`
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
        "Tant que la session n'est pas rétablie, le bot ne peut rien envoyer.",
        "",
        "Pour rétablir la connexion, ouvrez :",
        "/api/whatsapp/qr/scan?token=<QR_SECRET>",
        "puis scannez le QR depuis le téléphone de la boutique.",
      ].join("\n"),
    });

    if (envoye) {
      logger.info("Alerte e-mail envoyée : session WhatsApp perdue");
    } else {
      logger.error("Alerte session WhatsApp non délivrée");
    }
  } catch (err) {
    logger.error("Alerte session WhatsApp échouée", {
      err: err.message,
    });
  }
}

const DELAI_ALERTE_MS = 10 * 60 * 1000;
const DELAI_APRES_DECONNEXION_MS = 5 * 60 * 1000;

async function elaguerSession() {
  if (!isReady) return;
  if (!fs.existsSync(SESSION_PATH)) return;

  try {
    const cibles = fichiersElaguables(
      fs.readdirSync(SESSION_PATH)
    );

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
        // Le fichier a pu disparaître entre-temps.
      }
    }

    _derniereEmpreinte = null;
    await flushSessionSave();

    logger.info(
      `Session élaguée : ${supprimes} clé(s) retirée(s) ` +
      `(${(octets / 1048576).toFixed(2)} Mo)`
    );
  } catch (err) {
    logger.warn("Élagage de session impossible", {
      err: err.message,
    });
  }
}

const INTERVALLE_ELAGAGE_MS = intervalleElagageMs(
  process.env.WHATSAPP_ELAGAGE_HEURES
);

if (INTERVALLE_ELAGAGE_MS > 0) {
  const premierElagage = setTimeout(() => {
    elaguerSession();
  }, 5 * 60 * 1000);

  if (typeof premierElagage.unref === "function") {
    premierElagage.unref();
  }

  const elagage = setInterval(() => {
    elaguerSession();
  }, INTERVALLE_ELAGAGE_MS);

  if (typeof elagage.unref === "function") {
    elagage.unref();
  }

  logger.info(
    `Élagage de session actif — toutes les ${INTERVALLE_ELAGAGE_MS / 3600000} h`
  );
} else {
  logger.info("Élagage de session désactivé");
}

const veille = setInterval(() => {
  if (isReady || !_deconnecteDepuis) return;

  if (Date.now() - _deconnecteDepuis < DELAI_ALERTE_MS) {
    return;
  }

  alerterSessionPerdue(
    "WhatsApp injoignable depuis plus de 10 minutes",
    "La session ne s'est pas rétablie malgré les tentatives de reconnexion."
  );
}, 60 * 1000);

veille.unref();

async function loadSessionFromDb() {
  try {
    const record = await prisma.whatsAppSession.findUnique({
      where: { id: "main" },
    });

    if (!record) {
      logger.info("Aucune session en base — nouveau QR requis");
      return false;
    }

    const data = record.data || {};
    const octetsLus = JSON.stringify(data).length;
    const creds = data["creds.json"];

    if (!creds || typeof creds !== "object") {
      logger.warn(
        "Session en base inutilisable — suppression et nouveau QR"
      );

      await prisma.whatsAppSession.deleteMany({
        where: { id: "main" },
      });

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
        typeof content === "string"
          ? content
          : JSON.stringify(content),
        "utf-8"
      );
    }

    logger.info(
      `Session WhatsApp chargée depuis Supabase (${Object.keys(data).length} fichiers, ` +
      `${(octetsLus / 1048576).toFixed(1)} Mo lus)`
    );

    return true;
  } catch (err) {
    logger.error("Erreur chargement session Supabase", {
      err: err.message,
    });

    return false;
  }
}

async function destroyAndClean() {
  isReady = false;

  if (sock) {
    try {
      sock.end();
    } catch {
      // La fermeture peut déjà avoir eu lieu.
    }

    sock = null;
  }

  let supprimes = 0;
  let videe = false;

  try {
    if (fs.existsSync(SESSION_PATH)) {
      for (const nom of fs.readdirSync(SESSION_PATH)) {
        try {
          fs.rmSync(
            path.join(SESSION_PATH, nom),
            { recursive: true, force: true }
          );

          supprimes += 1;
        } catch {
          // Continuer le nettoyage des autres fichiers.
        }
      }

      logger.info(
        `Session locale vidée (${supprimes} entrée(s))`
      );

      videe = true;
    } else {
      videe = true;
    }
  } catch (err) {
    logger.warn("Impossible de vider la session locale", {
      err: err.message,
    });
  }

  try {
    await prisma.whatsAppSession.deleteMany({
      where: { id: "main" },
    });

    _derniereEmpreinte = null;
    logger.info("Session Supabase supprimée");
  } catch (err) {
    logger.warn("Suppression de session Supabase impossible", {
      err: err.message,
    });
  }

  return { videe };
}

async function initWhatsApp() {
  try {
    // CORRECTION : Baileys est chargé par import() dynamique.
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
    } = await getBaileys();

    await loadSessionFromDb();

    if (!fs.existsSync(SESSION_PATH)) {
      fs.mkdirSync(SESSION_PATH, { recursive: true });
    }

    const { state, saveCreds } =
      await useMultiFileAuthState(SESSION_PATH);

    const { version } = await fetchLatestBaileysVersion();

    logger.info(
      `Baileys version WA : ${version.join(".")}`
    );

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

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      scheduleSaveSession();
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        global.lastQR = qr;

        logger.info(
          "Nouveau QR généré — accessible via /api/whatsapp/qr/scan"
        );

        try {
          const qrText = await QRCode.toString(qr, {
            type: "terminal",
            small: true,
          });

          console.log(qrText);
        } catch (err) {
          logger.warn("Affichage du QR impossible", {
            err: err.message,
          });
        }
      }

      if (connection === "open") {
        isReady = true;
        global.lastQR = null;
        _deconnecteDepuis = null;

        clearTimeout(_minuteurRearmement);

        _minuteurRearmement = setTimeout(() => {
          _alerteDeconnexionEnvoyee = false;

          logger.info(
            "Connexion WhatsApp stable — alerte réarmée"
          );
        }, STABILITE_AVANT_REARMEMENT_MS);

        if (
          typeof _minuteurRearmement.unref === "function"
        ) {
          _minuteurRearmement.unref();
        }

        logger.info("WhatsApp connecté et prêt !");
        await saveSessionToDb();
      }

      if (connection === "close") {
        isReady = false;

        const statusCode =
          new Boom(lastDisconnect?.error).output?.statusCode;

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        logger.warn("WhatsApp déconnecté", {
          statusCode,
          shouldReconnect,
        });

        if (!_deconnecteDepuis) {
          _deconnecteDepuis = Date.now();
        }

        clearTimeout(_minuteurRearmement);

        if (shouldReconnect) {
          const delay = statusCode === 408 ? 10_000 : 5_000;

          logger.info(
            `Reconnexion dans ${delay / 1000}s... (code ${statusCode})`
          );

          setTimeout(() => {
            initWhatsApp();
          }, delay);
        } else {
          logger.info(
            "Session expirée — suppression et nouveau QR"
          );

          await alerterSessionPerdue(
            "WhatsApp déconnecté — un nouveau QR doit être scanné",
            "La session WhatsApp a été fermée ou révoquée."
          );

          const { videe } = await destroyAndClean();

          const delai = videe
            ? 10_000
            : DELAI_APRES_DECONNEXION_MS;

          logger.info(
            `Nouvelle session dans ${delai / 1000}s`
          );

          setTimeout(() => {
            initWhatsApp();
          }, delai);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" || !gestionnaireMessages) {
        return;
      }

      for (const msg of messages) {
        try {
          const jidBrut = msg.key?.remoteJid;

          if (!jidBrut || msg.key?.fromMe) continue;
          if (jidBrut.endsWith("@g.us")) continue;

          if (!adressageJournalise) {
            adressageJournalise = true;

            logger.info(
              "Adressage WhatsApp constaté sur cette session",
              {
                addressingMode:
                  msg.key?.addressingMode ?? "(absent)",
                forme: jidBrut.endsWith("@lid")
                  ? "lid"
                  : "jid",
                remoteJidAlt: msg.key?.remoteJidAlt
                  ? "présent"
                  : "absent",
              }
            );
          }

          if (messageTropAncien(msg.messageTimestamp)) {
            logger.info(
              "Message entrant ancien ignoré"
            );

            continue;
          }

          const adressage = extraireAdressage(msg.key);

          if (!adressage) {
            logger.warn(
              "Message entrant sans numéro exploitable"
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
          logger.warn(
            "Erreur traitement message entrant",
            { err: err.message }
          );
        }
      }
    });

    return sock;
  } catch (err) {
    logger.error("Erreur init WhatsApp Baileys", {
      err: err.message,
      stack: err.stack,
    });

    setTimeout(() => {
      initWhatsApp();
    }, 10_000);
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
