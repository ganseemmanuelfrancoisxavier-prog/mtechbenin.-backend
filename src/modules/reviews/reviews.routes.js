const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const {
  getReviewsBySlug,
  getFeaturedReviews,
  getPublicReviews,
  createReview,
  getPendingReviews,
  getApprovedReviews,
  approveReview,
  updateReviewDate,
  toggleFeatured,
  deleteReview,
} = require("./reviews.controller");
const { uploadReviewPhoto } = require("./reviewPhotos");
const { isAdmin } = require("../../middleware/auth");

// Limite dédiée à l'envoi de photos : c'est le seul point d'upload ouvert au
// public. Le `strictLimiter` du projet (10 / 15 min) serait trop serré — un
// client peut légitimement joindre 3 photos, s'y reprendre à deux fois, puis
// laisser un second avis.
const photoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Trop d'envois — réessayez dans quelques minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Routes spécifiques AVANT /:slug pour éviter la capture wildcard ───────────
router.get("/", getPublicReviews);
router.get("/featured", getFeaturedReviews);
router.get("/admin/pending", isAdmin, getPendingReviews);
router.get("/admin/approved", isAdmin, getApprovedReviews);
router.get("/:slug", getReviewsBySlug);

router.post("/photos", photoLimiter, uploadReviewPhoto);
router.post("/", createReview);

router.patch("/admin/:id/approve", isAdmin, approveReview);
router.patch("/admin/:id/date", isAdmin, updateReviewDate);
router.patch("/admin/:id/featured", isAdmin, toggleFeatured);
router.delete("/admin/:id", isAdmin, deleteReview);

module.exports = router;
