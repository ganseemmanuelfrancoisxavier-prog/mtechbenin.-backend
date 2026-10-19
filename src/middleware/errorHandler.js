const logger = require("../utils/logger");

function errorHandler(err, req, res, next) {
  logger.error("Erreur non gérée", {
    message: err.message,
    stack:   err.stack,
    url:     req.url,
    method:  req.method,
  });

  // Charge utile trop lourde (body-parser). Sans ce cas, le message générique
  // « Erreur interne du serveur » masquait la vraie cause en production et
  // laissait l'admin sans piste : ici on dit précisément quoi faire.
  // Cette route sert aussi les webhooks : le message reste juste dans les deux
  // cas, sans supposer qu'il s'agit forcément d'un envoi de média.
  if (err.type === "entity.too.large" || err.status === 413) {
    return res.status(413).json({
      error:
        "Contenu trop volumineux. S'il s'agit d'un média, compressez-le ou choisissez un fichier plus léger.",
    });
  }

  if (err.name === "ZodError") {
    return res.status(400).json({
      error:   "Données invalides",
      details: err.errors,
    });
  }

  if (err.name === "PrismaClientKnownRequestError") {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Cette entrée existe déjà" });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Ressource introuvable" });
    }
  }

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === "production"
      ? "Erreur interne du serveur"
      : err.message,
  });
}

module.exports = { errorHandler };
