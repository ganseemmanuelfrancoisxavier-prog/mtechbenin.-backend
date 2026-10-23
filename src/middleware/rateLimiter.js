const rateLimit = require("express-rate-limit");

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      100,
  message:  { error: "Trop de requêtes, réessayez dans 15 minutes." },
  standardHeaders: true,
  legacyHeaders:   false,
});

// La page QR valide interroge cet endpoint toutes les 2 secondes pour suivre
// les rotations rapides du QR WhatsApp (≈450 appels/15 min). Elle a son
// propre plafond, activé uniquement pour les scans authentifiés.
const qrLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: "Trop de requêtes QR, réessayez dans 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message:  { error: "Trop de tentatives, réessayez dans 15 minutes." },
});

module.exports = { apiLimiter, qrLimiter, strictLimiter };
