const test = require("node:test");
const assert = require("node:assert");
const { calculerReparation } = require("./tarification");

const ecran = { id: "o1", label: "Origine", price: 249000, jobName: "Écran", delay: "48 h" };
const batterie = { id: "o2", label: "Standard", price: 89000, jobName: "Batterie", delay: null };

test("tarification : le sous-total est la somme des options", () => {
  const r = calculerReparation({ options: [ecran, batterie] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.subtotal, 338000);
  assert.strictEqual(r.total, 338000);
  assert.strictEqual(r.lignes.length, 2);
  assert.strictEqual(r.lignes[0].jobName, "Écran");
});

test("tarification : une sélection vide est refusée", () => {
  const r = calculerReparation({ options: [] });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /aucune réparation/i);
});

test("tarification : un coupon en pourcentage s'applique au sous-total", () => {
  const r = calculerReparation({
    options: [ecran, batterie],
    coupon: { code: "NOEL", type: "PERCENTAGE", value: 10, minOrder: 0 },
  });
  assert.strictEqual(r.discount, 33800);
  assert.strictEqual(r.total, 304200);
});

test("tarification : un coupon fixe ne rend jamais un total négatif", () => {
  const r = calculerReparation({
    options: [batterie],
    coupon: { code: "GROS", type: "FIXED", value: 500000, minOrder: 0 },
  });
  assert.strictEqual(r.discount, 89000);
  assert.strictEqual(r.total, 0);
});

// Le coupon a un plancher : sous ce montant il ne s'applique pas, et le client
// doit le comprendre plutôt que de voir une remise disparaître en silence.
test("tarification : un coupon sous son plancher est refusé", () => {
  const r = calculerReparation({
    options: [batterie],
    coupon: { code: "GROS", type: "FIXED", value: 10000, minOrder: 200000 },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /200000|plancher|minimum/i);
});

// Les montants sont des ENTIERS en FCFA. Un pourcentage produit des décimales
// qu'il faut arrondir ici, une seule fois — sinon le total affiché au client et
// celui envoyé à FedaPay divergent d'un franc.
test("tarification : la remise est arrondie à l'entier", () => {
  const r = calculerReparation({
    options: [{ id: "o3", label: "Std", price: 3333, jobName: "X" }],
    coupon: { code: "P", type: "PERCENTAGE", value: 10, minOrder: 0 },
  });
  assert.strictEqual(Number.isInteger(r.discount), true);
  assert.strictEqual(Number.isInteger(r.total), true);
  assert.strictEqual(r.discount + r.total, 3333);
});

// Les frais de service restent chez MTECHBENIN et ne sont pas envoyés à
// FedaPay : `total` est ce que le client paie, `feeAmount` ce qu'on en retient.
test("tarification : les frais de service sont calculés sur le total remisé", () => {
  const r = calculerReparation({ options: [batterie], tauxFrais: 0.02 });
  assert.strictEqual(r.total, 89000);
  assert.strictEqual(r.feeAmount, 1780);
});

test("tarification : un prix illisible fait échouer plutôt que produire NaN", () => {
  const r = calculerReparation({ options: [{ id: "x", label: "?", price: "abc", jobName: "X" }] });
  assert.strictEqual(r.ok, false);
});

// Le montant est calculé par le serveur et fait autorité : une valeur de
// coupon illisible ne doit jamais se traduire par un NaN enregistré en base
// ou envoyé à FedaPay. On la traite comme une absence de remise.
test("tarification : une valeur de coupon illisible ne produit pas de NaN", () => {
  const r = calculerReparation({
    options: [batterie],
    coupon: { code: "X", type: "PERCENTAGE", value: "abc", minOrder: 0 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.discount, 0);
  assert.strictEqual(r.total, 89000);
  assert.strictEqual(Number.isNaN(r.discount), false);
  assert.strictEqual(Number.isNaN(r.total), false);
});

// Une valeur négative ne doit pas gonfler le total : la remise reste dans
// [0, subtotal], jamais en dessous de zéro.
test("tarification : une valeur de coupon négative ne majore pas le total", () => {
  const r = calculerReparation({
    options: [batterie],
    coupon: { code: "X", type: "FIXED", value: -50000, minOrder: 0 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.discount, 0);
  assert.strictEqual(r.total, 89000);
});
