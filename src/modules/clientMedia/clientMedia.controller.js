const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

const ALLOWED_TYPES = ["image", "video"];

// Ne retient que les champs attendus : le corps de requête ne doit jamais
// pouvoir écrire une colonne arbitraire (id, createdAt…).
function sanitize(body = {}) {
  const data = {};
  if (body.url !== undefined) data.url = String(body.url).trim();
  if (body.caption !== undefined) {
    const c = String(body.caption).trim();
    data.caption = c.length ? c.slice(0, 140) : null;
  }
  if (body.type !== undefined) {
    data.type = ALLOWED_TYPES.includes(body.type) ? body.type : "image";
  }
  if (body.active !== undefined) data.active = !!body.active;
  if (body.order !== undefined && Number.isFinite(Number(body.order))) {
    data.order = Number(body.order);
  }
  return data;
}

async function getActiveClientMedia(req, res) {
  try {
    const medias = await prisma.clientMedia.findMany({
      where: { active: true },
      orderBy: { order: "asc" },
    });
    return res.json({ medias });
  } catch (err) {
    logger.error("Erreur getActiveClientMedia", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getAllClientMedia(req, res) {
  try {
    const medias = await prisma.clientMedia.findMany({
      orderBy: { order: "asc" },
    });
    return res.json({ medias });
  } catch (err) {
    logger.error("Erreur getAllClientMedia", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function createClientMedia(req, res) {
  try {
    const data = sanitize(req.body);
    if (!data.url) return res.status(400).json({ error: "Média requis" });

    // Placé en fin de liste par défaut. On part du plus grand `order` existant,
    // et non du nombre de lignes : après une suppression, `count` retombe et
    // réattribuerait un rang déjà pris. Deux médias partageant le même `order`
    // rendent les flèches de réordonnancement silencieusement inopérantes (elles
    // échangent deux valeurs identiques) et laissent leur ordre d'affichage à
    // l'arbitraire de Postgres, donc instable d'un chargement à l'autre.
    const dernier = await prisma.clientMedia.findFirst({
      orderBy: { order: "desc" },
      select: { order: true },
    });
    const media = await prisma.clientMedia.create({
      data: { ...data, order: data.order ?? (dernier?.order ?? 0) + 1 },
    });
    return res.status(201).json({ media });
  } catch (err) {
    logger.error("Erreur createClientMedia", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function updateClientMedia(req, res) {
  try {
    const media = await prisma.clientMedia.update({
      where: { id: req.params.id },
      data: sanitize(req.body),
    });
    return res.json({ media });
  } catch (err) {
    logger.error("Erreur updateClientMedia", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function toggleClientMedia(req, res) {
  try {
    const existing = await prisma.clientMedia.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) return res.status(404).json({ error: "Média introuvable" });
    const media = await prisma.clientMedia.update({
      where: { id: req.params.id },
      data: { active: !existing.active },
    });
    return res.json({ media });
  } catch (err) {
    logger.error("Erreur toggleClientMedia", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteClientMedia(req, res) {
  try {
    await prisma.clientMedia.delete({ where: { id: req.params.id } });
    return res.json({ message: "Média supprimé" });
  } catch (err) {
    logger.error("Erreur deleteClientMedia", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

module.exports = {
  getActiveClientMedia,
  getAllClientMedia,
  createClientMedia,
  updateClientMedia,
  toggleClientMedia,
  deleteClientMedia,
};
