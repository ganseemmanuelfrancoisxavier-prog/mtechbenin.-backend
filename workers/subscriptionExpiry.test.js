const test = require("node:test");
const assert = require("node:assert");
const {
  moisAchetes,
  dateExpiration,
  estDansLaFenetreDEnvoi,
  expireDemain,
} = require("./subscriptionExpiry");

test("un mois payé au prix du plan", () => {
  const r = moisAchetes({ unitPrice: 1500, planPrice: 1500, planDuration: 1 });
  assert.deepStrictEqual(r, { ok: true, mois: 1 });
});

test("trois mois au triple du prix", () => {
  const r = moisAchetes({ unitPrice: 4500, planPrice: 1500, planDuration: 1 });
  assert.strictEqual(r.mois, 3);
});

test("un plan de 3 mois pris deux fois vaut six mois", () => {
  const r = moisAchetes({ unitPrice: 10000, planPrice: 5000, planDuration: 3 });
  assert.strictEqual(r.mois, 6);
});

test("refuse un prix qui ne tombe pas juste", () => {
  const r = moisAchetes({ unitPrice: 5500, planPrice: 5000, planDuration: 3 });
  assert.strictEqual(r.ok, false);
});

test("refuse un multiplicateur au-delà de douze", () => {
  const r = moisAchetes({ unitPrice: 1500 * 13, planPrice: 1500, planDuration: 1 });
  assert.strictEqual(r.ok, false);
});

test("refuse un prix de plan nul", () => {
  const r = moisAchetes({ unitPrice: 1500, planPrice: 0, planDuration: 1 });
  assert.strictEqual(r.ok, false);
});

test("refuse un montant inférieur au prix du plan", () => {
  const r = moisAchetes({ unitPrice: 100, planPrice: 1500, planDuration: 1 });
  assert.strictEqual(r.ok, false);
});

test("ajoute les mois à la date de départ", () => {
  const d = dateExpiration({ debut: new Date("2026-01-15T10:00:00Z"), mois: 3 });
  assert.strictEqual(d.toISOString().slice(0, 10), "2026-04-15");
});

test("le 31 janvier plus un mois ne déborde pas sur mars", () => {
  const d = dateExpiration({ debut: new Date("2026-01-31T10:00:00Z"), mois: 1 });
  assert.strictEqual(d.toISOString().slice(0, 10), "2026-02-28");
});

test("la fenêtre d'envoi exclut la nuit", () => {
  // 05:00 UTC = 06:00 au Bénin — trop tôt
  assert.strictEqual(estDansLaFenetreDEnvoi(new Date("2026-03-10T05:00:00Z")), false);
  // 07:00 UTC = 08:00 au Bénin — dans la fenêtre
  assert.strictEqual(estDansLaFenetreDEnvoi(new Date("2026-03-10T07:00:00Z")), true);
  // 21:00 UTC = 22:00 au Bénin — trop tard
  assert.strictEqual(estDansLaFenetreDEnvoi(new Date("2026-03-10T21:00:00Z")), false);
});

test("expire demain se juge sur la date locale, pas sur un écart d'heures", () => {
  const maintenant = new Date("2026-03-10T09:00:00Z"); // 10h au Bénin
  // expire le 11 à 02h locale : c'est demain, même si l'écart est de 17 h
  assert.strictEqual(expireDemain(new Date("2026-03-11T01:00:00Z"), maintenant), true);
  // expire le 10 en fin de journée : c'est aujourd'hui, pas demain
  assert.strictEqual(expireDemain(new Date("2026-03-10T22:00:00Z"), maintenant), false);
  // expire le 12 : trop tôt pour prévenir
  assert.strictEqual(expireDemain(new Date("2026-03-12T09:00:00Z"), maintenant), false);
});

test("une date absente n'expire jamais demain", () => {
  assert.strictEqual(expireDemain(null, new Date("2026-03-10T09:00:00Z")), false);
});

// --- Frontières exactes de la fenêtre d'envoi -----------------------------
// h >= HEURE_MIN && h < HEURE_MAX : un test qui ne pince que 6h/8h/22h ne
// distinguerait pas `>=` de `>`, ni `<` de `<=`. On vérifie donc pile sur les
// secondes qui précèdent et qui suivent chaque borne.
test("la fenêtre d'envoi s'ouvre à 7h locale pile, pas avant", () => {
  // 05:59 UTC = 06:59 au Bénin — encore trop tôt d'une minute
  assert.strictEqual(estDansLaFenetreDEnvoi(new Date("2026-03-10T05:59:00Z")), false);
  // 06:00 UTC = 07:00 au Bénin pile — la fenêtre s'ouvre
  assert.strictEqual(estDansLaFenetreDEnvoi(new Date("2026-03-10T06:00:00Z")), true);
});

test("la fenêtre d'envoi se ferme à 21h locale pile, incluse jusqu'à 20h59", () => {
  // 19:59 UTC = 20:59 au Bénin — encore dans la fenêtre
  assert.strictEqual(estDansLaFenetreDEnvoi(new Date("2026-03-10T19:59:00Z")), true);
  // 20:00 UTC = 21:00 au Bénin pile — la fenêtre est fermée (21h est exclue)
  assert.strictEqual(estDansLaFenetreDEnvoi(new Date("2026-03-10T20:00:00Z")), false);
});

// --- Frontière exacte de minuit pour "expire demain" ----------------------
test("expire demain se pince sur minuit local pile, pas seulement sur 23h/2h", () => {
  const maintenant = new Date("2026-03-10T09:00:00Z"); // 10h au Bénin, demain = 11 mars
  // 23:00 UTC = minuit pile le 11 mars au Bénin : c'est déjà demain
  assert.strictEqual(expireDemain(new Date("2026-03-10T23:00:00Z"), maintenant), true);
  // 22:59:59 UTC = 23:59:59 le 10 mars au Bénin, une seconde avant minuit :
  // c'est encore aujourd'hui, pas demain
  assert.strictEqual(expireDemain(new Date("2026-03-10T22:59:59Z"), maintenant), false);
});

// --- Important 1 : donnée corrompue ne doit jamais lever d'exception ------
test("une entrée illisible ne fait jamais planter la fenêtre d'envoi", () => {
  assert.doesNotThrow(() => estDansLaFenetreDEnvoi("abc"));
  assert.strictEqual(estDansLaFenetreDEnvoi("abc"), false);
  assert.doesNotThrow(() => estDansLaFenetreDEnvoi(new Date(NaN)));
  assert.strictEqual(estDansLaFenetreDEnvoi(new Date(NaN)), false);
});

test("une entrée illisible ne fait jamais planter expireDemain", () => {
  const maintenant = new Date("2026-03-10T09:00:00Z");
  assert.doesNotThrow(() => expireDemain(new Date(NaN), maintenant));
  assert.strictEqual(expireDemain(new Date(NaN), maintenant), false);
  assert.doesNotThrow(() => expireDemain("abc", maintenant));
  assert.strictEqual(expireDemain("abc", maintenant), false);
  assert.doesNotThrow(() => expireDemain(new Date("2026-03-11T01:00:00Z"), "abc"));
  assert.strictEqual(expireDemain(new Date("2026-03-11T01:00:00Z"), "abc"), false);
});

// --- Important 2 : une durée de plan négative ou nulle est refusée --------
test("refuse une durée de plan négative au lieu de produire une expiration passée", () => {
  const r = moisAchetes({ unitPrice: 4500, planPrice: 1500, planDuration: -3 });
  assert.strictEqual(r.ok, false);
});

test("refuse une durée de plan nulle", () => {
  const r = moisAchetes({ unitPrice: 1500, planPrice: 1500, planDuration: 0 });
  assert.strictEqual(r.ok, false);
});

test("refuse une durée de plan non entière", () => {
  const r = moisAchetes({ unitPrice: 1500, planPrice: 1500, planDuration: 1.5 });
  assert.strictEqual(r.ok, false);
});
