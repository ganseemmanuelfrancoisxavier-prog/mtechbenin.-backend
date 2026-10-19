// Test du webhook FedaPay — ferme le trou Critique C1 de la relecture finale
// (2026-09-07) : un `repairRef` fourni mais qui ne correspond à AUCUNE
// réparation `EN_ATTENTE` retombait sur le repli par montant des commandes
// PRODUIT, et pouvait donc confirmer la commande d'un inconnu — stock
// décrémenté, abonnements attribués — pour un paiement qui n'était pas le
// sien.
//
// Même motif que `src/modules/repairs/resolution.test.js` et
// `workers/otpRouting.resolve.test.js` : `fedapayWebhook` lit la base, on la
// teste avec un `prisma` (et les services `whatsapp`/`email` qu'il notifie)
// bouchonnés, injectés dans le cache de modules AVANT de charger
// `./payments.controller`. Un vrai accès base ou réseau rendrait ce test
// inexécutable en intégration continue — or c'est précisément celui qui garde
// la porte fermée sur l'incident décrit ci-dessus.
const test = require("node:test");
const assert = require("node:assert");

const prismaPath = require.resolve("../../services/prisma");
const whatsappPath = require.resolve("../../services/whatsapp");
const emailPath = require.resolve("../../services/email");

// Compteurs d'appels : c'est sur EUX que porte l'assertion. Peu importe
// comment le contrôleur y arrive, s'il touche à l'une de ces méthodes, c'est
// qu'il a quitté la branche réparation pour retomber sur le chemin produit.
const appels = {
  orderFindMany: 0,
  paymentCreate: 0,
  orderUpdate: 0,
};

// Commande produit PENDING innocente, dont le total tombe pile dans la
// fenêtre ±500 F du paiement de réparation. C'est elle que l'ancien code
// confirmait à la place du client qui avait réellement payé.
const COMMANDE_INNOCENTE = {
  id: "order-innocent",
  reference: "ORD-INNOCENT",
  status: "PENDING",
  total: 45000,
  couponCode: null,
  items: [],
  guestWhatsapp: "+22990000000",
  guestName: "Client Innocent",
  guestEmail: "innocent@example.com",
  city: "Cotonou",
};

require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: {
    payment: {
      // Anti-double-traitement : jamais déjà vu.
      findUnique: async () => null,
      create: async ({ data }) => {
        appels.paymentCreate += 1;
        return { id: "payment-fake", ...data };
      },
    },
    order: {
      // `orderRef` n'est jamais fourni dans ce test (repairRef seul est
      // envoyé) : cette méthode ne doit être appelée par AUCUN chemin qui
      // designe explicitement une réparation.
      findFirst: async () => null,
      findMany: async () => {
        appels.orderFindMany += 1;
        // Le repli par montant : s'il est atteint, il retrouve la commande
        // innocente, à égalité de montant avec le paiement de réparation.
        return [COMMANDE_INNOCENTE];
      },
      update: async ({ data }) => {
        appels.orderUpdate += 1;
        return { ...COMMANDE_INNOCENTE, ...data };
      },
    },
    subscriptionOrder: {
      findFirst: async () => null,
    },
    repairOrder: {
      // AUCUNE réparation EN_ATTENTE ne correspond à la référence envoyée —
      // c'est exactement le cas du constat C1.
      findFirst: async () => null,
    },
    coupon: { update: async () => ({}) },
    product: { updateMany: async () => ({ count: 0 }), findUnique: async () => null },
    clientTracker: { findUnique: async () => null, upsert: async () => ({}) },
  },
};

// `whatsapp`/`email` : n'importe quelle méthode appelée résout sans rien
// faire. Ce test ne porte pas sur les notifications, seulement sur la
// commande touchée — mais si le code (pré-correctif) va jusqu'à notifier,
// il ne faut ni réseau ni exception pour autant.
function stubService(path) {
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: new Proxy({}, { get: () => async () => undefined }),
  };
}
stubService(whatsappPath);
stubService(emailPath);

const { fedapayWebhook } = require("./payments.controller");

function fakeRes() {
  return {
    status() { return this; },
    json() { return this; },
  };
}

test("webhook FedaPay : un repairRef introuvable ne confirme aucune commande produit", async () => {
  const event = {
    name: "transaction.approved",
    entity: {
      id: "tx-fake-1",
      status: "approved",
      amount: 45000,
      mode: "mobile_money",
      approved_at: new Date().toISOString(),
      custom_metadata: { repairRef: "REP-INTROUVABLE" },
    },
  };

  const req = {
    headers: {},
    body: Buffer.from(JSON.stringify(event)),
  };

  await fedapayWebhook(req, fakeRes());

  assert.strictEqual(
    appels.orderFindMany, 0,
    "un repairRef qui ne correspond à aucune réparation EN_ATTENTE ne doit JAMAIS déclencher le repli par montant des commandes produit",
  );
  assert.strictEqual(
    appels.paymentCreate, 0,
    "aucun paiement ne doit être créé et rattaché à une commande que la transaction ne désignait pas",
  );
  assert.strictEqual(
    appels.orderUpdate, 0,
    "la commande innocente ne doit jamais passer CONFIRMED pour un paiement de réparation orphelin",
  );
});
