require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const crypto = require("crypto");
const QRCode = require("qrcode");
const logger = require("./utils/logger");
const prisma = require("./services/prisma");

// Comparaison à temps constant pour les secrets en clair (ADMIN_API_KEY, QR_SECRET).
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Jeton QR valide ?
//
// `timingSafeEqualStr(undefined, undefined)` compare deux tampons VIDES et
// renvoie `true` : sans `QR_SECRET` configuré, une requête sans jeton passait
// donc le contrôle. N'importe qui pouvait alors afficher le QR d'appairage et
// lier son propre téléphone au compte WhatsApp de la boutique. On exige
// désormais que les deux valeurs existent réellement.
function jetonQrValide(jeton) {
  const secret = process.env.QR_SECRET;
  if (!secret || !jeton) return false;
  return timingSafeEqualStr(jeton, secret);
}
const { apiLimiter, qrLimiter } = require("./middleware/rateLimiter");
const { errorHandler } = require("./middleware/errorHandler");
const {
  initWhatsApp,
  isConnected,
  destroyAndClean,
  flushSessionSave,
  setGestionnaireMessages,
} = require("./services/whatsappClient");
const whatsapp = require("./services/whatsapp");
const { startImapBot, getBotStatus } = require("../workers/imapBot");
const { auditAccountCoverage } = require("../workers/otpRouting");
const { demarrerRappels } = require("../workers/subscriptionExpiry");
const { isAdmin } = require("./middleware/auth");

// Routes
const authRoutes = require("./modules/auth/auth.routes");
const ordersRoutes = require("./modules/orders/orders.routes");
const paymentsRoutes = require("./modules/payments/payments.routes");
const productsRoutes = require("./modules/products/products.routes");
const couponsRoutes = require("./modules/coupons/coupons.routes");
const reviewsRoutes = require("./modules/reviews/reviews.routes");
const clientsRoutes = require("./modules/clients/clients.routes");
const settingsRoutes = require("./modules/settings/settings.routes");
const subscriptionsRoutes = require("./modules/subscriptions/subscriptions.routes");
const repairsRoutes = require("./modules/repairs/repairs.routes");
const categoriesRoutes = require("./modules/categories/categories.routes");
const heroRoutes = require("./modules/hero/hero.routes");
const adsRoutes = require("./modules/ads/ads.routes");
const clientMediaRoutes = require("./modules/clientMedia/clientMedia.routes");
const uploadRoutes = require("./modules/upload/upload.routes");
const contactsRoutes = require("./modules/contacts/contacts.routes");
const faqRoutes = require("./modules/faq/faq.routes");
const legalRoutes = require("./modules/legal/legal.routes");
const characteristicRoutes = require("./modules/characteristics/characteristics.routes");
const statsRoutes = require("./modules/stats/stats.routes");

const app = express();
app.set("trust proxy", 1); // ← fix ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
const PORT = process.env.PORT || 3001;

// Interface d'ecoute. `0.0.0.0` par defaut : Render route le trafic vers le
// conteneur, le service DOIT donc ecouter sur toutes les interfaces.
//
// Sur un VPS, nginx est en frontal et parle au backend en local : mettre
// `HOST=127.0.0.1` referme le port 3001 sur la machine. Sans cela il reste
// joignable depuis l'exterieur, ce qui court-circuite le reverse proxy — donc
// HTTPS, la limitation de debit de nginx et les en-tetes de securite.
const HOST = process.env.HOST || "0.0.0.0";

// Origines autorisees a appeler l'API.
//
// La liste etait figee dans le code : l'URL du frontend et le localhost de
// developpement. Un domaine `www.`, un domaine d'API distinct ou une
// preproduction Vercel n'avaient aucun moyen d'etre autorises sans redeployer.
//
// `CORS_ORIGINS` les prend, separees par des virgules. Absente, on retombe
// EXACTEMENT sur l'ancien comportement — rien ne change pour le deploiement
// actuel.
const ORIGINES_AUTORISEES = (process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",")
  : [process.env.FRONTEND_URL || "http://localhost:3000", "http://localhost:3000"]
)
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: ORIGINES_AUTORISEES,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

// ── Rate limiter — AVANT les parsers de corps ─────────────────────────────────
// Placé ici volontairement : en aval des parsers, il ne protégeait pas du coût
// de bufferisation et de parsing, qui est justement la partie chère d'une
// requête volumineuse. Il ne lit que des en-têtes, jamais le corps, donc rien
// ne l'empêche de s'exécuter en premier.
// Le contournement reste limité à une clé admin valide.
app.use("/api", (req, res, next) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey && process.env.ADMIN_API_KEY && timingSafeEqualStr(adminKey, process.env.ADMIN_API_KEY)) {
    return next();
  }
  // Le poll QR n'est exempté de la limite générale que si le secret est valide.
  if (req.method === "GET" && (req.path === "/whatsapp/admin/qr" || (req.path === "/whatsapp/qr" && jetonQrValide(req.query.token)))) {
    return qrLimiter(req, res, next);
  }
  return apiLimiter(req, res, next);
});

// ── Body parsers — exclut /api/payments/webhook ───────────────────────────────
// La route webhook gère son propre express.raw() dans payments.routes.js
// Si express.json() parse le body avant, la signature FedaPay devient invalide
//
// Plafonds de charge utile : les médias transitent encodés en base64, ce qui
// gonfle la requête d'environ un tiers. Un plafond unique de 20 Mo ne laissait
// donc passer que des fichiers d'environ 15 Mo, alors que l'interface en
// annonçait 50. La route d'upload a son propre plafond, plus large, sans
// alourdir les autres routes.
const DEFAULT_BODY_LIMIT = "20mb";
const UPLOAD_BODY_LIMIT = "35mb"; // ≈ 25 Mo de fichier réel

// Le plafond large n'est concédé qu'à une requête portant une intention
// d'authentification. `isAdmin` ne s'exécute qu'au niveau de la route, donc
// après le parsing : sans cette condition, n'importe qui pouvait faire
// bufferiser et parser 35 Mo (soit environ 100 Mo en mémoire) avant de recevoir
// son 401. Une requête anonyme reste bornée au plafond ordinaire.
function porteUneIdentification(req) {
  return Boolean(req.headers["x-admin-key"] || req.headers.authorization);
}

app.use((req, res, next) => {
  if (req.originalUrl === "/api/payments/webhook") return next();
  const limit =
    req.originalUrl.startsWith("/api/upload") && porteUneIdentification(req)
      ? UPLOAD_BODY_LIMIT
      : DEFAULT_BODY_LIMIT;
  express.json({ limit })(req, res, next);
});
app.use((req, res, next) => {
  if (req.originalUrl === "/api/payments/webhook") return next();
  express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT })(req, res, next);
});

app.use(
  morgan("combined", { stream: { write: (msg) => logger.info(msg.trim()) } }),
);

// Deux chemins pour la MÊME sonde.
//
// `/health` est celui qu'interrogent Render et UptimeRobot depuis le début :
// le retirer casserait la surveillance en place.
//
// `/api/health` est celui qu'impose le socle du VPS : son script de
// déploiement l'interroge pendant 90 secondes après chaque bascule et REVIENT
// à la version précédente s'il ne répond pas. Sans cet alias, chaque
// déploiement échouerait et repartirait en arrière — en donnant toutes les
// apparences du bon fonctionnement, puisque l'ancienne version continue de
// servir.
app.get(["/health", "/api/health"], (req, res) => {
  res.json({
    status: "ok",
    ts: Date.now(),
    env: process.env.NODE_ENV,
    whatsapp: isConnected() ? "connected" : "disconnected",
    // Rend visible sans authentification qu'un déploiement tourne avec un
    // schéma en retard sur son code — l'état qui a rendu l'incident du 20/08
    // invisible depuis l'extérieur.
    migrations: etatMigrations.applique ? "ok" : "EN ECHEC",
    migrationsVerifieLe: etatMigrations.verifieLe,
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/coupons", couponsRoutes);
app.use("/api/reviews", reviewsRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/subscriptions", subscriptionsRoutes);
app.use("/api/repairs", repairsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/hero", heroRoutes);
app.use("/api/ads", adsRoutes);
app.use("/api/client-media", clientMediaRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/contacts", contactsRoutes);
app.use("/api/faq", faqRoutes);
app.use("/api/legal", legalRoutes);
app.use("/api/characteristics", characteristicRoutes);
app.use("/api/stats", statsRoutes);

// QR d'appairage accessible depuis le panel admin avec son authentification JWT.
app.get("/api/whatsapp/admin/qr", isAdmin, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (isConnected()) return res.json({ status: "connected", image: null });
  if (!global.lastQR) return res.json({ status: "waiting_qr", image: null });
  try {
    const image = await QRCode.toDataURL(global.lastQR);
    return res.json({ status: "waiting_qr", image });
  } catch {
    return res.status(500).json({ error: "Impossible de générer le QR WhatsApp" });
  }
});

app.get("/api/whatsapp/qr", async (req, res) => {
  const token = req.query.token;
  if (!jetonQrValide(token))
    return res.status(401).json({ error: "Non autorisé" });
  if (isConnected()) return res.json({ status: "connected", qr: null });
  if (!global.lastQR) return res.json({ status: "waiting_qr", qr: null });
  try {
    const image = await QRCode.toDataURL(global.lastQR);
    return res.json({ status: "waiting_qr", qr: global.lastQR, image });
  } catch {
    return res.json({ status: "waiting_qr", qr: global.lastQR });
  }
});

// Script de la page de scan, servi comme fichier séparé.
//
// Helmet applique `script-src 'self'` : tout script écrit directement dans la
// page est refusé par le navigateur. C'est la cause réelle du QR inutilisable
// — l'ancien minuteur de rechargement était lui aussi bloqué, si bien que la
// page restait figée sur un QR périmé au bout de vingt secondes. Servi depuis
// la même origine, ce fichier est autorisé.
//
// Il ne contient aucun secret : le jeton est lu dans l'adresse de la page.
app.get("/api/whatsapp/qr/scan.js", (_req, res) => {
  res.type("application/javascript").send(`
const jeton = new URLSearchParams(location.search).get("token") || "";
let dernier = null;
async function rafraichir() {
  try {
    const r = await fetch("/api/whatsapp/qr?token=" + encodeURIComponent(jeton), { cache: "no-store" });
    const j = await r.json();
    if (j.status === "connected") {
      document.getElementById("qr").style.display = "none";
      const e = document.getElementById("etat");
      e.textContent = "✅ WhatsApp connecté !";
      e.style.color = "green";
      return;
    }
    if (j.image && j.qr !== dernier) {
      dernier = j.qr;
      document.getElementById("qr").src = j.image;
    }
  } catch {}
  setTimeout(rafraichir, 2000);
}
setTimeout(rafraichir, 2000);
`);
});

app.get("/api/whatsapp/qr/scan", async (req, res) => {
  const token = req.query.token;
  if (!jetonQrValide(token))
    return res.status(401).send("<h1>Non autorisé</h1>");
  if (isConnected())
    return res.send("<h1 style='color:green'>✅ WhatsApp connecté !</h1>");
  if (!global.lastQR)
    return res.send(
      // `meta refresh` plutôt qu'un script : la CSP de Helmet refuse tout
      // script écrit dans la page, et ce rechargement ne se produisait donc
      // jamais — la page restait bloquée sur ce message.
      `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"></head><body><h2>⏳ QR pas encore généré</h2><p>Cette page se recharge toute seule.</p></body></html>`,
    );
  // Baileys accorde 60 s au premier QR, puis seulement 20 s à chacun des
  // suivants. La page se rechargeait sur un minuteur fixe de 30 s : elle
  // pouvait donc afficher un QR déjà expiré — et même un QR reçu presque
  // périmé, puisque rien ne garantissait sa fraîcheur au moment du rendu. Le
  // téléphone scannait alors une image morte, sans aucune réaction : c'est
  // ce qui rendait l'appairage impossible.
  //
  // La page interroge maintenant l'API toutes les 2 secondes et remplace
  // l'image dès que le QR change. Ce qui est affiché a donc au plus 2
  // secondes de retard sur ce que le serveur attend, et la page bascule
  // toute seule sur la confirmation dès que la liaison est établie.
  try {
    const image = await QRCode.toDataURL(global.lastQR);
    return res.send(
      `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Scanner WhatsApp — MTECHBENIN</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5}img{width:280px;height:280px;border:4px solid #25D366;border-radius:16px;background:#fff}h2{color:#1D1D1F}p{color:#6E6E73;font-size:14px}#etat{font-weight:600}</style></head><body>
<h2>📱 Scanner avec WhatsApp</h2>
<p>Ouvrez WhatsApp → Appareils liés → Lier un appareil</p>
<img id="qr" src="${image}" alt="QR Code WhatsApp"/>
<p id="etat">QR renouvelé automatiquement — gardez cette page ouverte</p>
<script src="/api/whatsapp/qr/scan.js"></script>
</body></html>`,
    );
  } catch {
    return res.send("<h2>Erreur génération QR</h2>");
  }
});

// ── Reset session WhatsApp (production-safe, protégé par QR_SECRET) ──────────
app.post("/api/whatsapp/reset", async (req, res) => {
  const token = req.query.token || req.headers["x-qr-secret"];
  if (!jetonQrValide(token))
    return res.status(401).json({ error: "Non autorisé" });
  try {
    await destroyAndClean();
    setTimeout(() => initWhatsApp(), 1500);
    return res.json({
      message: "Session réinitialisée — nouveau QR en cours de génération (attendre ~5s puis ouvrir /api/whatsapp/qr/scan)",
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

if (process.env.NODE_ENV === "development") {
  app.post("/api/test/whatsapp", async (req, res) => {
    const { phone, message } = req.body;
    if (!phone) return res.status(400).json({ error: "phone requis" });
    const result = await whatsapp.sendMessage(
      phone,
      message || "Test MTECHBENIN ✅",
    );
    return res.json({ sent: result, phone, connected: isConnected() });
  });
  app.get("/api/test/whatsapp/status", (req, res) => {
    res.json({
      connected: isConnected(),
      message: isConnected()
        ? "✅ WhatsApp connecté"
        : "❌ WhatsApp non connecté",
    });
  });
  app.post("/api/test/whatsapp/reconnect", async (req, res) => {
    try {
      await destroyAndClean();
      await new Promise((r) => setTimeout(r, 1000));
      await initWhatsApp();
      res.json({ message: "🔄 Reconnexion lancée" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// ── État du bot OTP ───────────────────────────────────────────────────────────
// Disponible en production, contrairement aux routes de test ci-dessus : sans
// elle, vérifier une configuration IMAP obligeait à ouvrir les journaux Render.
// Sous `isAdmin` car elle révèle les adresses surveillées. Aucun mot de passe
// n'est exposé.
app.get("/api/otp/status", isAdmin, async (req, res) => {
  try {
    const boites = getBotStatus();
    let nonCouvertes = [];
    try {
      nonCouvertes = await auditAccountCoverage(boites.map((b) => b.boite));
    } catch (err) {
      logger.warn("Diagnostic de couverture indisponible", { err: err.message });
    }
    return res.json({
      actif: boites.length > 0,
      boitesConfigurees: boites.length,
      boitesConnectees: boites.filter((b) => b.connecte).length,
      boites,
      // Adresses de comptes famille qu'aucune boîte ne surveille : leurs codes
      // n'arriveraient jamais.
      adressesNonCouvertes: nonCouvertes,
    });
  } catch (err) {
    logger.error("Erreur /api/otp/status", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.use((req, res) => {
  res
    .status(404)
    .json({ error: `Route ${req.method} ${req.path} introuvable` });
});

app.use(errorHandler);

// ── Migrations de schéma, appliquées au démarrage ────────────────────────────
//
// Le script `start` du package.json enchaîne `prisma migrate deploy` avant de
// lancer ce fichier. Mais rien ne garantit que l'hébergeur utilise ce script :
// une commande de démarrage réglée sur `node src/app.js` dans son tableau de
// bord contourne entièrement npm, et donc les migrations.
//
// C'est exactement ce qui est arrivé le 20/08/2026 : le code du partage de
// profils est parti en production sans ses tables. Les requêtes visaient des
// colonnes inexistantes — tableau de bord des abonnements en erreur, aucun
// abonnement famille livré après paiement, et plus aucun code OTP transmis,
// chaque exception étant avalée par les `catch` des workers.
//
// On applique donc les migrations ici, dans le processus lui-même. Peu importe
// désormais comment il est lancé.
//
// En cas d'échec, on NE bloque PAS le démarrage : la boutique, le catalogue et
// les commandes produits fonctionnent sans le schéma le plus récent, et les
// couper coûterait des ventes. Mais l'échec est journalisé bruyamment et
// exposé dans /health, pour qu'il ne passe pas inaperçu — c'est précisément
// l'inverse qui a fait durer l'incident.
let etatMigrations = { applique: false, erreur: null, verifieLe: null };

function appliquerMigrations() {
  const { execFileSync } = require("child_process");
  try {
    const sortie = execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["prisma", "migrate", "deploy"],
      { encoding: "utf-8", stdio: "pipe", timeout: 120000 },
    );
    etatMigrations = { applique: true, erreur: null, verifieLe: new Date().toISOString() };
    logger.info("🗃️  Migrations de schéma à jour", {
      resume: sortie.trim().slice(-200),
    });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
    etatMigrations = {
      applique: false,
      erreur: detail.slice(0, 500),
      verifieLe: new Date().toISOString(),
    };
    logger.error(
      "❌ MIGRATIONS NON APPLIQUÉES — le schéma de la base ne correspond pas au code. " +
        "Des routes échoueront tant que ce n'est pas résolu. " +
        "Vérifier DIRECT_URL et appliquer prisma/migrations/ à la main si besoin.",
      { detail: detail.slice(0, 500) },
    );
  }
}

async function startServer() {
  appliquerMigrations();

  try {
    await prisma.category.upsert({
      where: { slug: "sextoys" },
      update: { sortOrder: 999 },
      create: {
        name: "Sextoys",
        label: "Sextoys",
        slug: "sextoys",
        icon: "🌸",
        sortOrder: 999,
        active: true,
      },
    });
    logger.info("Catégorie Sextoys vérifiée dans le catalogue");
  } catch (err) {
    logger.error("Erreur création catégorie Sextoys", { err: err.message });
  }

  app.listen(PORT, HOST, () => {
    logger.info(`🚀 MTECHBENIN Backend démarré sur ${HOST}:${PORT}`);
    logger.info(`📦 Environnement : ${process.env.NODE_ENV}`);
    logger.info(`🔗 Health check : http://localhost:${PORT}/health`);
    logger.info(`🌐 Origines CORS : ${ORIGINES_AUTORISEES.join(", ")}`);
  });
  // Branche l'écoute des demandes de code avant d'ouvrir la session, pour
  // qu'aucun message entrant n'arrive sans gestionnaire.
  const { traiterMessageEntrant } = require("./services/whatsappEcoute");
  setGestionnaireMessages(traiterMessageEntrant);
  try {
    await initWhatsApp();
    logger.info("📱 WhatsApp en cours d'initialisation...");
  } catch (err) {
    logger.error("Erreur init WhatsApp", { err: err.message });
  }
  try {
    await startImapBot();
  } catch (err) {
    logger.error("Erreur init BOT IMAP", { err: err.message });
  }
  try {
    demarrerRappels();
  } catch (err) {
    logger.error("Erreur démarrage des rappels d'expiration", { err: err.message });
  }
}

// Flush de la session WhatsApp avant l'arrêt du process (Render redéploie en
// envoyant SIGTERM) — évite de perdre une rotation de clé Baileys survenue
// juste avant le redémarrage et qui n'aurait pas encore atteint le throttle 30s.
async function shutdown(signal) {
  logger.info(`${signal} reçu — sauvegarde de la session WhatsApp avant arrêt...`);
  try {
    await flushSessionSave();
  } catch (err) {
    logger.error("Erreur flush session WhatsApp à l'arrêt", { err: err.message });
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startServer();
module.exports = app;
