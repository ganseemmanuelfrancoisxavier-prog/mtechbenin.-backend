const express = require("express");
const router = express.Router();
const { isAdmin } = require("../../middleware/auth");
const {
  listCharacteristics,
  createCharacteristic,
  updateCharacteristic,
  deleteCharacteristic,
  addValue,
  updateValue,
  deleteValue,
} = require("./characteristics.controller");

// "/values/:valueId" doit précéder "/:id" pour ne pas être capturé par lui.
router.patch("/values/:valueId", isAdmin, updateValue);
router.delete("/values/:valueId", isAdmin, deleteValue);

router.get("/", isAdmin, listCharacteristics);
router.post("/", isAdmin, createCharacteristic);
router.patch("/:id", isAdmin, updateCharacteristic);
router.delete("/:id", isAdmin, deleteCharacteristic);
router.post("/:id/values", isAdmin, addValue);

module.exports = router;
