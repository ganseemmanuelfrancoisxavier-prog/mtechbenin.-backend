const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");
const { filtrerPhotosAutorisees } = require("./reviewPhotos");

async function getReviewsBySlug(req, res) {
  try {
    const reviews = await prisma.review.findMany({
      where: { productSlug: req.params.slug, approved: true },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ reviews });
  } catch (err) {
    logger.error("Erreur getReviewsBySlug", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getFeaturedReviews(req, res) {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 6));
    // `totalApprouves` accompagne la réponse pour que l'accueil sache s'il
    // reste des avis à découvrir, sans un second aller-retour vers le serveur
    // (qui, sur Render, peut sortir de veille).
    const [reviews, totalApprouves] = await Promise.all([
      prisma.review.findMany({
        where: { approved: true, featured: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.review.count({ where: { approved: true } }),
    ]);
    return res.json({ reviews, totalApprouves });
  } catch (err) {
    logger.error("Erreur getFeaturedReviews", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Liste publique paginée — alimente la page /avis ──────────────────────────
async function getPublicReviews(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const { withPhotos, minRating } = req.query;

    const where = { approved: true };
    if (minRating) {
      const n = Number(minRating);
      if (Number.isFinite(n)) where.rating = { gte: n };
    }
    // Prisma ne sait pas filtrer « tableau JSON non vide » de façon portable :
    // on écarte les valeurs nulles ici, et on retire les tableaux vides après
    // lecture. Le total est recalculé sur la même base pour rester cohérent.
    if (withPhotos === "true") where.photos = { not: null };

    const [brut, total, agregat] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.review.count({ where }),
      prisma.review.aggregate({
        where: { approved: true },
        _avg: { rating: true },
        _count: { _all: true },
      }),
    ]);

    const reviews =
      withPhotos === "true"
        ? brut.filter((r) => Array.isArray(r.photos) && r.photos.length > 0)
        : brut;

    return res.json({
      reviews,
      total,
      page,
      limit,
      moyenne: agregat._avg.rating ? Number(agregat._avg.rating.toFixed(1)) : 0,
      totalApprouves: agregat._count._all,
    });
  } catch (err) {
    logger.error("Erreur getPublicReviews", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function createReview(req, res) {
  try {
    const { productSlug, productName, name, city, rating, text, photos } = req.body;
    if (!productSlug || !name || !rating || !text)
      return res.status(400).json({ error: "Données manquantes" });

    // Sans cette borne, n'importe qui peut poster `rating: 99` : la note
    // moyenne du site est faussée, et l'accueil dessine autant d'étoiles que
    // la valeur reçue.
    const note = Number(rating);
    if (!Number.isFinite(note) || note < 1 || note > 5)
      return res.status(400).json({ error: "La note doit être comprise entre 1 et 5." });

    // Seules les URLs issues de notre propre dossier Cloudinary sont retenues,
    // et au plus 3. Une URL rejetée ne fait pas échouer l'avis : le texte du
    // client est plus important que sa pièce jointe.
    const photosValides = filtrerPhotosAutorisees(photos);

    const review = await prisma.review.create({
      data: {
        productSlug,
        productName: productName || "",
        name,
        city: city || "",
        rating: Math.round(note),
        text,
        photos: photosValides.length ? photosValides : undefined,
        approved: false,
        featured: false,
        date: new Date().toLocaleDateString("fr-FR", {
          month: "long",
          year: "numeric",
        }),
      },
    });
    return res.status(201).json({ review });
  } catch (err) {
    logger.error("Erreur createReview", { err: err.message });
    // Le message brut de Prisma expose les chemins de fichiers du serveur et
    // n'apprend rien au visiteur. Le cas courant est un produit supprimé entre
    // l'affichage de la page et l'envoi du formulaire.
    if (err.code === "P2003") {
      return res
        .status(400)
        .json({ error: "Ce produit n'est plus disponible." });
    }
    return res
      .status(400)
      .json({ error: "Impossible d'enregistrer votre avis — réessayez." });
  }
}

async function getPendingReviews(req, res) {
  try {
    const reviews = await prisma.review.findMany({
      where: { approved: false },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ reviews });
  } catch (err) {
    logger.error("Erreur getPendingReviews", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Tous les avis approuvés (panel admin) ─────────────────────────────────────
async function getApprovedReviews(req, res) {
  try {
    const reviews = await prisma.review.findMany({
      where: { approved: true },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ reviews });
  } catch (err) {
    logger.error("Erreur getApprovedReviews", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function approveReview(req, res) {
  try {
    const review = await prisma.review.update({
      where: { id: req.params.id },
      data: { approved: true },
    });
    return res.json({ review });
  } catch (err) {
    logger.error("Erreur approveReview", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function updateReviewDate(req, res) {
  try {
    const match = /^([0-9]{4})-([0-9]{2})$/.exec(String(req.body.date || ""));
    if (!match) {
      return res.status(400).json({ error: "Choisissez un mois et une année valides." });
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year < 1900 || year > 2100 || month < 1 || month > 12) {
      return res.status(400).json({ error: "Choisissez un mois et une année valides." });
    }
    const date = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("fr-FR", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const review = await prisma.review.update({
      where: { id: req.params.id },
      data: { date },
    });
    return res.json({ review });
  } catch (err) {
    logger.error("Erreur updateReviewDate", { err: err.message });
    return res.status(400).json({ error: "Impossible de modifier la date de cet avis." });
  }
}

async function toggleFeatured(req, res) {
  try {
    const existing = await prisma.review.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) return res.status(404).json({ error: "Avis introuvable" });
    const review = await prisma.review.update({
      where: { id: req.params.id },
      data: { featured: !existing.featured },
    });
    return res.json({ review });
  } catch (err) {
    logger.error("Erreur toggleFeatured", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteReview(req, res) {
  try {
    await prisma.review.delete({ where: { id: req.params.id } });
    return res.json({ message: "Avis supprimé" });
  } catch (err) {
    logger.error("Erreur deleteReview", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

module.exports = {
  getReviewsBySlug,
  getFeaturedReviews,
  getPublicReviews,
  createReview,
  getPendingReviews,
  getApprovedReviews, // ← NOUVEAU
  approveReview,
  updateReviewDate,
  toggleFeatured,
  deleteReview,
};
