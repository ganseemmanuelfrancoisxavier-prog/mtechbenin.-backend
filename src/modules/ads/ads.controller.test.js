const test = require("node:test");
const assert = require("node:assert");
const { validerAnnonce } = require("./ads.controller");

// ── Création ─────────────────────────────────────────────────────────────────

test("refuse un nom d'annonceur manquant à la création", () => {
  const r = validerAnnonce({ url: "http://a.com/x.jpg" }, { creation: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.erreur, "Le nom de l'annonceur est requis");
});

test("refuse un visuel manquant à la création", () => {
  const r = validerAnnonce({ advertiser: "Marque X" }, { creation: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.erreur, "Le visuel est requis");
});

test("refuse un type de média inconnu", () => {
  const r = validerAnnonce(
    { advertiser: "Marque X", url: "http://a.com/x.jpg", type: "gif" },
    { creation: true },
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.erreur, "Type de média invalide");
});

test("refuse un lien illisible", () => {
  const r = validerAnnonce(
    { advertiser: "Marque X", url: "http://a.com/x.jpg", href: "pas une adresse" },
    { creation: true },
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.erreur, "Lien invalide — attendu une adresse http ou https");
});

test("un champ absent des données envoyées n'apparaît pas dans le résultat", () => {
  const r = validerAnnonce(
    { advertiser: "Marque X", url: "http://a.com/x.jpg" },
    { creation: true },
  );
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, {
    advertiser: "Marque X",
    url: "http://a.com/x.jpg",
  });
  assert.strictEqual("caption" in r.data, false);
  assert.strictEqual("href" in r.data, false);
  assert.strictEqual("type" in r.data, false);
});

// ── Modification partielle ───────────────────────────────────────────────────

test("une modification partielle n'exige pas les champs obligatoires de la création", () => {
  const r = validerAnnonce({ order: 3 }, { creation: false });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, { order: 3 });
});

test("un lien vide efface le lien existant", () => {
  const r = validerAnnonce({ href: "" }, { creation: false });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, { href: null });
});

test("une accroche vide efface l'accroche existante", () => {
  const r = validerAnnonce({ caption: "" }, { creation: false });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, { caption: null });
});
