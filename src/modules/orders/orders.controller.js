const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");
const whatsapp = require("../../services/whatsapp");
const { upsertClient } = require("../clients/clients.controller");
const { incrementUsed } = require("../coupons/coupons.controller");
const { computeUnitPrice } = require("../products/pricing");
const { periodesAutorisees } = require("../subscriptions/duree");
const { generateOrderRef } = require("../../utils/generateRef");

// Le prix payé ne doit jamais dépendre de ce que le client envoie : on ne
// fait confiance qu'aux quantités/choix (produit, formule, coupon, ville) et
// on recalcule subtotal/discount/deliveryFee/feeAmount/total côté serveur en
// reproduisant exactement la formule du frontend (CheckoutPage.js).
async function buildValidatedItems(items) {
  const validated = [];
  for (const item of items || []) {
    const quantity = Number(item.quantity);
    if (!item.productSlug || !Number.isInteger(quantity) || quantity <= 0) {
      throw new OrderValidationError(`Article invalide : ${item.productSlug || "?"}`);
    }

    let unitPrice;
    if (item.productSlug.startsWith("abonnement-")) {
      const planId = item.productSlug.replace("abonnement-", "");
      const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
      if (!plan) throw new OrderValidationError(`Formule introuvable : ${item.productSlug}`);

      // Le prix affiché = plan.price × multiplicateur de durée (1 à 12 mois),
      // choisi côté client mais jamais transmis tel quel : on le retrouve en
      // divisant le prix envoyé par le prix de base, et on vérifie que ça tombe
      // juste sur un multiplicateur entier plausible.
      //
      // Le plafond vient de la formule : une formule à vie n'en autorise qu'UN.
      // Le panier est construit côté navigateur, où le sélecteur de durée est
      // simplement masqué pour ces formules — un panier fabriqué à la main
      // ferait sinon payer deux fois le même accès définitif.
      const claimedUnitPrice = Number(item.unitPrice);
      const multiplier = Math.round(claimedUnitPrice / plan.price);
      if (
        !Number.isInteger(multiplier) ||
        multiplier < 1 ||
        multiplier > periodesAutorisees(plan) ||
        multiplier * plan.price !== claimedUnitPrice
      ) {
        throw new OrderValidationError(`Prix invalide pour ${item.productSlug}`);
      }
      unitPrice = claimedUnitPrice;
    } else {
      const product = await prisma.product.findUnique({
        where: { slug: item.productSlug },
        include: {
          variantTypes: {
            orderBy: { sortOrder: "asc" },
            include: { options: { orderBy: { sortOrder: "asc" } } },
          },
        },
      });
      if (!product || !product.active) {
        throw new OrderValidationError(`Produit introuvable : ${item.productSlug}`);
      }
      if (product.stock < quantity) {
        throw new OrderValidationError(`Stock insuffisant pour ${product.name}`);
      }

      // Le prix vient du serveur, jamais du navigateur : sans ce recalcul, un
      // client pourrait choisir « 256 Go » et payer le tarif du 64 Go.
      const calcul = computeUnitPrice({
        basePrice: product.price,
        variantTypes: product.variantTypes,
        selected: item.variants,
      });
      if (!calcul.ok) {
        throw new OrderValidationError(`${product.name} — ${calcul.erreur}`);
      }

      // Le prix annoncé par le navigateur ne sert qu'à détecter un désaccord
      // avec le serveur (ex : prix modifié côté admin pendant que la page
      // était restée ouverte) — jamais à fixer le montant facturé, qui reste
      // `calcul.unitPrice`. Une valeur absente ou non numérique est une
      // donnée manquante, pas une égalité fortuite qu'on laisserait passer.
      const prixAnnonce = Number(item.unitPrice);
      if (!Number.isFinite(prixAnnonce)) {
        // Journalisé : un panier sans prix annoncé exploitable (champ absent,
        // NaN) est soit un bug côté client, soit un désaccord entre les deux
        // copies du calcul de prix — un refus muet masquerait une chute de
        // ventes silencieuse.
        logger.warn("Commande refusée — prix annoncé manquant", {
          productSlug: product.slug,
          prixAnnonce: item.unitPrice,
          prixRecalcule: calcul.unitPrice,
        });
        throw new OrderValidationError(`Prix manquant pour ${product.name}`);
      }
      if (prixAnnonce !== calcul.unitPrice) {
        logger.warn("Commande refusée — prix annoncé divergent", {
          productSlug: product.slug,
          prixAnnonce,
          prixRecalcule: calcul.unitPrice,
        });
        throw new OrderValidationError(
          `Le prix de ${product.name} a changé, veuillez rafraîchir la page`
        );
      }

      unitPrice = calcul.unitPrice;
    }

    validated.push({
      productSlug: item.productSlug,
      productName: item.productName,
      quantity,
      unitPrice,
      totalPrice: unitPrice * quantity,
      variants: Array.isArray(item.variants) && item.variants.length ? item.variants : [],
    });
  }
  return validated;
}

class OrderValidationError extends Error {}

async function computeValidatedCoupon(couponCode, subtotal) {
  if (!couponCode) return { code: null, discount: 0 };
  const coupon = await prisma.coupon.findUnique({
    where: { code: String(couponCode).toUpperCase().trim() },
  });
  const now = new Date();
  const valid =
    coupon &&
    coupon.active &&
    (!coupon.expiresAt || new Date(coupon.expiresAt) >= now) &&
    (!coupon.maxUses || coupon.usedCount < coupon.maxUses) &&
    subtotal >= coupon.minOrder;
  if (!valid) return { code: null, discount: 0 };

  const discount =
    coupon.type === "PERCENTAGE"
      ? Math.round((subtotal * coupon.value) / 100)
      : Math.min(coupon.value, subtotal);
  return { code: coupon.code, discount };
}

async function computeDeliveryFee(hasPhysicalProduct, city) {
  if (!hasPhysicalProduct || !city) return 0;
  const zone = await prisma.deliveryZone.findFirst({
    where: { active: true, name: { equals: city, mode: "insensitive" } },
  });
  return zone ? zone.fee : 0;
}

async function computeFeeRate() {
  const setting = await prisma.setting.findUnique({ where: { key: "paymentFeePercent" } });
  const percent = parseFloat(setting?.value);
  return (Number.isFinite(percent) ? percent : 0) / 100;
}

async function createOrder(req, res) {
  try {
    const {
      guestName,
      guestWhatsapp,
      guestEmail,
      city,
      neighborhood,
      instructions,
      deliverySlot,
      deliveryLat,
      deliveryLng,
      isGift,
      giftName,
      giftWhatsapp,
      couponCode,
      items,
    } = req.body;

    // `reference` n'est plus lue depuis le corps de la requête : elle était
    // fabriquée par le navigateur (`Math.random()` sur 5 chiffres) et le
    // serveur l'enregistrait telle quelle. Elle est désormais tirée ici, d'une
    // source cryptographique — voir utils/generateRef.js.
    if (!guestName || !guestWhatsapp || !items?.length) {
      return res.status(400).json({ error: "Données manquantes" });
    }
    if (!guestEmail || !String(guestEmail).includes("@")) {
      return res.status(400).json({ error: "Email valide requis" });
    }

    let validatedItems;
    try {
      validatedItems = await buildValidatedItems(items);
    } catch (err) {
      if (err instanceof OrderValidationError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const subtotal = validatedItems.reduce((sum, i) => sum + i.totalPrice, 0);
    const { code: validatedCouponCode, discount } = await computeValidatedCoupon(couponCode, subtotal);
    const hasPhysicalProduct = validatedItems.some((i) => !i.productSlug.startsWith("abonnement-"));
    const deliveryFee = await computeDeliveryFee(hasPhysicalProduct, city);
    const afterCoupon = subtotal - discount;
    const baseTotal = afterCoupon + deliveryFee;
    const feeRate = await computeFeeRate();
    const feeAmount = Math.ceil(baseTotal * feeRate);
    const total = baseTotal + feeAmount;

    const order = await prisma.order.create({
      data: {
        reference: generateOrderRef(),
        guestName,
        guestWhatsapp,
        guestEmail: guestEmail || null,
        city,
        neighborhood: neighborhood || null,
        instructions: instructions || null,
        deliverySlot: deliverySlot || null,
        deliveryLat: deliveryLat || null,
        deliveryLng: deliveryLng || null,
        isGift: isGift || false,
        giftName: giftName || null,
        giftWhatsapp: giftWhatsapp || null,
        subtotal,
        discount,
        deliveryFee,
        feeAmount,
        total,
        couponCode: validatedCouponCode,
        status: "PENDING",
        items: { create: validatedItems },
      },
      include: { items: true },
    });

    return res.status(201).json({ order });
  } catch (err) {
    logger.error("Erreur createOrder", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getOrderByRef(req, res) {
  try {
    const order = await prisma.order.findUnique({
      where: { reference: req.params.ref },
      include: {
        items: true,
        payment: { select: { fedapayTxId: true, amount: true, method: true, status: true, paidAt: true } },
      },
    });
    if (!order) return res.status(404).json({ error: "Commande introuvable" });
    return res.json({ order });
  } catch (err) {
    logger.error("Erreur getOrderByRef", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getAllOrders(req, res) {
  try {
    const { status, search } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    // Plafond de sécurité : il borne ce qu'un appelant peut demander, quelle que
    // soit la valeur envoyée. Le panel admin charge la liste en une fois — il
    // doit donc rester au-dessus du nombre réel de commandes, sinon les plus
    // anciennes disparaissent de l'écran sans aucune erreur.
    const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 20));

    const where = {};
    if (status) where.status = status.toUpperCase();
    if (search)
      where.OR = [
        { reference: { contains: search, mode: "insensitive" } },
        { guestName: { contains: search, mode: "insensitive" } },
        { guestWhatsapp: { contains: search } },
      ];

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          items: true,
          payment: { select: { fedapayTxId: true, amount: true, method: true, status: true, paidAt: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.order.count({ where }),
    ]);

    return res.json({ orders, total, page, limit });
  } catch (err) {
    logger.error("Erreur getAllOrders", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

const VALID_STATUSES = ["PENDING", "CONFIRMED", "PREPARING", "SHIPPED", "DELIVERED", "CANCELLED"];

async function updateStatus(req, res) {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "Statut requis" });
    const normalized = status.toUpperCase();
    if (!VALID_STATUSES.includes(normalized)) {
      return res.status(400).json({ error: `Statut invalide. Valeurs acceptées : ${VALID_STATUSES.join(", ")}` });
    }

    const order = await prisma.order.update({
      where: { reference: req.params.ref },
      data: { status: normalized },
      include: { items: true },
    });

    // Notif WhatsApp client si statut important
    const notifStatuses = ["CONFIRMED", "PREPARING", "SHIPPED", "DELIVERED"];
    if (notifStatuses.includes(normalized)) {
      const labels = {
        CONFIRMED: "✅ Paiement confirmé — votre commande est bien enregistrée.",
        PREPARING: "📦 En cours de préparation — nous préparons votre colis.",
        SHIPPED:   "🚚 En route — votre colis est en cours de livraison.",
        DELIVERED: "🎉 Livrée — profitez bien de votre commande !",
      };
      await whatsapp
        .sendStatusUpdateToClient(order, labels[normalized])
        .catch((err) => logger.warn("Notif WhatsApp statut échouée", { ref: order.reference, err: err.message }));
    }

    // Si livrée → upsert client CRM
    if (normalized === "DELIVERED") {
      await upsertClient(
        order.guestWhatsapp,
        order.guestName,
        order.city,
        order.total,
      );
    }

    return res.json({ order });
  } catch (err) {
    logger.error("Erreur updateStatus", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

module.exports = { createOrder, getOrderByRef, getAllOrders, updateStatus };
