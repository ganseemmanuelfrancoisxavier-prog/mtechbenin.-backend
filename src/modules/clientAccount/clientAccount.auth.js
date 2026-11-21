const jwt = require("jsonwebtoken");

function isClient(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Connexion requise." });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (payload.role !== "CLIENT" || !payload.whatsapp) {
      return res.status(403).json({ error: "Accès refusé." });
    }
    req.client = { whatsapp: payload.whatsapp, name: payload.name };
    return next();
  } catch {
    return res.status(401).json({ error: "Session expirée." });
  }
}

module.exports = { isClient };
