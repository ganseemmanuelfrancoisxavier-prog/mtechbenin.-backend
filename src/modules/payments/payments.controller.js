const prisma = require("../../services/prisma");
const whatsapp = require("../../services/whatsapp");
const emailSvc = require("../../services/email");
const logger = require("../../utils/logger");
const crypto = require("crypto");
const { choisirParMontant } = require("./matching");

// ── Vérification signature FedaPay (format : "t=<ts>,s=<hmac>") ──────────────
// Retourne true si valide, false si invalide, null si pas de secret configuré
function verifyFedaPaySignature(rawBody, header, secret) {
  if (!secret) return null; // pas de secret → skip vérification (avec warning)

  if (!header || typeof header !== "string") return false;

  // Parser le header "t=1234567890,s=abcdef..."
  const parts = header.split(",").reduce((acc, item) => {
    const [k, v] = item.split("=");
    if (k === "t") acc.timestamp = parseInt(v, 10);
    if (k === "s") acc.signature = v;
    return acc;
  }, { timestamp: -1, signature: null });

  if (parts.timestamp === -1 || !parts.signature) return false;

  // Tolérance : 10 minutes (600s) pour absorber les retards Render free tier
  const age = Math.floor(Date.now() / 1000) - parts.timestamp;
  if (age > 600) {
    logger.warn("Webhook FedaPay timestamp expiré", { age, timestamp: parts.timestamp });
    return false;
  }

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.timestamp}.${payload}`, "utf8")
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parts.signature, "hex"));
  } catch {
    return false;
  }
}

// Alerte l'admin quand un paiement ne peut pas être rattaché sans deviner.
// WhatsApp d'abord, e-mail en repli : la session WhatsApp tombe, et une alerte
// perdue sur un paiement encaissé est exactement ce qu'il ne faut pas rater.
async function alerterAdmin(sujet, lignes) {
  const message = lignes.join("\n");
  let envoye = false;
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (vendorPhone) {
    envoye = await whatsapp.sendMessage(vendorPhone, message).catch(() => false);
  }
  if (!envoye) {
    await emailSvc.sendAdminAlert({ sujet, message }).catch((err) =>
      logger.error("Alerte paiement non délivrée", { err: err.message }),
    );
  }
}

async function fedapayWebhook(req, res) {
  // ── Répondre 200 IMMÉDIATEMENT ────────────────────────────────────────────
  res.status(200).json({ received: true });

  try {
    const sig = req.headers["x-fedapay-signature"] || "";
    const endpointSecret = process.env.FEDAPAY_WEBHOOK_SECRET || "";

    // ── Parse du body ─────────────────────────────────────────────────────────
    let event;
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));

    const rawStr = rawBody.toString("utf8");

    try {
      event = JSON.parse(rawStr);
    } catch (parseErr) {
      logger.warn("Body webhook FedaPay invalide — impossible de parser JSON", {
        bodyPreview: rawStr.substring(0, 200),
        err: parseErr.message,
      });
      return;
    }

    // ── Vérification signature ────────────────────────────────────────────────
    const sigResult = verifyFedaPaySignature(rawBody, sig, endpointSecret);

    if (sigResult === false) {
      // Secret configuré mais signature invalide → rejeter
      logger.warn("Signature FedaPay invalide — webhook rejeté", {
        sig: sig.substring(0, 50),
        hasSecret: !!endpointSecret,
      });
      return;
    }

    if (sigResult === null) {
      if (process.env.NODE_ENV === "production") {
        logger.error("FEDAPAY_WEBHOOK_SECRET absent en production — webhook rejeté par sécurité.");
        return;
      }
      // Pas de secret configuré (hors production) → accepter mais avertir
      logger.warn("⚠️  FEDAPAY_WEBHOOK_SECRET non configuré — webhook accepté sans vérification de signature. Configurer cette variable sur Render.");
    }

    logger.info("Webhook FedaPay reçu", {
      event: event.name,
      transactionId: event.object?.id || event.entity?.id || event.id,
      amount: event.object?.amount || event.entity?.amount || event.amount,
      sigVerified: sigResult === true,
    });

    if (event.name !== "transaction.approved") {
      logger.info("Événement ignoré (non approuvé)", { event: event.name });
      return;
    }

    // ── Extraction transaction ────────────────────────────────────────────────
    const transaction =
      event.entity || event.object || event.transaction || event.data || {};

    // On ne journalise QUE ce qui sert au diagnostic. L'objet complet contenait
    // le nom, le téléphone et l'e-mail du client, recopiés en clair dans les
    // journaux Render à chaque paiement — conservés et lisibles par quiconque a
    // accès au tableau de bord de l'hébergeur.
    logger.info("Transaction parsée", {
      id: transaction.id,
      statut: transaction.status,
      mode: transaction.mode,
      metadonnees: Object.keys(transaction.custom_metadata || {}),
    });

    const transactionId = String(
      transaction.id || transaction.reference || event.id || "unknown",
    );

    const amount =
      Number(transaction.amount) ||
      Number(transaction.amount_charged) ||
      Number(transaction.gross_amount) ||
      Number(event.amount) ||
      0;

    logger.info("Webhook FedaPay — montant et ID", { transactionId, amount });

    if (!amount || transactionId === "unknown") {
      logger.warn("Montant ou ID invalide dans le webhook — ignoré", {
        transactionId,
        amount,
        eventKeys: Object.keys(event),
        transactionKeys: Object.keys(transaction),
      });
      return;
    }

    // Anti-double traitement
    const existing = await prisma.payment.findUnique({
      where: { fedapayTxId: transactionId },
    });
    if (existing) {
      logger.info(`Webhook déjà traité : ${transactionId}`);
      return;
    }

    // ── Références depuis custom_metadata (méthode fiable) ───────────────────
    const orderRef = transaction.custom_metadata?.orderRef || null;
    const subOrderId = transaction.custom_metadata?.subOrderId || null;
    logger.info("Recherche commande", { orderRef, subOrderId, amount });

    // ── Priorité absolue à la commande produit référencée (cas le plus courant :
    // le checkout panier envoie toujours custom_metadata.orderRef) — on ne
    // retombe sur les correspondances par montant que si la référence est
    // absente ou introuvable, pour ne jamais confondre deux commandes payées
    // à quelques minutes d'écart avec un montant proche.
    let order = null;
    if (orderRef) {
      order = await prisma.order.findFirst({
        where: { reference: orderRef, status: "PENDING" },
        include: { items: true },
      });
      if (order) logger.info(`Commande trouvée par référence : ${orderRef}`);
    }

    // ── Sinon, commande abonnement — UNIQUEMENT si elle est désignée ─────────
    //
    // Cette branche retenait auparavant la commande abonnement PENDING dont le
    // montant tombait dans une fenêtre de ±500 F, sans aucune référence. Deux
    // conséquences : deux clients ayant acheté la même formule au même prix
    // étaient départagés par l'ordre de la base, et surtout `POST
    // /api/subscriptions/order` étant public, n'importe qui pouvait déposer une
    // commande PENDING au bon montant pour capter le paiement d'un autre et
    // recevoir ses identifiants. On exige désormais que la transaction désigne
    // explicitement la commande.
    const subOrder =
      !order && subOrderId
        ? await prisma.subscriptionOrder.findFirst({
            where: { id: String(subOrderId), status: "PENDING" },
          })
        : null;

    if (!order && subOrderId && !subOrder) {
      // La transaction se désigne explicitement comme un abonnement (subOrderId
      // fourni) mais aucune commande PENDING ne correspond (annulée, déjà payée,
      // ID invalide...). On s'arrête ici : retomber plus bas sur le repli par
      // montant des commandes produit rattacherait ce paiement à la commande
      // (produit) de quelqu'un d'autre. Une transaction qui se dit abonnement ne
      // doit jamais être rattachée à autre chose.
      logger.warn("subOrderId fourni mais aucune commande abonnement PENDING correspondante", {
        subOrderId,
        transactionId,
      });
      return;
    }

    if (subOrder) {
      logger.info(`Paiement abonnement détecté : ${subOrder.id}`);
      await prisma.payment.create({
        data: {
          fedapayTxId: transactionId,
          amount,
          method: transaction.mode || "MOBILE_MONEY",
          status: "CONFIRMED",
          paidAt: new Date(transaction.approved_at || new Date()),
          rawData: event,
          subOrderId: subOrder.id,
        },
      });
      const { assignSubscriptionAfterPayment } = require("../subscriptions/subscriptions.controller");
      await assignSubscriptionAfterPayment(subOrder.id);
      logger.info(`✅ Abonnement ${subOrder.id} traité via webhook`);
      return;
    }

    // ── Réparation — UNIQUEMENT si la transaction la désigne ────────────────────
    //
    // Aucun repli par montant, jamais. La branche abonnements en avait un : elle
    // retenait la commande PENDING dont le montant tombait à ±500 F près, ce qui
    // permettait à quiconque de déposer une commande au bon montant pour capter le
    // paiement d'un autre. On ne rouvre pas ce trou pour les réparations.
    const repairRef = transaction.custom_metadata?.repairRef || null;
    const repair =
      !order && !subOrder && repairRef
        ? await prisma.repairOrder.findFirst({
            where: { reference: String(repairRef), status: "EN_ATTENTE" },
          })
        : null;

    if (!order && !subOrder && repairRef && !repair) {
      // Même règle que pour subOrderId juste au-dessus : la transaction se
      // désigne explicitement comme une réparation (repairRef fourni) mais
      // aucune réparation EN_ATTENTE ne correspond (annulée, avancée à la main,
      // référence invalide...). On s'arrête ici plutôt que de laisser tomber le
      // code plus bas dans le repli par montant des commandes produit, qui
      // confirmerait la commande d'un inconnu — stock décrémenté, abonnements
      // attribués — pour un paiement qui n'est pas le sien.
      logger.warn("repairRef fourni mais aucune réparation EN_ATTENTE correspondante", {
        repairRef, transactionId,
      });
      return;
    }

    if (repair) {
      await prisma.payment.create({
        data: {
          fedapayTxId: transactionId,
          amount,
          method: transaction.mode || "MOBILE_MONEY",
          status: "CONFIRMED",
          paidAt: new Date(transaction.approved_at || new Date()),
          rawData: event,
          repairOrderId: repair.id,
        },
      });
      const { confirmerReparationApresPaiement } = require("../repairs/repairs.controller");
      await confirmerReparationApresPaiement(repair.id);
      logger.info(`✅ Réparation ${repair.reference} confirmée via webhook`);
      return;
    }

    // ── Commande produit non trouvée par référence — fallback par montant le
    // plus proche (commandes sans custom_metadata) ───────────────────────────
    // Ce repli ne sert qu'aux paiements sans métadonnées (anciens widgets). Il
    // refuse maintenant de départager des candidats à égalité de montant.
    if (!order) {
      const candidates = await prisma.order.findMany({
        where: { status: "PENDING", total: { gte: amount - 500, lte: amount + 500 } },
        include: { items: true },
      });
      const choix = choisirParMontant(candidates, amount, (o) => o.total);
      order = choix.candidat;

      if (order) {
        logger.info(`Commande trouvée par montant : ${order.reference}`);
      } else if (choix.raison === "ambigu") {
        logger.error("Paiement non rattaché — plusieurs commandes au même montant", {
          transactionId,
          amount,
          exAequo: choix.exAequo,
        });
        await alerterAdmin(`Paiement ${amount} F non rattaché — commandes indiscernables`, [
          `⚠️ *Paiement encaissé, commande non identifiée*`,
          ``,
          `Transaction : ${transactionId}`,
          `Montant : *${amount} FCFA*`,
          ``,
          `${choix.exAequo} commandes en attente ont exactement ce montant.`,
          `Impossible de savoir laquelle a été payée sans deviner.`,
          ``,
          `➡️ Confirmez la bonne commande à la main dans le panel.`,
        ]);
        return;
      }
    }

    if (!order) {
      logger.warn("Aucune commande PENDING trouvée pour ce paiement", {
        transactionId,
        amount,
        orderRef,
      });
      await alerterAdmin(`Paiement ${amount} F sans commande correspondante`, [
        `⚠️ *Paiement encaissé, aucune commande en attente*`,
        ``,
        `Transaction : ${transactionId}`,
        `Montant : *${amount} FCFA*`,
        orderRef ? `Référence annoncée : ${orderRef}` : `Aucune référence transmise`,
        ``,
        `➡️ À rapprocher manuellement dans le panel.`,
      ]);
      return;
    }

    const payment = await prisma.payment.create({
      data: {
        fedapayTxId: transactionId,
        amount,
        method: transaction.mode || "MOBILE_MONEY",
        status: "CONFIRMED",
        paidAt: new Date(transaction.approved_at || new Date()),
        rawData: event,
        orderId: order.id,
      },
    });

    await prisma.order.update({
      where: { id: order.id },
      data: { status: "CONFIRMED", paymentId: payment.id },
    });

    if (order.couponCode) {
      await prisma.coupon
        .update({
          where: { code: order.couponCode },
          data: { usedCount: { increment: 1 } },
        })
        .catch((err) => logger.warn("Mise à jour coupon échouée", { code: order.couponCode, err: err.message }));
    }

    for (const item of order.items) {
      if (item.productSlug?.startsWith("abonnement-")) continue;
      try {
        // updateMany + condition stock>=quantity : décrémente uniquement s'il
        // reste assez de stock, pour ne jamais passer en négatif si deux
        // commandes du dernier exemplaire sont confirmées presque en même temps.
        const result = await prisma.product.updateMany({
          where: { slug: item.productSlug, stock: { gte: item.quantity } },
          data: { salesCount: { increment: item.quantity }, stock: { decrement: item.quantity } },
        });
        if (result.count === 0) {
          logger.warn("Stock insuffisant au moment de la confirmation — décrément ignoré", {
            slug: item.productSlug,
            quantity: item.quantity,
            orderRef: order.reference,
          });
        }
      } catch (err) {
        logger.warn("Mise à jour stock échouée", { slug: item.productSlug, err: err.message });
      }
    }

    await upsertClientTracker(order);

    logger.info("Envoi notifications WhatsApp + Email", {
      clientWhatsapp: order.guestWhatsapp,
      vendorPhone: process.env.VENDOR_WHATSAPP_NUMBER,
      clientEmail: order.guestEmail,
    });

    const notifLabels = ["WA client", "Email client", "WA admin", "Email admin"];
    const notifResults = await Promise.allSettled([
      whatsapp.sendOrderConfirmToClient(order),
      emailSvc.sendOrderConfirmToClient({ order }),
      whatsapp.sendNewOrderToAdmin({ ...order, items: order.items }),
      emailSvc.sendOrderNotifToAdmin({ order }),
    ]);
    notifResults.forEach((r, i) => {
      if (r.status === "rejected")
        logger.warn(`Notification échouée : ${notifLabels[i]}`, { err: r.reason?.message });
      else
        logger.info(`Notification envoyée : ${notifLabels[i]}`, { value: r.value });
    });

    for (const item of order.items) {
      const product = await prisma.product
        .findUnique({ where: { slug: item.productSlug } })
        .catch(() => null);
      if (product && product.stock <= 3) {
        await whatsapp.sendLowStockAlert({ productName: product.name, stock: product.stock });
      }
    }

    // ── Items abonnement : attribution credentials (avec gestion cadeau) ────────
    const subscriptionItems = order.items.filter((item) =>
      item.productSlug.startsWith("abonnement-"),
    );
    if (subscriptionItems.length > 0) {
      const { assignSubscriptionFromOrderItem } = require("../subscriptions/subscriptions.controller");
      for (const item of subscriptionItems) {
        const planId = item.productSlug.replace("abonnement-", "");
        await assignSubscriptionFromOrderItem({ planId, order }).catch((err) =>
          logger.warn("Erreur assignation abonnement item", {
            planId,
            err: err.message,
          }),
        );
      }
    }

    logger.info(`✅ Commande ${order.reference} confirmée via webhook`);
  } catch (err) {
    logger.error("Erreur traitement webhook FedaPay", {
      err: err.message,
      stack: err.stack,
    });
  }
}

async function upsertClientTracker(order) {
  try {
    const existing = await prisma.clientTracker.findUnique({
      where: { whatsapp: order.guestWhatsapp },
    });
    const newPoints = (existing?.points || 0) + Math.floor(order.total / 100);
    const tier =
      newPoints >= 15001 ? "gold" : newPoints >= 5001 ? "silver" : "bronze";

    await prisma.clientTracker.upsert({
      where: { whatsapp: order.guestWhatsapp },
      create: {
        whatsapp: order.guestWhatsapp,
        name: order.guestName,
        city: order.city || "",
        totalOrders: 1,
        totalSpent: order.total,
        points: Math.floor(order.total / 100),
        tier,
      },
      update: {
        name: order.guestName,
        totalOrders: { increment: 1 },
        totalSpent: { increment: order.total },
        points: { increment: Math.floor(order.total / 100) },
        tier,
        lastOrderAt: new Date(),
      },
    });
  } catch (err) {
    logger.error("Erreur upsert ClientTracker", { err: err.message });
  }
}

module.exports = { fedapayWebhook };
