const test = require("node:test");
const assert = require("node:assert");
const { slugifier, slugDisponible } = require("./slug");

test("slug : accents, majuscules et espaces disparaissent", () => {
  assert.strictEqual(slugifier("iPhone 15 Pro"), "iphone-15-pro");
  assert.strictEqual(slugifier("Écran arrière"), "ecran-arriere");
});

test("slug : la ponctuation ne laisse pas de tirets en trop", () => {
  assert.strictEqual(slugifier("Galaxy S23 — Ultra (5G)"), "galaxy-s23-ultra-5g");
  assert.strictEqual(slugifier("  Dell  "), "dell");
});

// Un nom qui ne laisse aucun caractère exploitable ne doit pas produire une
// chaîne vide : le slug est unique en base, et deux vides entreraient en
// collision avec une erreur que l'administrateur ne saurait pas lire.
test("slug : un nom sans caractère latin donne un repli non vide", () => {
  assert.match(slugifier("★★★"), /^modele-[a-z0-9]+$/);
  assert.match(slugifier(""), /^modele-[a-z0-9]+$/);
});

// Deux marques peuvent vendre un « A15 ». On suffixe plutôt que d'échouer.
test("slug : la collision est suffixée, pas refusée", () => {
  assert.strictEqual(slugDisponible("galaxy-a15", []), "galaxy-a15");
  assert.strictEqual(slugDisponible("galaxy-a15", ["galaxy-a15"]), "galaxy-a15-2");
  assert.strictEqual(
    slugDisponible("galaxy-a15", ["galaxy-a15", "galaxy-a15-2"]),
    "galaxy-a15-3",
  );
});
