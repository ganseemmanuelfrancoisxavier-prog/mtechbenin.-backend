const rateLimit = require("express-rate-limit");

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:      100,
  message:  { error: "Trop de requêtes, réessayez dans 15 minutes." },
  standardHeaders: true,
  legacyHeaders:   false,
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message:  { error: "Trop de tentatives, réessayez dans 15 minutes." },
});

module.exports = { apiLimiter, strictLimiter };
