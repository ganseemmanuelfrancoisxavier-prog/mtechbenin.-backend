const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

async function createContact(req, res) {
  try {
    const { name, whatsapp, email, subject, message } = req.body;
    if (!name || !whatsapp || !subject || !message)
      return res.status(400).json({ error: "Données manquantes" });

    const contact = await prisma.contactMessage.create({
      data: {
        name: name.trim(),
        whatsapp: whatsapp.trim(),
        email: email?.trim() || null,
        subject: subject.trim(),
        message: message.trim(),
        status: "new",
      },
    });
    return res.status(201).json({ contact });
  } catch (err) {
    logger.error("Erreur createContact", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getContacts(req, res) {
  try {
    const { status } = req.query;
    const where = status ? { status } : {};
    const contacts = await prisma.contactMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    const total = await prisma.contactMessage.count();
    const newCount = await prisma.contactMessage.count({ where: { status: "new" } });
    return res.json({ contacts, total, newCount });
  } catch (err) {
    logger.error("Erreur getContacts", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function updateContactStatus(req, res) {
  try {
    const { status } = req.body;
    const allowed = ["new", "read", "archived"];
    if (!allowed.includes(status))
      return res.status(400).json({ error: "Statut invalide" });

    const contact = await prisma.contactMessage.update({
      where: { id: req.params.id },
      data: { status },
    });
    return res.json({ contact });
  } catch (err) {
    logger.error("Erreur updateContactStatus", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteContact(req, res) {
  try {
    await prisma.contactMessage.delete({ where: { id: req.params.id } });
    return res.json({ message: "Message supprimé" });
  } catch (err) {
    logger.error("Erreur deleteContact", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

module.exports = { createContact, getContacts, updateContactStatus, deleteContact };
