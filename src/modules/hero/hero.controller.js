const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

async function getActiveHero(req, res) {
  try {
    const medias = await prisma.heroMedia.findMany({
      where: { active: true },
      orderBy: { order: "asc" },
    });
    return res.json({ medias });
  } catch (err) {
    logger.error("Erreur getActiveHero", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getAllHero(req, res) {
  try {
    const medias = await prisma.heroMedia.findMany({
      orderBy: { order: "asc" },
    });
    return res.json({ medias });
  } catch (err) {
    logger.error("Erreur getAllHero", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function createHero(req, res) {
  try {
    // On part du plus grand `order` existant, et non du nombre de lignes :
    // après une suppression, `count` retombe et réattribuerait un rang déjà
    // pris. Deux slides partageant le même `order` rendent les flèches de
    // réordonnancement silencieusement inopérantes (elles échangent deux
    // valeurs identiques) et laissent leur ordre d'affichage à l'arbitraire de
    // Postgres, donc instable d'un chargement à l'autre.
    const dernier = await prisma.heroMedia.findFirst({
      orderBy: { order: "desc" },
      select: { order: true },
    });
    const media = await prisma.heroMedia.create({
      data: { ...req.body, order: req.body.order ?? (dernier?.order ?? 0) + 1 },
    });
    return res.status(201).json({ media });
  } catch (err) {
    logger.error("Erreur createHero", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function updateHero(req, res) {
  try {
    const media = await prisma.heroMedia.update({
      where: { id: req.params.id },
      data: req.body,
    });
    return res.json({ media });
  } catch (err) {
    logger.error("Erreur updateHero", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteHero(req, res) {
  try {
    await prisma.heroMedia.delete({ where: { id: req.params.id } });
    return res.json({ message: "Slide supprimé" });
  } catch (err) {
    logger.error("Erreur deleteHero", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function toggleHero(req, res) {
  try {
    const existing = await prisma.heroMedia.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) return res.status(404).json({ error: "Slide introuvable" });
    const media = await prisma.heroMedia.update({
      where: { id: req.params.id },
      data: { active: !existing.active },
    });
    return res.json({ media });
  } catch (err) {
    logger.error("Erreur toggleHero", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

module.exports = {
  getActiveHero,
  getAllHero,
  createHero,
  updateHero,
  deleteHero,
  toggleHero,
};
