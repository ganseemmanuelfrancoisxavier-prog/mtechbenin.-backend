const express = require("express");
const router = express.Router();
const { getLegalPage, getAllLegalPages, upsertLegalPage } = require("./legal.controller");
const { isAdmin } = require("../../middleware/auth");

// Admin — avant /:slug pour éviter la capture
router.get("/admin", isAdmin, getAllLegalPages);
router.put("/admin/:slug", isAdmin, upsertLegalPage);

// Public
router.get("/:slug", getLegalPage);

module.exports = router;
