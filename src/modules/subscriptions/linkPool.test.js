const test = require("node:test");
const assert = require("node:assert");
const { lienValide, statutApresEnvoi } = require("./linkPool");

test("accepte une adresse https", () => {
  assert.strictEqual(lienValide("https://open.spotify.com/invite/abc"), true);
});

test("accepte une adresse http", () => {
  assert.strictEqual(lienValide("http://exemple.com/x"), true);
});

test("accepte une adresse entourée d'espaces", () => {
  assert.strictEqual(lienValide("  https://exemple.com/x  "), true);
});

test("refuse du texte libre", () => {
  assert.strictEqual(lienValide("bonjour"), false);
});

test("refuse une adresse sans schéma", () => {
  assert.strictEqual(lienValide("www.exemple.com"), false);
});

test("refuse un schéma non web", () => {
  assert.strictEqual(lienValide("ftp://exemple.com"), false);
  assert.strictEqual(lienValide("javascript:alert(1)"), false);
});

test("refuse une chaîne vide ou blanche", () => {
  assert.strictEqual(lienValide(""), false);
  assert.strictEqual(lienValide("   "), false);
});

test("refuse ce qui n'est pas une chaîne, sans lever", () => {
  for (const v of [null, undefined, 42, {}, [], true]) {
    assert.strictEqual(lienValide(v), false);
  }
});

test("un seul canal réussi suffit à considérer le lien envoyé", () => {
  assert.strictEqual(statutApresEnvoi({ whatsappOk: true, emailOk: false }), "envoyé");
  assert.strictEqual(statutApresEnvoi({ whatsappOk: false, emailOk: true }), "envoyé");
});

test("les deux canaux réussis donnent envoyé", () => {
  assert.strictEqual(statutApresEnvoi({ whatsappOk: true, emailOk: true }), "envoyé");
});

test("les deux canaux échoués laissent la ligne en attente", () => {
  assert.strictEqual(statutApresEnvoi({ whatsappOk: false, emailOk: false }), "en_attente");
});

test("une valeur non booléenne est traitée comme un échec", () => {
  assert.strictEqual(statutApresEnvoi({ whatsappOk: undefined, emailOk: null }), "en_attente");
});

test("appel sans argument laisse la ligne en attente", () => {
  assert.strictEqual(statutApresEnvoi(), "en_attente");
});

test("appel avec null laisse la ligne en attente", () => {
  assert.strictEqual(statutApresEnvoi(null), "en_attente");
});

test("refuse une adresse copiée sans schéma depuis la barre d'adresse", () => {
  assert.strictEqual(lienValide("//exemple.com"), false);
});

test("refuse des liens tronqués sans hôte", () => {
  assert.strictEqual(lienValide("https://"), false);
  assert.strictEqual(lienValide("http:///"), false);
});

test("accepte un schéma en majuscules, normalisé par URL", () => {
  assert.strictEqual(lienValide("HTTPS://exemple.com"), true);
});

test("ne lève pas sur une chaîne démesurée", () => {
  // Une entrée de 100 000 caractères ne doit jamais faire lever
  const enorme = "x".repeat(100000);
  assert.strictEqual(lienValide(enorme), false);
});
