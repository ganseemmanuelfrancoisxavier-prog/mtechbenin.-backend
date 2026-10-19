const test = require("node:test");
const assert = require("node:assert");
const { generateOrderRef, generateReceiptNumber, generateRepairRef, ALPHABET, LONGUEUR } = require("./generateRef");

test("format MTECH-<année>-<suffixe>", () => {
  const ref = generateOrderRef(2026);
  assert.match(ref, /^MTECH-2026-[A-Z2-9]{8}$/);
});

test("l'année par défaut est l'année courante", () => {
  assert.ok(generateOrderRef().startsWith(`MTECH-${new Date().getFullYear()}-`));
});

test("l'alphabet exclut les caractères ambigus à l'oral", () => {
  for (const c of ["I", "O", "0", "1"]) {
    assert.ok(!ALPHABET.includes(c), `${c} ne doit pas figurer dans l'alphabet`);
  }
});

// L'ancienne version tirait 5 chiffres : 90 000 valeurs, énumérables et
// sujettes aux collisions. On vérifie que l'espace est bien celui annoncé.
test("l'espace de tirage dépasse mille milliards de valeurs", () => {
  assert.ok(Math.pow(ALPHABET.length, LONGUEUR) > 1e12);
});

test("dix mille tirages sans un seul doublon", () => {
  const vues = new Set();
  for (let i = 0; i < 10000; i++) vues.add(generateOrderRef(2026));
  assert.strictEqual(vues.size, 10000);
});

test("le numéro de reçu garde le format daté", () => {
  assert.match(generateReceiptNumber(), /^REC-\d{8}-[A-Z2-9]{4}$/);
});

test("référence réparation : préfixe REP et huit caractères non ambigus", () => {
  const ref = generateRepairRef(2026);
  assert.match(ref, /^REP-2026-[A-Z2-9]{8}$/);
  for (const c of ref.slice(9)) assert.ok(ALPHABET.includes(c), c);
});

// La référence est lue au téléphone et recopiée dans la page de suivi : I, O,
// 0 et 1 se confondent à l'oral comme à l'écrit.
test("référence réparation : aucun caractère ambigu", () => {
  for (let i = 0; i < 200; i++) {
    assert.doesNotMatch(generateRepairRef(2026).slice(9), /[IO01]/);
  }
});

// Le préfixe distingue une réparation d'une commande produit dans le webhook,
// les journaux et les messages WhatsApp.
test("référence réparation : distincte d'une commande produit", () => {
  assert.ok(generateRepairRef(2026).startsWith("REP-"));
});
