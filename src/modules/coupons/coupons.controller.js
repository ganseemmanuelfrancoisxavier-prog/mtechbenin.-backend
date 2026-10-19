const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

async function validateCoupon(req, res) {
  try {
    const { code, cartTotal } = req.body;
    if (!code) return res.status(400).json({ error: "Code requis" });

    const coupon = await prisma.coupon.findUnique({
      where: { code: code.toUpperCase().trim() },
    });

    if (!coupon)
      return res
        .status(404)
        .json({ valid: false, error: "Code promo invalide" });
    if (!coupon.active)
      return res
        .status(400)
        .json({ valid: false, error: "Ce code promo est inactif" });
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date())
      return res
        .status(400)
        .json({ valid: false, error: "Ce code promo a expiré" });
    if (coupon.maxUses && coupon.usedCount >= coupon.maxUses)
      return res
        .status(400)
        .json({ valid: false, error: "Ce code promo est épuisé" });
    if (coupon.minOrder > 0 && Number(cartTotal) < coupon.minOrder)
      return res.status(400).json({
        valid: false,
        error: `Commande minimum de ${coupon.minOrder.toLocaleString("fr-FR")} FCFA requise`,
      });

    return res.json({ valid: true, coupon });
  } catch (err) {
    logger.error("Erreur validateCoupon", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getAllCoupons(req, res) {
  try {
    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: "desc" },
    });
    return res.json({ coupons });
  } catch (err) {
    logger.error("Erreur getAllCoupons", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function createCoupon(req, res) {
  try {
    const data = {
      ...req.body,
      code: req.body.code.toUpperCase().trim(),
      usedCount: 0,
      expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
    };
    const coupon = await prisma.coupon.create({ data });
    return res.status(201).json({ coupon });
  } catch (err) {
    logger.error("Erreur createCoupon", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function updateCoupon(req, res) {
  try {
    const data = {
      ...req.body,
      expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
    };
    const coupon = await prisma.coupon.update({
      where: { id: req.params.id },
      data,
    });
    return res.json({ coupon });
  } catch (err) {
    logger.error("Erreur updateCoupon", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}
async function toggleCoupon(req, res) {
  try {
    const existing = await prisma.coupon.findUnique({
      where: { id: req.params.id },
    });
    if (!existing) return res.status(404).json({ error: "Coupon introuvable" });
    const coupon = await prisma.coupon.update({
      where: { id: req.params.id },
      data: { active: !existing.active },
    });
    return res.json({ coupon });
  } catch (err) {
    logger.error("Erreur toggleCoupon", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteCoupon(req, res) {
  try {
    await prisma.coupon.delete({ where: { id: req.params.id } });
    return res.json({ message: "Coupon supprimé" });
  } catch (err) {
    logger.error("Erreur deleteCoupon", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function incrementUsed(code) {
  try {
    await prisma.coupon.update({
      where: { code },
      data: { usedCount: { increment: 1 } },
    });
  } catch (err) {
    logger.error("Erreur incrementUsed", { err: err.message });
  }
}

module.exports = {
  validateCoupon,
  getAllCoupons,
  createCoupon,
  updateCoupon,
  toggleCoupon,
  deleteCoupon,
  incrementUsed,
};
