const express = require("express");
const router = express.Router();
const {
  getPublishedFaqs,
  getAllFaqs,
  createFaq,
  updateFaq,
  deleteFaq,
  reorderFaqs,
} = require("./faq.controller");
const { isAdmin } = require("../../middleware/auth");

// Public
router.get("/", getPublishedFaqs);

// Admin — routes spécifiques avant /:id
router.get("/admin", isAdmin, getAllFaqs);
router.post("/admin", isAdmin, createFaq);
router.post("/admin/reorder", isAdmin, reorderFaqs);
router.patch("/admin/:id", isAdmin, updateFaq);
router.delete("/admin/:id", isAdmin, deleteFaq);

module.exports = router;
