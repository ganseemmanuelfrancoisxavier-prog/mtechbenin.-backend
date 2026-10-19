const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");
// Validation d'URL partagée : fonction pure déjà couverte par des tests.
// La réécrire ici produirait deux comportements différents pour un même
// besoin, et l'un des deux finirait par diverger.
const { lienValide } = require("../subscriptions/linkPool");

const TYPES = new Set(["image", "video"]);

// Contrôle des champs communs à la création et à la modification.
// Rend `{ ok: true, data }` ou `{ ok: false, erreur }` — jamais d'exception,
// pour répondre en français plutôt qu'avec le message technique de Prisma.
function validerAnnonce(corps, { creation }) {
  const data = {};

  if (creation || corps.advertiser !== undefined) {
    const nom = String(corps.advertiser ?? "").trim();
    if (!nom) return { ok: false, erreur: "Le nom de l'annonceur est requis" };
    data.advertiser = nom;
  }

  if (creation || corps.url !== undefined) {
    const url = String(corps.url ?? "").trim();
    if (!url) return { ok: false, erreur: "Le visuel est requis" };
    data.url = url;
  }

  if (corps.type !== undefined) {
    if (!TYPES.has(corps.type)) {
      return { ok: false, erreur: "Type de média invalide" };
    }
    data.type = corps.type;
  }

  if (corps.caption !== undefined) {
    const c = String(corps.caption ?? "").trim();
    data.caption = c || null;
  }

  // Un lien vide efface le lien : l'annonce reste affichée, simplement non
  // cliquable. Un lien renseigné doit être une adresse web réelle — envoyer
  // le visiteur sur une adresse illisible serait pire que pas de lien.
  if (corps.href !== undefined) {
    const h = String(corps.href ?? "").trim();
    if (!h) data.href = null;
    else if (!lienValide(h)) {
      return { ok: false, erreur: "Lien invalide — attendu une adresse http ou https" };
    } else data.href = h;
  }

  if (corps.active !== undefined) data.active = Boolean(corps.active);
  if (corps.order !== undefined) data.order = Number(corps.order);

  return { ok: true, data };
}

// Départage par `createdAt` quand deux annonces partagent le même `order` :
// sans second critère, Postgres est libre de rendre ces lignes dans n'importe
// quel ordre, différent d'un chargement à l'autre.
async function getActiveAds(req, res) {
  try {
    const ads = await prisma.advertisement.findMany({
      where: { active: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    return res.json({ ads });
  } catch (err) {
    logger.error("Erreur getActiveAds", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getAllAds(req, res) {
  try {
    const ads = await prisma.advertisement.findMany({
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    return res.json({ ads });
  } catch (err) {
    logger.error("Erreur getAllAds", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function createAd(req, res) {
  try {
    const v = validerAnnonce(req.body, { creation: true });
    if (!v.ok) return res.status(400).json({ error: v.erreur });

    // On part du plus grand `order` existant, et non du nombre de lignes :
    // après une suppression, un comptage réattribuerait un rang déjà pris.
    // Deux annonces partageant le même `order` rendraient les flèches de
    // réordonnancement silencieusement inopérantes — elles échangeraient deux
    // valeurs identiques — et laisseraient leur ordre à l'arbitraire de
    // Postgres, donc instable d'un chargement à l'autre.
    const dernier = await prisma.advertisement.findFirst({
      orderBy: { order: "desc" },
      select: { order: true },
    });

    const ad = await prisma.advertisement.create({
      data: { ...v.data, order: v.data.order ?? (dernier?.order ?? 0) + 1 },
    });
    return res.status(201).json({ ad });
  } catch (err) {
    logger.error("Erreur createAd", { err: err.message });
    return res.status(400).json({ error: "Création impossible" });
  }
}

async function updateAd(req, res) {
  try {
    const v = validerAnnonce(req.body, { creation: false });
    if (!v.ok) return res.status(400).json({ error: v.erreur });

    const ad = await prisma.advertisement.update({
      where: { id: req.params.id },
      data: v.data,
    });
    return res.json({ ad });
  } catch (err) {
    logger.error("Erreur updateAd", { err: err.message });
    return res.status(400).json({ error: "Modification impossible" });
  }
}

async function toggleAd(req, res) {
  try {
    const existant = await prisma.advertisement.findUnique({
      where: { id: req.params.id },
    });
    if (!existant) return res.status(404).json({ error: "Annonce introuvable" });

    const ad = await prisma.advertisement.update({
      where: { id: req.params.id },
      data: { active: !existant.active },
    });
    return res.json({ ad });
  } catch (err) {
    logger.error("Erreur toggleAd", { err: err.message });
    return res.status(400).json({ error: "Modification impossible" });
  }
}

async function deleteAd(req, res) {
  try {
    await prisma.advertisement.delete({ where: { id: req.params.id } });
    return res.json({ message: "Annonce supprimée" });
  } catch (err) {
    logger.error("Erreur deleteAd", { err: err.message });
    return res.status(400).json({ error: "Suppression impossible" });
  }
}

module.exports = {
  getActiveAds,
  getAllAds,
  createAd,
  updateAd,
  toggleAd,
  deleteAd,
  validerAnnonce,
};
