const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

async function getCategories(req, res) {
  try {
    const { includeInactive } = req.query;

    // Si includeInactive=true (panel admin) → toutes les catégories
    // Sinon → uniquement les actives (site public)
    const where = includeInactive === "true" ? {} : { active: true };

    const categories = await prisma.category.findMany({
      where,
      orderBy: { sortOrder: "asc" },
    });
    return res.json({ categories });
  } catch (err) {
    logger.error("Erreur getCategories", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getActiveCategories(req, res) {
  try {
    const categories = await prisma.category.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
    });
    return res.json({ categories });
  } catch (err) {
    logger.error("Erreur getActiveCategories", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function createCategory(req, res) {
  try {
    const category = await prisma.category.create({ data: req.body });
    return res.status(201).json({ category });
  } catch (err) {
    logger.error("Erreur createCategory", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function updateCategory(req, res) {
  try {
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: req.body,
    });
    return res.json({ category });
  } catch (err) {
    logger.error("Erreur updateCategory", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteCategory(req, res) {
  try {
    await prisma.category.delete({ where: { id: req.params.id } });
    return res.json({ message: "Catégorie supprimée" });
  } catch (err) {
    logger.error("Erreur deleteCategory", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

module.exports = {
  getCategories,
  getActiveCategories,
  createCategory,
  updateCategory,
  deleteCategory,
};
