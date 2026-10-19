// Test d'integration du gestionnaire `enregistrerClientHorsSite` (refonte OTP
// du 13/10/2026), sur une base bouchonnee dans le cache des modules.
const test = require("node:test");
const assert = require("node:assert");

let ETAT;
function reinitialiser({ capacite = 1, occupants = 0, fluxMax = 4, flux = 0, aVie = false } = {}) {
  ETAT = {
    profil: {
      id: "p-1", profile: "PARIS", planId: "plan-1",
      plan: { id: "plan-1", aVie, serviceId: "s-netflix" },
      account: { id: "c-b", serviceId: "s-netflix" },
    },
    verrous: { capacite, fluxMax },
    comptes: { occupants, flux },
    commandes: [],
    occupations: [],
  };
}

const faux = {
  familyAccount: { findUnique: async () => ETAT.profil, update: async () => ({}) },
  $transaction: async (fn) => {
    // Une transaction : on travaille sur une copie, et on ne garde les
    // ecritures que si la fonction se termine normalement.
    const avant = { commandes: [...ETAT.commandes], occupations: [...ETAT.occupations] };
    try {
      return await fn(tx);
    } catch (e) {
      Object.assign(ETAT, avant);
      throw e;
    }
  },
};
const tx = {
  $queryRaw: async (strings) => {
    const sql = strings.join("?");
    if (sql.includes('"StreamingAccount"')) return [{ maxFluxSimultanes: ETAT.verrous.fluxMax }];
    if (sql.includes('"FamilyAccount"')) return [{ capacite: ETAT.verrous.capacite }];
    return [];
  },
  profileOccupancy: {
    count: async ({ where }) => (where.profileId ? ETAT.comptes.occupants : ETAT.comptes.flux),
    create: async ({ data }) => { const o = { id: `o-${ETAT.occupations.length + 1}`, ...data }; ETAT.occupations.push(o); return o; },
    findMany: async () => [],
  },
  subscriptionOrder: {
    create: async ({ data }) => { const c = { id: `cmd-${ETAT.commandes.length + 1}`, ...data }; ETAT.commandes.push(c); return c; },
  },
  familyAccount: { update: async () => ({}), findUnique: async () => ETAT.profil },
};

const p = require.resolve("../../services/prisma");
require.cache[p] = { id: p, filename: p, loaded: true, exports: faux };
const l = require.resolve("../../utils/logger");
require.cache[l] = { id: l, filename: l, loaded: true, exports: { info() {}, warn() {}, error() {}, debug() {} } };

const { enregistrerClientHorsSite } = require("./subscriptions.controller");

function appeler(corps) {
  return new Promise((resolve) => {
    const res = {
      statut: 200,
      status(c) { this.statut = c; return this; },
      json(b) { resolve({ statut: this.statut, corps: b }); return this; },
    };
    enregistrerClientHorsSite({ params: { id: "p-1" }, body: corps }, res);
  });
}

const SAISIE = { nom: "Koffi Mensah", whatsapp: "+229 01 97 00 00 00", finLe: "2099-01-31", montant: "2500" };

test("hors site : commande payee et occupation creees ensemble", async () => {
  reinitialiser();
  const r = await appeler(SAISIE);
  assert.strictEqual(r.statut, 201, JSON.stringify(r.corps));
  assert.strictEqual(ETAT.commandes.length, 1);
  const c = ETAT.commandes[0];
  assert.strictEqual(c.status, "CONFIRMED");
  assert.strictEqual(c.amount, 2500);
  assert.strictEqual(c.planId, "plan-1");
  assert.strictEqual(c.serviceId, "s-netflix");
  assert.match(c.sourceOrderRef, /^HORS-SITE-/);
  assert.strictEqual(ETAT.occupations.length, 1);
  assert.strictEqual(ETAT.occupations[0].orderId, c.id);
  assert.strictEqual(ETAT.occupations[0].occupantWhatsapp, "+2290197000000",
    "c'est ce numero qui recevra les codes du compte");
});

// Un profil plein ne doit laisser AUCUNE commande derriere lui : la commande
// n'est creee qu'apres que la place a ete accordee.
test("hors site : profil plein -> refus, et aucune commande orpheline", async () => {
  reinitialiser({ capacite: 1, occupants: 1 });
  const r = await appeler(SAISIE);
  assert.strictEqual(r.statut, 409);
  assert.strictEqual(ETAT.commandes.length, 0);
  assert.strictEqual(ETAT.occupations.length, 0);
});

test("hors site : saisie invalide -> 400, rien n'est ecrit", async () => {
  reinitialiser();
  const r = await appeler({ ...SAISIE, whatsapp: "abc" });
  assert.strictEqual(r.statut, 400);
  assert.strictEqual(ETAT.commandes.length, 0);
});

test("hors site : formule a vie -> pas d'echeance exigee ni enregistree", async () => {
  reinitialiser({ aVie: true });
  const r = await appeler({ ...SAISIE, finLe: "" });
  assert.strictEqual(r.statut, 201, JSON.stringify(r.corps));
  assert.strictEqual(ETAT.commandes[0].expiresAt, null);
});
