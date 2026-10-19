const express = require("express");
const router = express.Router();
const {
  validateCoupon,
  getAllCoupons,
  createCoupon,
  updateCoupon,
  toggleCoupon,
  deleteCoupon,
} = require("./coupons.controller");
const { isAdmin } = require("../../middleware/auth");

router.post("/validate", validateCoupon);
router.get("/", isAdmin, getAllCoupons);
router.post("/", isAdmin, createCoupon);
router.patch("/:id", isAdmin, updateCoupon);
router.patch("/:id/toggle", isAdmin, toggleCoupon);
router.delete("/:id", isAdmin, deleteCoupon);

module.exports = router;
