const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const prisma = require("../../services/prisma");
const redis = require("../../services/redis");
const whatsapp = require("../../services/whatsapp");
const email = require("../../services/email");
const logger = require("../../utils/logger");

const CODE_TTL_SECONDS = 5 * 60;
const CODE_COOLDOWN_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const codeKey = (phone) => `otp:client-account:${phone}`;
const cooldownKey = (phone) => `otp:client-account:cooldown:${phone}`;
const refreshKey = (sid) => `refresh:client:${sid}`;
const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

function normaliserTelephone(value) {
  const phone = String(value || "").replace(/\D/g, "");
  return phone.length >= 8 && phone.length <= 15 ? phone : null;
}

function lireCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}

function setRefreshCookie(res, token) {
  res.cookie("clientRefreshToken", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/client-account",
    maxAge: REFRESH_TTL_SECONDS * 1000,
  });
}

async function creerSession(res, client) {
  const accessToken = jwt.sign(
    { role: "CLIENT", whatsapp: client.whatsapp, name: client.name },
    process.env.JWT_SECRET,
    { expiresIn: "15m" },
  );
  const sid = crypto.randomUUID();
  const refreshToken = jwt.sign(
    { role: "CLIENT", type: "refresh", sid, whatsapp: client.whatsapp, name: client.name },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "30d" },
  );
  await redis.set(refreshKey(sid), refreshToken, { ex: REFRESH_TTL_SECONDS });
  setRefreshCookie(res, refreshToken);
  return accessToken;
}

async function demanderCode(req, res) {
  try {
    const name = String(req.body?.name || "").trim().replace(/\s+/g, " ");
    const whatsappNumber = normaliserTelephone(req.body?.whatsapp);
    const clientEmail = String(req.body?.email || "").trim().toLowerCase();
    if (name.length < 2 || name.length > 80 || !whatsappNumber) {
      return res.status(400).json({ error: "Renseignez votre nom et un numéro WhatsApp valide avec son indicatif." });
    }
    if (clientEmail && (clientEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail))) {
      return res.status(400).json({ error: "Adresse e-mail invalide." });
    }
    if (await redis.get(cooldownKey(whatsappNumber))) {
      return res.status(429).json({ error: "Attendez une minute avant de demander un nouveau code." });
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    await redis.set(codeKey(whatsappNumber), JSON.stringify({
      hash: hashCode(code), name, email: clientEmail || null, attempts: 0,
    }), { ex: CODE_TTL_SECONDS });
    await redis.set(cooldownKey(whatsappNumber), "1", { ex: CODE_COOLDOWN_SECONDS });

    let sent = await whatsapp.sendMessage(
      whatsappNumber,
      `Votre code de création de compte MTECHBENIN est : ${code}. Il expire dans 5 minutes. Ne le partagez avec personne.`,
    );
    let channel = "WhatsApp";
    if (!sent && clientEmail) {
      sent = await email.sendOTPToClient({
        clientEmail, clientName: name, serviceName: "votre compte MTECHBENIN", otpCode: code,
      });
      channel = "e-mail";
    }
    if (!sent) {
      await redis.del(codeKey(whatsappNumber));
      return res.status(503).json({
        error: clientEmail
          ? "Le code n’a pas pu être envoyé. Réessayez plus tard."
          : "WhatsApp est momentanément indisponible. Ajoutez un e-mail ou réessayez plus tard.",
      });
    }
    return res.json({ message: `Code envoyé par ${channel}.` });
  } catch (err) {
    logger.error("Erreur demande code compte client", { err: err.message });
    return res.status(500).json({ error: "Impossible d’envoyer le code pour le moment." });
  }
}

async function verifierCode(req, res) {
  try {
    const whatsappNumber = normaliserTelephone(req.body?.whatsapp);
    const code = String(req.body?.code || "").replace(/\s/g, "");
    if (!whatsappNumber || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Numéro ou code invalide." });
    }
    const key = codeKey(whatsappNumber);
    const raw = await redis.get(key);
    if (!raw) return res.status(400).json({ error: "Code expiré. Demandez-en un nouveau." });

    const challenge = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
      await redis.del(key);
      return res.status(429).json({ error: "Trop de tentatives. Demandez un nouveau code." });
    }
    const candidateHash = Buffer.from(hashCode(code));
    const storedHash = Buffer.from(String(challenge.hash || ""));
    const valid = candidateHash.length === storedHash.length && crypto.timingSafeEqual(candidateHash, storedHash);
    if (!valid) {
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_CODE_ATTEMPTS) await redis.del(key);
      else await redis.set(key, JSON.stringify(challenge), { ex: CODE_TTL_SECONDS });
      return res.status(400).json({ error: "Code incorrect." });
    }

    await redis.del(key);
    const client = await prisma.clientTracker.upsert({
      where: { whatsapp: whatsappNumber },
      update: { name: challenge.name, accountCreatedAt: new Date() },
      create: { whatsapp: whatsappNumber, name: challenge.name, accountCreatedAt: new Date() },
      select: { whatsapp: true, name: true, totalOrders: true, totalSpent: true, points: true, tier: true },
    });
    const accessToken = await creerSession(res, client);
    return res.json({ accessToken, client });
  } catch (err) {
    logger.error("Erreur vérification compte client", { err: err.message });
    return res.status(500).json({ error: "Impossible de valider le code pour le moment." });
  }
}

function signerRefresh(req, res, decoded) {
  const token = jwt.sign(
    { role: "CLIENT", type: "refresh", sid: decoded.sid, whatsapp: decoded.whatsapp, name: decoded.name },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "30d" },
  );
  return redis.set(refreshKey(decoded.sid), token, { ex: REFRESH_TTL_SECONDS }).then(() => {
    setRefreshCookie(res, token);
    return jwt.sign(
      { role: "CLIENT", whatsapp: decoded.whatsapp, name: decoded.name },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );
  });
}

async function refresh(req, res) {
  try {
    const token = lireCookie(req, "clientRefreshToken");
    if (!token) return res.status(401).json({ error: "Session expirée." });
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET, { algorithms: ["HS256"] });
    if (decoded.role !== "CLIENT" || decoded.type !== "refresh" || !decoded.sid) {
      return res.status(401).json({ error: "Session invalide." });
    }
    if (await redis.get(refreshKey(decoded.sid)) !== token) {
      return res.status(401).json({ error: "Session expirée." });
    }
    const accessToken = await signerRefresh(req, res, decoded);
    return res.json({ accessToken, client: { whatsapp: decoded.whatsapp, name: decoded.name } });
  } catch {
    return res.status(401).json({ error: "Session invalide ou expirée." });
  }
}

async function logout(req, res) {
  const token = lireCookie(req, "clientRefreshToken");
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      if (decoded.sid) await redis.del(refreshKey(decoded.sid));
    } catch { /* Session déjà expirée. */ }
  }
  res.clearCookie("clientRefreshToken", {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax", path: "/api/client-account",
  });
  return res.json({ message: "Déconnecté." });
}

async function getMe(req, res) {
  await prisma.clientTracker.updateMany({ where: { whatsapp: req.client.whatsapp, accountCreatedAt: null }, data: { accountCreatedAt: new Date() } });
  const client = await prisma.clientTracker.findUnique({
    where: { whatsapp: req.client.whatsapp },
    select: { whatsapp: true, name: true, totalOrders: true, totalSpent: true, points: true, tier: true },
  });
  if (!client) return res.status(404).json({ error: "Compte introuvable." });
  return res.json({ client });
}

async function getOrders(req, res) {
  try {
    const phone = req.client.whatsapp;
    const suffix = phone.slice(-8);
    const [orders, subscriptions] = await Promise.all([
      prisma.order.findMany({
        where: { guestWhatsapp: { contains: suffix } },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { reference: true, status: true, total: true, createdAt: true, items: { select: { productName: true, quantity: true } }, guestWhatsapp: true },
      }),
      prisma.subscriptionOrder.findMany({
        where: { clientWhatsapp: { contains: suffix } },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { id: true, status: true, amount: true, createdAt: true, expiresAt: true, clientWhatsapp: true, service: { select: { name: true } }, plan: { select: { label: true } } },
      }),
    ]);
    const normalise = normaliserTelephone;
    return res.json({
      orders: orders.filter((order) => normalise(order.guestWhatsapp) === phone),
      subscriptions: subscriptions
        .filter((order) => normalise(order.clientWhatsapp) === phone)
        .map(({ clientWhatsapp, ...order }) => order),
    });
  } catch (err) {
    logger.error("Erreur chargement commandes client", { err: err.message });
    return res.status(500).json({ error: "Impossible de charger les commandes." });
  }
}

module.exports = { demanderCode, verifierCode, refresh, logout, getMe, getOrders };
