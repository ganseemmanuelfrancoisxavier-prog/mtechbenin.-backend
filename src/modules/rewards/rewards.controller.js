const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");
const { assurerCodeParrainage, normaliserTelephone } = require("./rewards.service");
const MIN = 2000;
async function getDashboard(req, res) {
  try {
    const phone = req.client.whatsapp;
    const [referralCode, ledger, entries, withdrawals] = await Promise.all([
      assurerCodeParrainage(phone),
      prisma.rewardEntry.aggregate({ where: { clientWhatsapp: phone }, _sum: { amount: true } }),
      prisma.rewardEntry.findMany({ where: { clientWhatsapp: phone }, orderBy: { createdAt: "desc" }, take: 40 }),
      prisma.withdrawalRequest.findMany({ where: { clientWhatsapp: phone }, orderBy: { requestedAt: "desc" }, take: 20 }),
    ]);
    return res.json({ referralCode, balance: ledger._sum.amount || 0, minimumWithdrawal: MIN, entries, withdrawals });
  } catch (err) { logger.error("Rewards dashboard", { err: err.message }); return res.status(500).json({ error: "Impossible de charger les récompenses." }); }
}
async function demanderRetrait(req, res) {
  const amount = Number(req.body && req.body.amount);
  const payoutNumber = normaliserTelephone(req.body && req.body.payoutNumber);
  if (!Number.isSafeInteger(amount) || amount < MIN) return res.status(400).json({ error: "Le retrait minimum est de 2 000 F CFA." });
  if (payoutNumber.length < 8 || payoutNumber.length > 15) return res.status(400).json({ error: "Saisissez un numéro Mobile Money valide." });
  try {
    const result = await prisma.$transaction(async tx => {
      const current = await tx.rewardEntry.aggregate({ where: { clientWhatsapp: req.client.whatsapp }, _sum: { amount: true } });
      const balance = current._sum.amount || 0;
      if (amount > balance || balance < MIN) return { error: "Solde insuffisant.", status: 400 };
      const withdrawal = await tx.withdrawalRequest.create({ data: { clientWhatsapp: req.client.whatsapp, amount, payoutNumber } });
      await tx.rewardEntry.create({ data: { clientWhatsapp: req.client.whatsapp, withdrawalId: withdrawal.id, type: "WITHDRAWAL", amount: -amount, details: "Montant réservé pour retrait" } });
      return { withdrawal };
    }, { isolationLevel: "Serializable" });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(201).json(result);
  } catch (err) { logger.error("Rewards withdrawal", { err: err.message }); return res.status(err.code === "P2034" ? 409 : 500).json({ error: "Impossible d'enregistrer la demande." }); }
}
async function listerRetraitsAdmin(req, res) {
  try {
    const status = String(req.query.status || "").toUpperCase();
    const where = ["REQUESTED", "PAID", "REJECTED"].includes(status) ? { status } : {};
    const withdrawals = await prisma.withdrawalRequest.findMany({ where, include: { client: { select: { name: true } } }, orderBy: { requestedAt: "desc" }, take: 200 });
    return res.json({ withdrawals });
  } catch (err) { logger.error("Admin rewards withdrawals", { err: err.message }); return res.status(500).json({ error: "Impossible de charger les retraits." }); }
}
async function traiterRetraitAdmin(req, res) {
  const status = String(req.body && req.body.status || "").toUpperCase();
  if (!["PAID", "REJECTED"].includes(status)) return res.status(400).json({ error: "Statut invalide." });
  const adminNote = String(req.body && req.body.adminNote || "").trim().slice(0, 500) || null;
  try {
    const result = await prisma.$transaction(async tx => {
      const current = await tx.withdrawalRequest.findUnique({ where: { id: req.params.id } });
      if (!current) return { error: "Demande introuvable.", code: 404 };
      if (current.status !== "REQUESTED") return { error: "Demande déjà traitée.", code: 409 };
      const changed = await tx.withdrawalRequest.updateMany({ where: { id: current.id, status: "REQUESTED" }, data: { status, adminNote, processedAt: new Date() } });
      if (changed.count !== 1) return { error: "Demande déjà traitée.", code: 409 };
      if (status === "REJECTED") await tx.rewardEntry.create({ data: { clientWhatsapp: current.clientWhatsapp, withdrawalId: current.id, type: "WITHDRAWAL_REFUND", amount: current.amount, details: adminNote || "Montant rendu après refus" } });
      return { withdrawal: await tx.withdrawalRequest.findUnique({ where: { id: current.id } }) };
    }, { isolationLevel: "Serializable" });
    if (result.error) return res.status(result.code).json({ error: result.error });
    return res.json(result);
  } catch (err) { logger.error("Admin process withdrawal", { err: err.message }); return res.status(500).json({ error: "Traitement impossible." }); }
}
module.exports = { getDashboard, demanderRetrait, listerRetraitsAdmin, traiterRetraitAdmin };
