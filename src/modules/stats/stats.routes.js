const express = require("express");
const router = express.Router();
const { tableauDeBord, badges } = require("./stats.controller");
const { isAdmin } = require("../../middleware/auth");

// Réservées à l'administration : ces chiffres exposent le chiffre d'affaires
// et le volume de commandes.
router.get("/dashboard", isAdmin, tableauDeBord);
router.get("/badges", isAdmin, badges);

module.exports = router;
