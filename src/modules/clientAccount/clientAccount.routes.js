const express = require("express");
const router = express.Router();
const controller = require("./clientAccount.controller");
const { isClient } = require("./clientAccount.auth");
const { strictLimiter } = require("../../middleware/rateLimiter");

router.post("/request-code", strictLimiter, controller.demanderCode);
router.post("/verify-code", strictLimiter, controller.verifierCode);
router.post("/refresh", controller.refresh);
router.post("/logout", controller.logout);
router.get("/me", isClient, controller.getMe);
router.get("/orders", isClient, controller.getOrders);

module.exports = router;
