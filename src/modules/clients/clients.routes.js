const express = require("express");
const router = express.Router();
const { getClients, getClientByWhatsapp } = require("./clients.controller");
const { isAdmin } = require("../../middleware/auth");

router.get("/", isAdmin, getClients);
router.get("/:whatsapp", isAdmin, getClientByWhatsapp);

module.exports = router;
