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
async function listerRecompensesAdmin(req, res) {
  try {
    const search = String(req.query.search || "").trim();
    const where = { accountCreatedAt: { not: null } };
    if (search) where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { whatsapp: { contains: search } },
      { referralCode: { contains: search, mode: "insensitive" } },
    ];
    const clients = await prisma.clientTracker.findMany({
      where,
      select: { whatsapp: true, name: true, referralCode: true, accountCreatedAt: true },
      orderBy: { accountCreatedAt: "desc" }, take: 500,
    });
    const phones = clients.map((client) => client.whatsapp);
    if (!phones.length) return res.json({ summary: { clients: 0, earned: 0, paid: 0, available: 0, pending: 0, due: 0 }, clients: [] });
    const [ledger, earned, withdrawals] = await Promise.all([
      prisma.rewardEntry.groupBy({ by: ["clientWhatsapp"], where: { clientWhatsapp: { in: phones } }, _sum: { amount: true } }),
      prisma.rewardEntry.groupBy({ by: ["clientWhatsapp"], where: { clientWhatsapp: { in: phones }, type: { in: ["CASHBACK", "REFERRAL"] } }, _sum: { amount: true } }),
      prisma.withdrawalRequest.groupBy({ by: ["clientWhatsapp", "status"], where: { clientWhatsapp: { in: phones } }, _sum: { amount: true } }),
    ]);
    const mapSums = (rows) => new Map(rows.map((row) => [row.clientWhatsapp, row._sum.amount || 0]));
    const balances = mapSums(ledger), earnings = mapSums(earned);
    const paid = new Map(), pending = new Map();
    for (const row of withdrawals) {
      if (row.status === "PAID") paid.set(row.clientWhatsapp, row._sum.amount || 0);
      if (row.status === "REQUESTED") pending.set(row.clientWhatsapp, row._sum.amount || 0);
    }
    const rows = clients.map((client) => {
      const available = balances.get(client.whatsapp) || 0;
      const pendingAmount = pending.get(client.whatsapp) || 0;
      return { ...client, earned: earnings.get(client.whatsapp) || 0, paid: paid.get(client.whatsapp) || 0, available, pending: pendingAmount, due: available + pendingAmount };
    });
    const summary = rows.reduce((acc, row) => {
      acc.clients += 1; acc.earned += row.earned; acc.paid += row.paid;
      acc.available += row.available; acc.pending += row.pending; acc.due += row.due;
      return acc;
    }, { clients: 0, earned: 0, paid: 0, available: 0, pending: 0, due: 0 });
    return res.json({ summary, clients: rows });
  } catch (err) {
    logger.error("Admin rewards dashboard", { err: err.message });
    return res.status(500).json({ error: "Impossible de charger le suivi des récompenses." });
  }
}

async function getDetailRecompensesAdmin(req, res) {
  try {
    const whatsapp = decodeURIComponent(String(req.params.whatsapp || ""));
    const client = await prisma.clientTracker.findUnique({
      where: { whatsapp },
      select: { whatsapp: true, name: true, referralCode: true, accountCreatedAt: true },
    });
    if (!client || !client.accountCreatedAt) return res.status(404).json({ error: "Compte client introuvable." });
    const [entries, withdrawals] = await Promise.all([
      prisma.rewardEntry.findMany({ where: { clientWhatsapp: whatsapp }, orderBy: { createdAt: "desc" }, take: 300 }),
      prisma.withdrawalRequest.findMany({ where: { clientWhatsapp: whatsapp }, orderBy: { requestedAt: "desc" }, take: 100 }),
    ]);
    return res.json({ client, entries, withdrawals });
  } catch (err) {
    logger.error("Admin reward trace", { err: err.message });
    return res.status(500).json({ error: "Impossible de charger la traçabilité." });
  }
}

module.exports = { listerRecompensesAdmin, getDetailRecompensesAdmin, getDashboard, demanderRetrait, listerRetraitsAdmin, traiterRetraitAdmin };
