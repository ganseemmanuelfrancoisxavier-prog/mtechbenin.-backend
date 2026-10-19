const test = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");
const { politiqueMotDePasse } = require("./auth");

const HACHE = bcrypt.hashSync("un-vrai-mot-de-passe", 4);

test("un haché bcrypt est utilisable partout", () => {
  for (const production of [true, false]) {
    const r = politiqueMotDePasse(HACHE, { production });
    assert.strictEqual(r.utilisable, true);
    assert.strictEqual(r.hache, true);
  }
});

test("aucun mot de passe enregistré : accès refusé", () => {
  const r = politiqueMotDePasse(null, { production: true });
  assert.strictEqual(r.utilisable, false);
  assert.match(r.raison, /aucun mot de passe/);
});

test("chaîne vide traitée comme une absence", () => {
  assert.strictEqual(politiqueMotDePasse("", { production: false }).utilisable, false);
});

// Le cœur de la faille : cette valeur figure en clair dans le dépôt et dans
// sa documentation. Elle ne doit plus jamais ouvrir le panel, même en développement.
test("le mot de passe historique du dépôt est refusé, y compris hors production", () => {
  for (const production of [true, false]) {
    const r = politiqueMotDePasse("admin2026", { production });
    assert.strictEqual(r.utilisable, false, `refusé attendu (production=${production})`);
    assert.match(r.raison, /valeur publique/);
  }
});

test("en production, tout mot de passe en clair est refusé", () => {
  const r = politiqueMotDePasse("un-autre-mot-de-passe", { production: true });
  assert.strictEqual(r.utilisable, false);
  assert.match(r.raison, /en clair/);
});

test("hors production, un mot de passe en clair reste toléré pour le développement local", () => {
  const r = politiqueMotDePasse("dev-local", { production: false });
  assert.strictEqual(r.utilisable, true);
  assert.strictEqual(r.hache, false);
});
