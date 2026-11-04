const express = require("express");
const router = express.Router();
const {
  getLegalPage,
  getPublishedLegalPages,
  getAllLegalPages,
  upsertLegalPage,
  deleteLegalPage,
} = require("./legal.controller");
const { isAdmin } = require("../../middleware/auth");

router.get("/", getPublishedLegalPages);
router.get("/admin", isAdmin, getAllLegalPages);
router.put("/admin/:slug", isAdmin, upsertLegalPage);
router.delete("/admin/:slug", isAdmin, deleteLegalPage);
router.get("/:slug", getLegalPage);

module.exports = router;
