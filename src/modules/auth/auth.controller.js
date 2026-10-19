const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
const redis    = require("../../services/redis");
const logger   = require("../../utils/logger");
const { verifierMotDePasseAdmin } = require("../../middleware/auth");

// Une session par appareil. La clé Redis était `refresh:admin`, fixe : se
// connecter depuis un second appareil écrasait le jeton du premier, qui se
// retrouvait déconnecté sans explication au bout de 15 minutes. L'identifiant
// de session porté par le jeton donne à chacun sa propre clé.
const cleSession = (sid) => `refresh:admin:${sid}`;

// Lecture du cookie de rafraîchissement.
//
// `req.cookies` n'existe que si `cookie-parser` est monté — il ne l'est pas, et
// n'est même pas une dépendance du projet. `/api/auth/refresh` répondait donc
// « Refresh token manquant » à chaque appel depuis toujours : la session admin
// ne pouvait jamais être prolongée. On lit l'en-tête directement plutôt que
// d'ajouter une dépendance pour un seul cookie.
function lireCookie(req, nom) {
  const brut = req.headers?.cookie;
  if (!brut) return null;
  for (const morceau of brut.split(";")) {
    const separateur = morceau.indexOf("=");
    if (separateur === -1) continue;
    if (morceau.slice(0, separateur).trim() !== nom) continue;
    try {
      return decodeURIComponent(morceau.slice(separateur + 1).trim());
    } catch {
      return morceau.slice(separateur + 1).trim();
    }
  }
  return null;
}

// Login admin
async function login(req, res) {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Mot de passe requis" });

    // Même politique que le middleware `isAdmin` — elle vit à un seul endroit
    // pour qu'un durcissement ne puisse pas s'appliquer à une porte et pas à
    // l'autre. La comparaison y est aussi à temps constant, ce que le `===`
    // d'ici n'était pas.
    const { statut } = await verifierMotDePasseAdmin(password);
    if (statut === "indisponible") {
      return res.status(503).json({ error: "Service indisponible" });
    }
    if (statut !== "ok") {
      logger.warn("Tentative de connexion admin échouée");
      return res.status(401).json({ error: "Mot de passe incorrect" });
    }

    // Pas de `iat` explicite : `jsonwebtoken` calcule `exp` à partir de `iat`,
    // et l'ancien `iat: Date.now()` fournissait des MILLISECONDES là où la
    // norme JWT compte des SECONDES. L'expiration tombait donc en l'an 58597 —
    // le `expiresIn: "15m"` ne servait à rien et un jeton volé restait valable
    // à vie. Laissé à la bibliothèque, `iat` est correct et la fenêtre de 15
    // minutes s'applique réellement.
    const accessToken = jwt.sign(
      { role: "ADMIN" },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const sid = crypto.randomUUID();
    const refreshTokenValue = jwt.sign(
      { role: "ADMIN", type: "refresh", sid },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" }
    );

    // Stocke refresh token dans Redis, sous une clé propre à cette session
    await redis.set(cleSession(sid), refreshTokenValue, { ex: 7 * 24 * 3600 });

    res.cookie("refreshToken", refreshTokenValue, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge:   7 * 24 * 60 * 60 * 1000,
    });

    logger.info("Admin connecté");
    return res.json({ accessToken, message: "Connexion réussie" });
  } catch (err) {
    logger.error("Erreur login", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Refresh token
async function refreshToken(req, res) {
  try {
    const token = lireCookie(req, "refreshToken");
    if (!token) return res.status(401).json({ error: "Refresh token manquant" });

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    if (decoded.type !== "refresh") return res.status(401).json({ error: "Token invalide" });
    if (!decoded.sid) return res.status(401).json({ error: "Session expirée" });

    // Vérifie en Redis, sur la clé de CETTE session
    const stored = await redis.get(cleSession(decoded.sid));
    if (stored !== token) return res.status(401).json({ error: "Session expirée" });

    const accessToken = jwt.sign(
      { role: "ADMIN" },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    return res.json({ accessToken });
  } catch (err) {
    return res.status(401).json({ error: "Token invalide ou expiré" });
  }
}

// Logout
// Ne révoque que la session de l'appareil qui se déconnecte : les autres
// restent valides, ce qui est le comportement attendu d'un « se déconnecter ».
async function logout(req, res) {
  const token = lireCookie(req, "refreshToken");
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      if (decoded.sid) await redis.del(cleSession(decoded.sid));
    } catch {
      // Jeton illisible ou expiré : rien à révoquer, on efface le cookie.
    }
  }
  res.clearCookie("refreshToken");
  return res.json({ message: "Déconnecté" });
}

// Get me
async function getMe(req, res) {
  return res.json({ role: "ADMIN", message: "Authentifié" });
}

module.exports = { login, refreshToken, logout, getMe };
