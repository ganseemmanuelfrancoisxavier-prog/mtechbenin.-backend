const test = require("node:test");
const assert = require("node:assert");
const { computeUnitPrice, VALEUR_NON_CHOISIE } = require("./pricing");

const types = [
  {
    name: "Couleur",
    required: true,
    options: [
      { value: "Noir", priceDelta: 0 },
      { value: "Titane", priceDelta: 15000 },
    ],
  },
  {
    name: "Stockage",
    required: true,
    options: [
      { value: "64 Go", priceDelta: 0 },
      { value: "256 Go", priceDelta: 120000 },
    ],
  },
  {
    name: "Gravure",
    required: false,
    options: [{ value: "Oui", priceDelta: 5000 }],
  },
];

test("additionne les supplements des valeurs choisies", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: types,
    selected: [
      { typeName: "Couleur", value: "Titane" },
      { typeName: "Stockage", value: "256 Go" },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unitPrice, 565000);
});

test("un supplement a zero laisse le prix de base", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: types,
    selected: [
      { typeName: "Couleur", value: "Noir" },
      { typeName: "Stockage", value: "64 Go" },
    ],
  });
  assert.strictEqual(r.unitPrice, 430000);
});

test("refuse une caracteristique obligatoire non renseignee", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: types,
    selected: [{ typeName: "Couleur", value: "Noir" }],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /Stockage/);
});

test("accepte une facultative laissee vide", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: types,
    selected: [
      { typeName: "Couleur", value: "Noir" },
      { typeName: "Stockage", value: "64 Go" },
      { typeName: "Gravure", value: VALEUR_NON_CHOISIE },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unitPrice, 430000);
});

test("refuse une valeur qui n'existe pas pour ce produit", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: types,
    selected: [
      { typeName: "Couleur", value: "Or massif" },
      { typeName: "Stockage", value: "64 Go" },
    ],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /Or massif/);
});

test("refuse une caracteristique inconnue du produit", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: types,
    selected: [
      { typeName: "Couleur", value: "Noir" },
      { typeName: "Stockage", value: "64 Go" },
      { typeName: "Garantie", value: "5 ans" },
    ],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /Garantie/);
});

test("un produit sans caracteristique garde son prix de base", () => {
  const r = computeUnitPrice({ basePrice: 9750, variantTypes: [], selected: [] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unitPrice, 9750);
});

test("accepte un supplement negatif", () => {
  const r = computeUnitPrice({
    basePrice: 10000,
    variantTypes: [
      { name: "Format", required: true, options: [{ value: "Petit", priceDelta: -2000 }] },
    ],
    selected: [{ typeName: "Format", value: "Petit" }],
  });
  assert.strictEqual(r.unitPrice, 8000);
});

test("refuse un prix final negatif", () => {
  const r = computeUnitPrice({
    basePrice: 1000,
    variantTypes: [
      { name: "Format", required: true, options: [{ value: "Petit", priceDelta: -5000 }] },
    ],
    selected: [{ typeName: "Format", value: "Petit" }],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /négatif/);
});

// --- Corrections suite a la revue (frontiere de confiance sur `selected`) ---

test("refuse une caracteristique inconnue meme avec la valeur Non choisi", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: types,
    selected: [{ typeName: "TypeInexistant", value: VALEUR_NON_CHOISIE }],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /TypeInexistant/);
});

test("refuse un element non-objet dans selected au lieu de planter", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: types,
    selected: [null, { typeName: "Stockage", value: "64 Go" }],
  });
  assert.strictEqual(r.ok, false);
});

test("refuse un priceDelta non numerique au lieu de le compter comme zero", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: [
      {
        name: "Format",
        required: true,
        options: [{ value: "Petit", priceDelta: "gratuit" }],
      },
    ],
    selected: [{ typeName: "Format", value: "Petit" }],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /Supplément invalide/);
});

test("refuse un priceDelta non entier", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: [
      {
        name: "Format",
        required: true,
        options: [{ value: "Petit", priceDelta: 100.5 }],
      },
    ],
    selected: [{ typeName: "Format", value: "Petit" }],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /Supplément invalide/);
});

test("refuse un priceDelta infini au lieu de renvoyer un prix non serialisable", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: [
      {
        name: "Format",
        required: true,
        options: [{ value: "Petit", priceDelta: Infinity }],
      },
    ],
    selected: [{ typeName: "Format", value: "Petit" }],
  });
  assert.strictEqual(r.ok, false);
});

test("refuse un variantTypes fourni mais qui n'est pas un tableau", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: "pas un tableau",
    selected: [],
  });
  assert.strictEqual(r.ok, false);
});

test("accepte variantTypes absent comme un produit simple sans caracteristique", () => {
  const r = computeUnitPrice({ basePrice: 9750, selected: [] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unitPrice, 9750);
});

test("refuse un prix de base invalide (branche jusque-la jamais exercee)", () => {
  const r = computeUnitPrice({ basePrice: "gratuit", variantTypes: [], selected: [] });
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /Prix de base invalide/);
});

test("regression : un doublon dans selected garde le premier choix trouve", () => {
  const r = computeUnitPrice({
    basePrice: 430000,
    variantTypes: types,
    selected: [
      { typeName: "Couleur", value: "Titane" },
      { typeName: "Couleur", value: "Noir" },
      { typeName: "Stockage", value: "64 Go" },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unitPrice, 430000 + 15000);
});
