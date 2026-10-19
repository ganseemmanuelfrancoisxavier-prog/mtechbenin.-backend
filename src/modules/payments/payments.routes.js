const express = require("express");
const router = express.Router();
const { fedapayWebhook } = require("./payments.controller");

// FedaPay envoie le body en raw — important pour vérification signature
router.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  fedapayWebhook,
);

module.exports = router;
