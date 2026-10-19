const express = require("express");
const router = express.Router();
const {
  getPublicSettings,
  getAllSettings,
  updateSettings,
} = require("./settings.controller");
const { isAdmin } = require("../../middleware/auth");

router.get("/public", getPublicSettings);
router.get("/", isAdmin, getAllSettings);
router.patch("/", isAdmin, updateSettings);
router.post("/", isAdmin, updateSettings); // ← frontend envoie POST

module.exports = router;
