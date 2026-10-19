const jwt    = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const logger = require("../utils/logger");
const prisma = require("../services/prisma");

// Mot de passe historique livré avec le projet. Il n'est plus une valeur de
// repli acceptée : il figure en clair dans le dépôt et dans sa documentation, donc
// quiconque a lu le code pouvait ouvrir le panel complet — commandes, clients,
// coordonnées GPS, identifiants d'abonnement déchiffrés. On ne le garde que
// pour le reconnaître et le refuser explicitement.
const MOT_DE_PASSE_HISTORIQUE = "admin2026";

// Comparaison à temps constant pour les secrets en clair (évite qu'un
// attaquant puisse déduire le secret caractère par caractère en mesurant le
// temps de réponse d'un simple `===`).
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Politique du mot de passe admin ──────────────────────────────────────────
// Fonction pure : décide si la valeur enregistrée en base peut servir à
// authentifier, sans rien lire ni écrire. Testée dans auth.test.js.
//
// En production, un mot de passe stocké en clair est refusé quel qu'il soit :
// la table `Setting` est relue par plusieurs chemins et son contenu ressort
// dans `/api/settings`. Seul un haché bcrypt est accepté — c'est exactement ce
// que produit le panel Paramètres dès qu'on enregistre un nouveau mot de passe.
function politiqueMotDePasse(motDePasseStocke, { production } = {}) {
  if (!motDePasseStocke) {
    return { utilisable: false, raison: "aucun mot de passe enregistré" };
  }
  if (motDePasseStocke.startsWith("$2")) {
    return { utilisable: true, hache: true };
  }
  if (timingSafeEqualStr(motDePasseStocke, MOT_DE_PASSE_HISTORIQUE)) {
    return {
      utilisable: false,
      raison: "le mot de passe enregistré est la valeur publique du dépôt",
    };
  }
  if (production) {
    return { utilisable: false, raison: "le mot de passe est stocké en clair" };
  }
  return { utilisable: true, hache: false };
}

let refusSignale = false;

function signalerRefusUneFois(raison) {
  if (refusSignale) return;
  refusSignale = true;
  logger.error(
    `Authentification admin par mot de passe refusée — ${raison}. ` +
      `Ouvrez le panel Paramètres et enregistrez un nouveau mot de passe (il sera haché en bcrypt), ` +
      `ou définissez ADMIN_API_KEY sur l'hébergeur.`,
  );
}

// Vérifie un mot de passe candidat contre celui enregistré, en appliquant la
// politique ci-dessus. Renvoie un statut plutôt qu'un booléen : « base
// injoignable » et « mot de passe faux » ne méritent pas la même réponse HTTP.
async function verifierMotDePasseAdmin(candidat) {
  let motDePasseStocke = null;
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: "adminPassword" },
    });
    if (setting?.value) motDePasseStocke = setting.value;
  } catch (err) {
    logger.error("Lecture du mot de passe admin impossible — accès refusé", {
      err: err.message,
    });
    return { statut: "indisponible" };
  }

  const politique = politiqueMotDePasse(motDePasseStocke, {
    production: process.env.NODE_ENV === "production",
  });
  if (!politique.utilisable) {
    signalerRefusUneFois(politique.raison);
    return { statut: "refuse" };
  }

  const valide = politique.hache
    ? await bcrypt.compare(candidat, motDePasseStocke)
    : timingSafeEqualStr(candidat, motDePasseStocke);

  return { statut: valide ? "ok" : "refuse" };
}

async function isAdmin(req, res, next) {
  try {
    // ── Méthode 1 : Bearer JWT ────────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
      if (decoded.role !== "ADMIN")
        return res.status(403).json({ error: "Accès refusé" });
      req.admin = decoded;
      return next();
    }

    // ── Méthode 2 : Clé admin depuis le header x-admin-key ───────────────────
    const adminKey = req.headers["x-admin-key"];
    if (!adminKey) return res.status(401).json({ error: "Token manquant" });

    // Vérification 2a : clé statique ADMIN_API_KEY (variable d'environnement)
    if (process.env.ADMIN_API_KEY && timingSafeEqualStr(adminKey, process.env.ADMIN_API_KEY)) {
      req.admin = { role: "ADMIN" };
      return next();
    }

    // Vérification 2b : mot de passe admin enregistré en base.
    //
    // Aucune valeur de repli : une base injoignable ou une ligne absente
    // refuse l'accès au lieu de l'accorder. C'est le sens correct du doute —
    // l'ancien code retombait sur un mot de passe public et ouvrait tout.
    const { statut } = await verifierMotDePasseAdmin(adminKey);
    if (statut === "indisponible") {
      return res.status(503).json({ error: "Service indisponible" });
    }
    if (statut !== "ok") {
      return res.status(401).json({ error: "Clé admin invalide" });
    }

    req.admin = { role: "ADMIN" };
    return next();
  } catch (err) {
    logger.warn("Auth admin échouée", { err: err.message });
    return res.status(401).json({ error: "Token invalide ou expiré" });
  }
}

module.exports = {
  isAdmin,
  verifierMotDePasseAdmin,
  politiqueMotDePasse,
  timingSafeEqualStr,
};
