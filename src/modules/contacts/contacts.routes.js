const express = require("express");
const router = express.Router();
const {
  createContact,
  getContacts,
  updateContactStatus,
  deleteContact,
} = require("./contacts.controller");
const { isAdmin } = require("../../middleware/auth");

router.post("/", createContact);

router.get("/admin", isAdmin, getContacts);
router.patch("/admin/:id/status", isAdmin, updateContactStatus);
router.delete("/admin/:id", isAdmin, deleteContact);

module.exports = router;
