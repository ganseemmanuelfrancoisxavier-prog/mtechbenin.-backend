const crypto = require("crypto");
const prisma = require("../../services/prisma");
const normaliserTelephone = (value) => String(value || "").replace(/\\D/g, "");

async function assurerCodeParrainage(whatsapp) {
  const client = await prisma.clientTracker.findUnique({ where: { whatsapp } });
  if (!client) throw new Error("Compte client introuvable.");
  if (client.referralCode) return client.referralCode;
  for (let i = 0; i < 5; i++) {
    const code = "MTB" + crypto.randomBytes(4).toString("hex").toUpperCase();
    try {
      await prisma.clientTracker.updateMany({ where: { id: client.id, referralCode: null }, data: { referralCode: code } });
      const updated = await prisma.clientTracker.findUnique({ where: { whatsapp } });
      if (updated && updated.referralCode) return updated.referralCode;
    } catch (err) { if (err.code !== "P2002") throw err; }
  }
  throw new Error("Impossible de créer le code de parrainage.");
}

async function enregistrerRecompensesPaiement({ paymentId, buyerWhatsapp, buyerName, referralCode, saleAmount, orderRef }) {
  const buyerPhone = normaliserTelephone(buyerWhatsapp);
  const base = Math.max(0, Math.floor(Number(saleAmount) || 0));
  if (!paymentId || !buyerPhone || !base) return;
  await prisma.clientTracker.upsert({
    where: { whatsapp: buyerPhone },
    update: {},
    create: { whatsapp: buyerPhone, name: String(buyerName || "Client").slice(0, 80) },
    select: { id: true },
  });
  const rewards = [];
  const cashback = Math.floor(base * 0.10);
  if (cashback) rewards.push({ clientWhatsapp: buyerPhone, paymentId, orderRef, saleAmount: base, type: "CASHBACK", amount: cashback, details: "Cashback de 10 % sur achat confirmé" });
  const code = String(referralCode || "").trim().toUpperCase();
  if (code) {
    const referrer = await prisma.clientTracker.findUnique({ where: { referralCode: code }, select: { whatsapp: true } });
    if (referrer && normaliserTelephone(referrer.whatsapp).slice(-8) !== buyerPhone.slice(-8)) {
      const commission = Math.floor(base * 0.20);
      if (commission) rewards.push({ clientWhatsapp: referrer.whatsapp, paymentId, orderRef, saleAmount: base, type: "REFERRAL", amount: commission, details: "Commission de parrainage de 20 %" });
    }
  }
  if (rewards.length) await prisma.rewardEntry.createMany({ data: rewards, skipDuplicates: true });
}
module.exports = { assurerCodeParrainage, enregistrerRecompensesPaiement, normaliserTelephone };
