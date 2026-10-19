const express = require("express");
const router = express.Router();
const {
  getProducts,
  searchProducts,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct,
} = require("./products.controller");
const {
  getVariants,
  createVariantType,
  updateVariantType,
  deleteVariantType,
  createVariantOption,
  updateVariantOption,
  deleteVariantOption,
  attachFromLibrary,
} = require("./variants.controller");
const { isAdmin } = require("../../middleware/auth");

router.get("/search", searchProducts);
router.get("/", getProducts);
router.get("/:slug", getProductBySlug);
router.post("/", isAdmin, createProduct);
router.patch("/:id", isAdmin, updateProduct);
router.delete("/:id", isAdmin, deleteProduct);

// ── Variantes (admin) ─────────────────────────────────────────────────────────
router.get("/:productId/variants", isAdmin, getVariants);
router.post("/:productId/variants/types", isAdmin, createVariantType);
router.post("/:productId/variants/from-library", isAdmin, attachFromLibrary);
router.patch("/:productId/variants/types/:typeId", isAdmin, updateVariantType);
router.delete("/:productId/variants/types/:typeId", isAdmin, deleteVariantType);
router.post("/:productId/variants/types/:typeId/options", isAdmin, createVariantOption);
router.patch("/:productId/variants/options/:optionId", isAdmin, updateVariantOption);
router.delete("/:productId/variants/options/:optionId", isAdmin, deleteVariantOption);

module.exports = router;
