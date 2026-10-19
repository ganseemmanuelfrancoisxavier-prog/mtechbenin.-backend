const test = require("node:test");
const assert = require("node:assert");
const { choisirParMontant } = require("./matching");

test("aucun candidat", () => {
  const r = choisirParMontant([], 1500);
  assert.strictEqual(r.candidat, null);
  assert.strictEqual(r.raison, "aucun-candidat");
});

test("un seul candidat : retenu", () => {
  const r = choisirParMontant([{ id: "a", amount: 1500 }], 1500);
  assert.strictEqual(r.candidat.id, "a");
  assert.strictEqual(r.raison, "montant-unique");
});

test("le montant le plus proche l'emporte quand il est seul", () => {
  const r = choisirParMontant(
    [{ id: "loin", amount: 1900 }, { id: "proche", amount: 1520 }],
    1500,
  );
  assert.strictEqual(r.candidat.id, "proche");
});

// La régression : deux clients achètent la même formule au même prix. L'ancien
// code gardait le premier de la liste — donc le mauvais client une fois sur
// deux, avec envoi des identifiants à la clé.
test("deux montants identiques : on refuse de trancher", () => {
  const r = choisirParMontant(
    [{ id: "clientA", amount: 1500 }, { id: "clientB", amount: 1500 }],
    1500,
  );
  assert.strictEqual(r.candidat, null);
  assert.strictEqual(r.raison, "ambigu");
  assert.strictEqual(r.exAequo, 2);
});

test("ex æquo à distance non nulle : refusé aussi", () => {
  const r = choisirParMontant(
    [{ id: "dessous", amount: 1400 }, { id: "dessus", amount: 1600 }],
    1500,
  );
  assert.strictEqual(r.candidat, null);
  assert.strictEqual(r.raison, "ambigu");
});

test("trois candidats dont un seul au plus près", () => {
  const r = choisirParMontant(
    [{ id: "a", amount: 1000 }, { id: "b", amount: 1490 }, { id: "c", amount: 2000 }],
    1500,
  );
  assert.strictEqual(r.candidat.id, "b");
});

test("accesseur de montant personnalisé (commandes produit : `total`)", () => {
  const r = choisirParMontant(
    [{ reference: "R1", total: 1544 }],
    1544,
    (o) => o.total,
  );
  assert.strictEqual(r.candidat.reference, "R1");
});
