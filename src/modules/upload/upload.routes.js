const express = require("express");
const router = express.Router();
const { isAdmin } = require("../../middleware/auth");
const { uploadMedia, deleteMedia } = require("./upload.controller");

// Les opérations Cloudinary sont réservées à l'administrateur.
router.post("/", isAdmin, uploadMedia);
router.delete("/", isAdmin, deleteMedia);

module.exports = router;
