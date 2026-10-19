// Tests de `resoudreOptions` et `trouverModeleActif` — le chemin de l'argent :
// c'est ICI, et nulle part ailleurs, que le prix d'une réparation naît d'un
// identifiant envoyé par le navigateur.
//
// Même motif que `workers/otpRouting.resolve.test.js` : ces fonctions lisent
// la base, on les teste avec un `prisma` bouchonné, injecté dans le cache de
// modules AVANT de charger `./resolution`. Un vrai accès base rendrait ces
// tests inexécutables en intégration continue — or ce sont précisément ceux
// qui gardent la porte fermée sur un client qui choisirait son propre prix.
const test = require("node:test");
const assert = require("node:assert");

const prismaPath = require.resolve("../../services/prisma");

// Ce que la base contiendra pour un test donné.
let BASE = { options: [], models: [] };

// Capturé par le bouchon de `repairOrder.create` — c'est sur CET objet que
// portent les assertions du test contrôleur plus bas : ce que Prisma aurait
// réellement écrit.
let ordreEnregistre = null;

require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: {
    repairOption: {
      // Reproduit à la main le filtre imbriqué que `resoudreOptions` envoie à
      // Prisma : id/active sur l'option, active/modelId sur la réparation,
      // active sur le modèle ET sur sa famille.
      findMany: async ({ where }) => {
        return BASE.options
          .filter((o) => {
            if (!where.id.in.includes(o.id)) return false;
            if (where.active !== undefined && o.active !== where.active) return false;
            const j = o.job;
            if (where.job.active !== undefined && j.active !== where.job.active) return false;
            if (where.job.modelId !== undefined && j.modelId !== where.job.modelId) return false;
            if (where.job.model.active !== undefined && j.model.active !== where.job.model.active) {
              return false;
            }
            if (
              where.job.model.family.active !== undefined &&
              j.model.family.active !== where.job.model.family.active
            ) {
              return false;
            }
            return true;
          })
          // `include: { job: { select: {...} } }` — seuls id/name/delay sortent.
          .map((o) => ({ ...o, job: { id: o.job.id, name: o.job.name, delay: o.job.delay } }));
      },
    },
    repairModel: {
      findUnique: async ({ where }) => BASE.models.find((m) => m.id === where.id) || null,
    },
    // Nécessaires au test contrôleur (`creerCommandeReparation`) plus bas.
    // `repairOrder.create` n'écrit rien : il capture le `data` reçu, pour
    // qu'on puisse vérifier ce que le serveur s'apprêtait vraiment à
    // enregistrer.
    repairOrder: {
      create: async ({ data }) => {
        ordreEnregistre = data;
        return { ...data, id: "fake-order-id" };
      },
    },
    // Aucun réglage particulier en base : taux de frais nul, comme un
    // `Setting` absent.
    setting: {
      findUnique: async () => null,
    },
    // `creerCommandeReparation` vérifie désormais que la ville est couverte
    // (`validerZoneCouverte`) avant de créer la commande. "Cotonou", la ville
    // utilisée par le test contrôleur plus bas, est toujours couverte ici.
    deliveryZone: {
      findFirst: async ({ where }) =>
        (String(where?.name?.equals || "").toLowerCase() === "cotonou"
          ? { id: "zone-cotonou", name: "Cotonou", fee: 1000, active: true }
          : null),
    },
  },
};

const { resoudreOptions, trouverModeleActif } = require("./resolution");
const { calculerReparation } = require("./tarification");
const { creerCommandeReparation } = require("./repairs.controller");

// Fabrique une option de catalogue avec sa réparation, son modèle et sa
// famille imbriqués — exactement la forme que `include`/nested `where`
// attendent dans `resolution.js`.
function option({
  id, jobId, price, label = "Standard",
  active = true, jobActive = true,
  modelId = "m-iphone13", modelActive = true, familyActive = true,
}) {
  return {
    id, active, price, label,
    job: {
      id: jobId, name: `Réparation ${jobId}`, delay: null, active: jobActive, modelId,
      model: { active: modelActive, family: { active: familyActive } },
    },
  };
}

function modele({ id, name = "iPhone 13", active = true, familyActive = true, space = "APPLE" }) {
  return { id, name, active, family: { name: "iPhone", space, active: familyActive } };
}

test("resoudreOptions : une option d'un autre modèle est refusée", async () => {
  BASE = { options: [option({ id: "o1", jobId: "j1", price: 15000, modelId: "m-autre" })], models: [] };

  const r = await resoudreOptions("m-iphone13", ["o1"]);

  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /plus disponible/);
});

test("resoudreOptions : une option désactivée est refusée", async () => {
  BASE = { options: [option({ id: "o2", jobId: "j2", price: 15000, active: false })], models: [] };

  const r = await resoudreOptions("m-iphone13", ["o2"]);

  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /plus disponible/);
});

test("resoudreOptions : une option d'une réparation désactivée est refusée", async () => {
  BASE = { options: [option({ id: "o3", jobId: "j3", price: 15000, jobActive: false })], models: [] };

  const r = await resoudreOptions("m-iphone13", ["o3"]);

  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /plus disponible/);
});

test("resoudreOptions : deux qualités choisies pour la même réparation sont refusées", async () => {
  BASE = {
    options: [
      option({ id: "o4a", jobId: "j4", price: 15000, label: "Compatible" }),
      option({ id: "o4b", jobId: "j4", price: 25000, label: "Origine" }),
    ],
    models: [],
  };

  const r = await resoudreOptions("m-iphone13", ["o4a", "o4b"]);

  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /même réparation/);
});

test("resoudreOptions : un tableau vide est refusé", async () => {
  BASE = { options: [], models: [] };

  const r = await resoudreOptions("m-iphone13", []);

  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /Aucune réparation/);
});

test("resoudreOptions : des identifiants répétés ne facturent qu'une fois", async () => {
  BASE = { options: [option({ id: "o5", jobId: "j5", price: 15000 })], models: [] };

  const r = await resoudreOptions("m-iphone13", ["o5", "o5", "o5"]);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.options.length, 1, "un même identifiant répété ne doit peser qu'une fois");

  const facture = calculerReparation({ options: r.options });
  assert.strictEqual(facture.total, 15000, "la répétition ne doit pas doubler la facture");
});

test("resoudreOptions : un modèle désactivé est refusé", async () => {
  BASE = {
    options: [option({ id: "o6", jobId: "j6", price: 15000, modelId: "m-inactif", modelActive: false })],
    models: [],
  };

  const r = await resoudreOptions("m-inactif", ["o6"]);

  assert.strictEqual(r.ok, false, "un modèle désactivé ne doit plus être commandable");
});

test("resoudreOptions : une famille désactivée refuse aussi ses options", async () => {
  BASE = {
    options: [option({ id: "o7", jobId: "j7", price: 15000, modelId: "m-famille-off", familyActive: false })],
    models: [],
  };

  const r = await resoudreOptions("m-famille-off", ["o7"]);

  assert.strictEqual(r.ok, false, "une famille désactivée doit aussi bloquer ses modèles");
});

test("trouverModeleActif : un modèle désactivé rend null", async () => {
  BASE = { options: [], models: [modele({ id: "m-off", active: false })] };

  const m = await trouverModeleActif("m-off");

  assert.strictEqual(m, null);
});

test("trouverModeleActif : une famille désactivée rend null même si le modèle est actif", async () => {
  BASE = { options: [], models: [modele({ id: "m-fam-off", active: true, familyActive: false })] };

  const m = await trouverModeleActif("m-fam-off");

  assert.strictEqual(m, null);
});

test("trouverModeleActif : un modèle actif à famille active est rendu", async () => {
  BASE = { options: [], models: [modele({ id: "m-ok" })] };

  const m = await trouverModeleActif("m-ok");

  assert.ok(m);
  assert.strictEqual(m.id, "m-ok");
});

// ── L'invariant qui compte ───────────────────────────────────────────────────
//
// La première version de ce test n'appelait que `resoudreOptions` puis
// `calculerReparation` — deux fonctions qui ne lisent structurellement jamais
// `req.body.total`. Il ne pouvait donc pas échouer, avant ou après un bug :
// un test qui ne peut pas mordre est pire qu'aucun test, il donne l'illusion
// d'un filet. Celui-ci appelle RÉELLEMENT `creerCommandeReparation` — le seul
// endroit où un `req.body.total` pourrait un jour se glisser dans l'écriture
// — avec un `req`/`res` minimaux et un `prisma.repairOrder.create` qui
// capture ce qu'il aurait écrit au lieu d'écrire.
function fakeRes() {
  return {
    code: 200,
    corps: null,
    status(c) { this.code = c; return this; },
    json(v) { this.corps = v; return this; },
  };
}

test("creerCommandeReparation : un montant du corps de la requête n'a aucun effet sur le total enregistré ni renvoyé", async () => {
  BASE = {
    options: [option({ id: "o9", jobId: "j9", price: 15000, modelId: "m-iphone13" })],
    models: [modele({ id: "m-iphone13" })],
  };
  ordreEnregistre = null;

  const req = {
    body: {
      modelId: "m-iphone13",
      optionIds: ["o9"],
      clientName: "Client Test",
      clientWhatsapp: "+22997000000",
      city: "Cotonou",
      // Corps de requête empoisonné : chaque champ de montant imaginable, à
      // une valeur absurde. Si l'un d'eux finissait par être lu quelque part
      // dans le contrôleur, ce test doit le voir.
      total: 1, subtotal: 1, price: 1, unitPrice: 1, discount: 1, feeAmount: 1,
    },
  };
  const res = fakeRes();

  await creerCommandeReparation(req, res);

  assert.strictEqual(res.code, 201, "la commande doit être créée");
  assert.ok(ordreEnregistre, "prisma.repairOrder.create doit avoir été appelé");

  // Ce que le serveur s'apprêtait À ÉCRIRE : tout doit venir du catalogue
  // bouchonné (prix 15000), jamais du corps empoisonné (1).
  assert.strictEqual(ordreEnregistre.subtotal, 15000, "subtotal doit venir du catalogue, pas du corps empoisonné");
  assert.strictEqual(ordreEnregistre.discount, 0, "sans coupon, aucune remise à inventer");
  assert.strictEqual(ordreEnregistre.total, 15000, "total doit venir du catalogue, jamais du corps empoisonné");
  assert.strictEqual(ordreEnregistre.feeAmount, 0, "feeAmount doit venir du calcul serveur, jamais du corps empoisonné");
  assert.strictEqual(ordreEnregistre.items.create.length, 1);
  assert.strictEqual(
    ordreEnregistre.items.create[0].unitPrice, 15000,
    "le prix de la ligne créée doit venir du catalogue, jamais du corps empoisonné",
  );

  // Ce que le CLIENT reçoit en retour doit être le même montant serveur.
  assert.strictEqual(res.corps.total, 15000, "le total renvoyé au client doit être celui calculé par le serveur");
  assert.notStrictEqual(res.corps.total, req.body.total, "le montant forgé ne doit avoir aucun effet sur la réponse");
});
