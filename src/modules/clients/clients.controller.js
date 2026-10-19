const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

async function getClients(req, res) {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { whatsapp: { contains: search } },
          ],
        }
      : {};

    const [clients, total] = await Promise.all([
      prisma.clientTracker.findMany({
        where,
        orderBy: { lastOrderAt: "desc" },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.clientTracker.count({ where }),
    ]);

    // ── Fallback — si ClientTracker vide, construit depuis les commandes ──────
    if (clients.length === 0) {
      const orderWhere = search
        ? {
            OR: [
              { guestName: { contains: search, mode: "insensitive" } },
              { guestWhatsapp: { contains: search } },
            ],
          }
        : {};

      const orders = await prisma.order.findMany({
        where: { ...orderWhere, status: { not: "CANCELLED" } },
        orderBy: { createdAt: "desc" },
        select: {
          guestName: true,
          guestWhatsapp: true,
          guestEmail: true,
          city: true,
          total: true,
          createdAt: true,
        },
      });

      // Déduplique par whatsapp et agrège
      const clientMap = {};
      for (const o of orders) {
        const key = o.guestWhatsapp || o.guestName;
        if (!key) continue;
        if (!clientMap[key]) {
          clientMap[key] = {
            id: key,
            whatsapp: o.guestWhatsapp || "",
            name: o.guestName || "Client",
            email: o.guestEmail || "",
            city: o.city || "",
            totalOrders: 0,
            totalSpent: 0,
            points: 0,
            tier: "bronze",
            createdAt: o.createdAt,
            lastOrderAt: o.createdAt,
          };
        }
        clientMap[key].totalOrders += 1;
        clientMap[key].totalSpent += o.total || 0;
        clientMap[key].points = Math.floor(clientMap[key].totalSpent / 100);
        if (o.createdAt > clientMap[key].lastOrderAt) {
          clientMap[key].lastOrderAt = o.createdAt;
        }
      }

      // Calcule le tier
      const fallbackClients = Object.values(clientMap).map((c) => ({
        ...c,
        tier:
          c.points >= 15001 ? "gold" : c.points >= 5001 ? "silver" : "bronze",
      }));

      // Pagination manuelle
      const skip = (Number(page) - 1) * Number(limit);
      const paged = fallbackClients.slice(skip, skip + Number(limit));

      return res.json({
        clients: paged,
        total: fallbackClients.length,
        page: Number(page),
        limit: Number(limit),
      });
    }

    return res.json({
      clients,
      total,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) {
    logger.error("Erreur getClients", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getClientByWhatsapp(req, res) {
  try {
    const client = await prisma.clientTracker.findUnique({
      where: { whatsapp: req.params.whatsapp },
    });
    if (!client) return res.status(404).json({ error: "Client introuvable" });
    return res.json({ client });
  } catch (err) {
    logger.error("Erreur getClientByWhatsapp", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function upsertClient(whatsapp, name, city, amount) {
  try {
    const existing = await prisma.clientTracker.findUnique({
      where: { whatsapp },
    });
    if (existing) {
      const totalSpent = existing.totalSpent + amount;
      const totalOrders = existing.totalOrders + 1;
      const points = existing.points + Math.floor(amount / 100);
      const tier =
        points >= 15001 ? "gold" : points >= 5001 ? "silver" : "bronze";
      await prisma.clientTracker.update({
        where: { whatsapp },
        data: {
          name,
          totalOrders,
          totalSpent,
          points,
          tier,
          lastOrderAt: new Date(),
        },
      });
    } else {
      const points = Math.floor(amount / 100);
      await prisma.clientTracker.create({
        data: {
          whatsapp,
          name,
          city: city || "",
          totalOrders: 1,
          totalSpent: amount,
          points,
          tier: "bronze",
        },
      });
    }
  } catch (err) {
    logger.error("Erreur upsertClient", { err: err.message });
  }
}

module.exports = { getClients, getClientByWhatsapp, upsertClient };
