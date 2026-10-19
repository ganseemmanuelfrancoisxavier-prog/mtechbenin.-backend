const express = require("express");
const router = express.Router();
const {
  getCategories,
  getActiveCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} = require("./categories.controller");
const { isAdmin } = require("../../middleware/auth");

router.get("/", getActiveCategories);
router.get("/all", isAdmin, getCategories);
router.post("/", isAdmin, createCategory);
router.patch("/:id", isAdmin, updateCategory);
router.delete("/:id", isAdmin, deleteCategory);

module.exports = router;
