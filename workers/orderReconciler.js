// ─────────────────────────────────────────────────────────────────────────────
// Réconciliation des commandes d'abonnement.
//
// Un abonnement peut être acheté par deux chemins :
//   • directement           → crée une SubscriptionOrder (le bot OTP la voit)
//   • via le panier         → crée une Order + OrderItem "abonnement-<planId>"
//
// Le second chemin ne produisait une SubscriptionOrder que pour les services
// "family" : tous les achats link_access (Spotify, Apple Music, Canva, ChatGPT)
// restaient invisibles pour le bot, et leurs OTP finissaient orphelins. Une
// conversion pouvait aussi échouer silencieusement (le .catch se contentait
// d'un warning).
//
// Ce module rend le bot indépendant de ce point de fragilité : il reconstruit
// les SubscriptionOrder manquantes à partir des commandes réellement payées.
// L'opération est idempotente grâce à la clé unique (sourceOrderRef, planId).
// ─────────────────────────────────────────────────────────────────────────────

const prisma = require("../src/services/prisma");
const logger = require("../src/utils/logger");
const { estAVie } = require("../src/modules/subscriptions/duree");
// Mêmes fonctions pures que `assignSubscriptionFromOrderItem`
// (src/modules/subscriptions/subscriptions.controller.js) et que
// `scripts/backfill-expiration.js` : on les réutilise telles quelles plutôt
// que de redévelopper leurs contrôles (prix qui ne tombe pas juste,
// multiplicateur hors de 1 à 12, durée invalide, entrée illisible...).
const { moisAchetes, dateExpiration } = require("./subscriptionExpiry");

// Statuts d'une commande panier considérés comme payés.
// PENDING et CANCELLED sont volontairement exclus : pas d'abonnement dû.
const PAID_ORDER_STATUSES = ["CONFIRMED", "PREPARING", "SHIPPED", "DELIVERED"];

const SUB_SLUG_PREFIX = "abonnement-";

// Fenêtre de tolérance pour rapprocher une SubscriptionOrder d'avant
// sourceOrderRef de la commande panier qui l'a produite.
const LEGACY_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

function isLegacyMatch(candidate, { planId, whatsapp, orderDate }) {
  return (
    candidate.planId === planId &&
    candidate.clientWhatsapp === whatsapp &&
    Math.abs(candidate.createdAt.getTime() - orderDate.getTime()) <= LEGACY_MATCH_WINDOW_MS
  );
}

/**
 * Reconstruit les SubscriptionOrder manquantes.
 * @param {{ dryRun?: boolean }} opts
 * @returns {Promise<{created:number, linked:number, skipped:number, errors:number, details:Array}>}
 */
// Tout est lu en lots puis résolu en mémoire. Une version requête-par-item
// prenait ~27 s sur la base distante (une centaine d'allers-retours) — beaucoup
// trop, puisque le bot attend cette réconciliation avant de router un code.
async function reconcileSubscriptionOrders({ dryRun = false } = {}) {
  const stats = { created: 0, linked: 0, skipped: 0, errors: 0, details: [] };

  const orders = await prisma.order.findMany({
    where: {
      status: { in: PAID_ORDER_STATUSES },
      items: { some: { productSlug: { startsWith: SUB_SLUG_PREFIX } } },
    },
    include: { items: true },
    orderBy: { createdAt: "asc" },
  });

  // ── Aplatit en couples (commande, item d'abonnement) ──────────────────────
  const pairs = [];
  for (const order of orders) {
    for (const item of order.items) {
      if (!item.productSlug.startsWith(SUB_SLUG_PREFIX)) continue;
      pairs.push({ order, item, planId: item.productSlug.slice(SUB_SLUG_PREFIX.length) });
    }
  }
  if (pairs.length === 0) return stats;

  const refs = [...new Set(pairs.map((p) => p.order.reference).filter(Boolean))];
  const planIds = [...new Set(pairs.map((p) => p.planId))];

  // ── Trois lectures groupées, au lieu d'une par item ───────────────────────
  const [alreadyDone, plans, legacyPool] = await Promise.all([
    prisma.subscriptionOrder.findMany({
      where: { sourceOrderRef: { in: refs } },
      select: { sourceOrderRef: true, planId: true },
    }),
    prisma.subscriptionPlan.findMany({
      where: { id: { in: planIds } },
      select: { id: true, serviceId: true, price: true, duration: true, aVie: true },
    }),
    prisma.subscriptionOrder.findMany({
      where: { sourceOrderRef: null, planId: { in: planIds } },
      select: { id: true, planId: true, clientWhatsapp: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const doneKeys = new Set(alreadyDone.map((d) => `${d.sourceOrderRef}|${d.planId}`));
  const planMap = new Map(plans.map((p) => [p.id, p]));
  const claimedLegacy = new Set();

  const toLink = [];
  const toCreate = [];

  for (const { order, item, planId } of pairs) {
    const key = `${order.reference}|${planId}`;
    if (doneKeys.has(key)) {
      stats.skipped += 1;
      continue;
    }

    const plan = planMap.get(planId);
    if (!plan) {
      // Le plan a été supprimé depuis l'achat : on ne peut rien reconstruire.
      stats.errors += 1;
      stats.details.push({ ref: order.reference, planId, action: "plan-introuvable" });
      continue;
    }

    // Une SubscriptionOrder d'avant sourceOrderRef correspond-elle ? On
    // l'adopte plutôt que d'en créer une seconde. `claimedLegacy` évite que
    // deux items différents revendiquent la même ligne.
    const legacy = legacyPool.find(
      (c) =>
        !claimedLegacy.has(c.id) &&
        isLegacyMatch(c, {
          planId,
          whatsapp: order.guestWhatsapp,
          orderDate: order.createdAt,
        }),
    );

    if (legacy) {
      claimedLegacy.add(legacy.id);
      toLink.push({ id: legacy.id, ref: order.reference });
      stats.linked += 1;
      stats.details.push({ ref: order.reference, planId, action: "rattache", client: order.guestName });
      doneKeys.add(key);
      continue;
    }

    // Date d'expiration calculée exactement comme dans
    // `assignSubscriptionFromOrderItem` : prix UNITAIRE de la ligne (jamais
    // `item.totalPrice`, qui inclut la quantité et rendrait la durée
    // indéterminable), et point de départ `order.createdAt` — la même source
    // que `scripts/backfill-expiration.js` et que
    // `assignSubscriptionFromOrderItem`, pour que deux clients ayant acheté
    // la même chose obtiennent la même date, qu'ils soient rattrapés par ce
    // réconciliateur ou confirmés en direct. Sans durée fiable, on laisse la
    // date à `null` plutôt que d'en inventer une : la ligne reconstruite ne
    // recevra simplement pas de rappel, ce qui est journalisé ici.
    //
    // Une formule a vie n'a pas de date, et c'est voulu — meme raisonnement que
    // dans `assignSubscriptionFromOrderItem`, dont ce reconciliateur doit
    // reproduire le resultat a l'identique.
    let expiresAt = null;
    if (!estAVie(plan)) {
      const duree = moisAchetes({
        unitPrice: item.unitPrice,
        planPrice: plan.price,
        planDuration: plan.duration,
      });
      if (duree.ok) {
        expiresAt = dateExpiration({ debut: order.createdAt, mois: duree.mois });
      } else {
        logger.warn("Durée d'abonnement indéterminable — expiration non enregistrée (réconciliateur)", {
          ref: order.reference,
          planId,
          unitPrice: item.unitPrice,
          planPrice: plan.price,
          raison: duree.raison,
        });
      }
    }

    toCreate.push({
      serviceId: plan.serviceId,
      planId,
      clientName: order.guestName,
      clientWhatsapp: order.guestWhatsapp,
      clientEmail: order.guestEmail || null,
      amount: item.totalPrice,
      status: "CONFIRMED",
      isGift: !!(order.isGift && order.giftWhatsapp),
      giftName: order.isGift ? order.giftName || null : null,
      giftWhatsapp: order.isGift ? order.giftWhatsapp || null : null,
      // Conserve la date de l'achat : la validité se calcule depuis createdAt,
      // une date de reconstruction fausserait l'expiration.
      createdAt: order.createdAt,
      sourceOrderRef: order.reference,
      expiresAt,
    });
    stats.created += 1;
    stats.details.push({ ref: order.reference, planId, action: "cree", client: order.guestName });
    doneKeys.add(key); // évite un doublon si l'item apparaît deux fois
  }

  if (dryRun) return stats;

  // ── Deux écritures groupées ───────────────────────────────────────────────
  try {
    if (toLink.length > 0) {
      await prisma.$transaction(
        toLink.map((l) =>
          prisma.subscriptionOrder.update({
            where: { id: l.id },
            data: { sourceOrderRef: l.ref },
          }),
        ),
      );
    }
    if (toCreate.length > 0) {
      // skipDuplicates : le flux normal d'attribution peut avoir créé la même
      // ligne entre-temps, la contrainte unique la filtre sans faire échouer
      // tout le lot.
      const res = await prisma.subscriptionOrder.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      if (res.count !== toCreate.length) {
        stats.skipped += toCreate.length - res.count;
        stats.created = res.count;
      }
    }
  } catch (err) {
    stats.errors += 1;
    logger.warn("Écriture de réconciliation échouée", { err: err.message });
  }

  return stats;
}

// ── Version throttlée, pour l'appel avant chaque routage d'OTP ───────────────
// Une réconciliation complète parcourt toutes les commandes payées : la lancer
// à chaque email retarderait la livraison du code pour rien. On la relance au
// plus une fois par fenêtre, et on partage la même promesse entre les boîtes
// qui la demandent en même temps (elles tournent dans le même process).
let _lastRun = 0;
let _inFlight = null;

async function reconcileIfStale(maxAgeMs = 60_000) {
  if (_inFlight) return _inFlight;
  if (Date.now() - _lastRun < maxAgeMs) return null;

  _inFlight = reconcileSubscriptionOrders()
    .catch((err) => {
      logger.warn("Réconciliation throttlée échouée", { err: err.message });
      return null;
    })
    .finally(() => {
      _lastRun = Date.now();
      _inFlight = null;
    });

  return _inFlight;
}

module.exports = {
  reconcileSubscriptionOrders,
  reconcileIfStale,
  PAID_ORDER_STATUSES,
};
