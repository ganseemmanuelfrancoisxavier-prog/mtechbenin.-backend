const express = require("express");
const router = express.Router();
const {
  getActiveAds,
  getAllAds,
  createAd,
  updateAd,
  toggleAd,
  deleteAd,
} = require("./ads.controller");
const { isAdmin } = require("../../middleware/auth");

router.get("/", getActiveAds);
router.get("/all", isAdmin, getAllAds);
router.post("/", isAdmin, createAd);
router.patch("/:id", isAdmin, updateAd);
router.patch("/:id/toggle", isAdmin, toggleAd);
router.delete("/:id", isAdmin, deleteAd);

module.exports = router;
