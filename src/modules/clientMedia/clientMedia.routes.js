const express = require("express");
const router = express.Router();
const {
  getActiveClientMedia,
  getAllClientMedia,
  createClientMedia,
  updateClientMedia,
  toggleClientMedia,
  deleteClientMedia,
} = require("./clientMedia.controller");
const { isAdmin } = require("../../middleware/auth");

// "/all" doit précéder toute route paramétrée pour ne pas être capturé.
router.get("/", getActiveClientMedia);
router.get("/all", isAdmin, getAllClientMedia);
router.post("/", isAdmin, createClientMedia);
router.patch("/:id", isAdmin, updateClientMedia);
router.patch("/:id/toggle", isAdmin, toggleClientMedia);
router.delete("/:id", isAdmin, deleteClientMedia);

module.exports = router;
