const express = require("express");
const router = express.Router();
const {
  getActiveHero,
  getAllHero,
  createHero,
  updateHero,
  deleteHero,
  toggleHero,
} = require("./hero.controller");
const { isAdmin } = require("../../middleware/auth");

router.get("/", getActiveHero);
router.get("/all", isAdmin, getAllHero);
router.post("/", isAdmin, createHero);
router.patch("/:id", isAdmin, updateHero);
router.patch("/:id/toggle", isAdmin, toggleHero);
router.delete("/:id", isAdmin, deleteHero);

module.exports = router;
