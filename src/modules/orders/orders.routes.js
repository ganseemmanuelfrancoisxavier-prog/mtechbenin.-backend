const express = require("express");
const router = express.Router();
const {
  createOrder,
  getOrderByRef,
  getAllOrders,
  updateStatus,
} = require("./orders.controller");
const { isAdmin } = require("../../middleware/auth");

router.post("/", createOrder);
router.get("/", isAdmin, getAllOrders);
router.get("/:ref", getOrderByRef);
router.patch("/:ref/status", isAdmin, updateStatus);

module.exports = router;
