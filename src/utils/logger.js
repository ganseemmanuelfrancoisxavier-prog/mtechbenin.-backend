const winston = require("winston");
const fs = require("fs");
const path = require("path");

const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
          return `${timestamp} [${level}] ${message} ${metaStr}`;
        })
      ),
    }),
  ],
});

// ── Journal persistant, hors du conteneur ───────────────────────────────────
//
// Les journaux Docker vivent et meurent avec le conteneur : `compose up -d` le
// recree a chaque deploiement, et tout l'historique disparait.
//
// Ce n'est pas theorique. Une panne signalee comme survenant « a une certaine
// heure » n'a pas pu etre diagnostiquee : au moment de chercher, les traces de
// l'heure recherchee n'existaient plus — effacees par le deploiement fait pour
// corriger autre chose. Un journal qu'on perd en enquetant ne sert a rien.
//
// `LOG_DIR` pointe vers un volume monte. Absent, rien ne change : le
// developpement local et Render gardent la console seule.
const dossierJournaux = process.env.LOG_DIR;
if (dossierJournaux) {
  try {
    fs.mkdirSync(dossierJournaux, { recursive: true });
    logger.add(
      new winston.transports.File({
        filename: path.join(dossierJournaux, "app.log"),
        // Rotation par TAILLE, avec le transport livre par winston : pas de
        // dependance supplementaire pour une fonction de cette importance.
        // 20 Mo x 10 fichiers ≈ plusieurs semaines au rythme observe, et un
        // plafond dur qui ne peut pas remplir le disque du VPS — partage avec
        // le site d'un autre client.
        maxsize: 20 * 1024 * 1024,
        maxFiles: 10,
        tailable: true,
      }),
    );
    logger.info(`🗒️  Journal persistant : ${dossierJournaux}/app.log`);
  } catch (err) {
    // Un journal qui ne peut pas s'ecrire ne doit jamais empecher le
    // demarrage : la console reste.
    logger.warn("Journal persistant indisponible — console seule", {
      err: err.message,
    });
  }
}

module.exports = logger;
