"use strict";

const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

function hasContent(content) {
  return typeof content === "string" &&
    content.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;|&#xA0;/gi, " ").trim().length > 0;
}

async function getLegalPage(req, res) {
  try {
    const page = await prisma.legalPage.findUnique({ where: { slug: req.params.slug } });
    if (!page || !hasContent(page.content)) return res.status(404).json({ page: null });
    return res.json({ page });
  } catch (err) {
    logger.error("Erreur getLegalPage", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getPublishedLegalPages(_req, res) {
  try {
    const pages = await prisma.legalPage.findMany({ orderBy: { updatedAt: "desc" } });
    return res.json({
      pages: pages
        .filter((page) => hasContent(page.content))
        .map(({ slug, title, updatedAt }) => ({ slug, title, updatedAt })),
    });
  } catch (err) {
    logger.error("Erreur getPublishedLegalPages", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getAllLegalPages(_req, res) {
  try {
    const pages = await prisma.legalPage.findMany({ orderBy: { updatedAt: "desc" } });
    return res.json({ pages });
  } catch (err) {
    logger.error("Erreur getAllLegalPages", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function upsertLegalPage(req, res) {
  try {
    const { slug } = req.params;
    const { title, content } = req.body || {};
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
      return res.status(400).json({ error: "Identifiant de page invalide" });
    }
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Titre requis" });
    }
    if (!hasContent(content)) return res.status(400).json({ error: "Contenu requis" });

    const page = await prisma.legalPage.upsert({
      where: { slug },
      create: { slug, title: title.trim(), content },
      update: { title: title.trim(), content, updatedAt: new Date() },
    });
    return res.json({ page });
  } catch (err) {
    logger.error("Erreur upsertLegalPage", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function deleteLegalPage(req, res) {
  try {
    const result = await prisma.legalPage.deleteMany({ where: { slug: req.params.slug } });
    if (!result.count) return res.status(404).json({ error: "Page introuvable" });
    return res.json({ success: true });
  } catch (err) {
    logger.error("Erreur deleteLegalPage", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

module.exports = {
  getLegalPage,
  getPublishedLegalPages,
  getAllLegalPages,
  upsertLegalPage,
  deleteLegalPage,
};
