const test = require("node:test");
const assert = require("node:assert");
const {
  estAVie,
  libelleDuree,
  periodesAutorisees,
  normaliserDuree,
} = require("./duree");

// ── estAVie ──────────────────────────────────────────────────────────────────

test("à vie : seul le booléen vrai compte", () => {
  assert.strictEqual(estAVie({ aVie: true }), true);
  assert.strictEqual(estAVie({ aVie: false }), false);
});

// Le réconciliateur et le routage OTP travaillent sur des `select` partiels, et
// une commande ancienne peut n'avoir aucune formule. Se tromper dans ce sens
// donnerait un accès définitif gratuitement.
test("à vie : une formule absente ou partielle n'est pas à vie", () => {
  for (const plan of [undefined, null, {}, { duration: 1 }, { aVie: "true" }, { aVie: 1 }]) {
    assert.strictEqual(estAVie(plan), false, JSON.stringify(plan));
  }
});

// ── libelleDuree ─────────────────────────────────────────────────────────────

test("libellé : une formule à vie l'annonce, quelle que soit sa durée stockée", () => {
  assert.strictEqual(libelleDuree({ aVie: true, duration: 1 }), "À vie");
  assert.strictEqual(libelleDuree({ aVie: true, duration: 12 }), "À vie");
});

test("libellé : une formule mensuelle donne ses mois", () => {
  assert.strictEqual(libelleDuree({ duration: 1 }), "1 mois");
  assert.strictEqual(libelleDuree({ aVie: false, duration: 6 }), "6 mois");
});

// Ces commandes existent : `moisAchetes` refuse justement ces valeurs, et le
// message part quand même. « null mois » ou « NaN mois » chez un client serait
// pire que l'aveu.
test("libellé : une durée illisible ne produit ni null ni NaN", () => {
  for (const plan of [undefined, {}, { duration: 0 }, { duration: -3 }, { duration: "trois" }]) {
    assert.strictEqual(libelleDuree(plan), "durée inconnue", JSON.stringify(plan));
  }
});

// ── periodesAutorisees ───────────────────────────────────────────────────────

// « Deux fois à vie » ne veut rien dire, et laisser passer le multiplicateur
// ferait payer double pour exactement le même accès.
test("périodes : une formule à vie ne s'achète qu'une fois", () => {
  assert.strictEqual(periodesAutorisees({ aVie: true }), 1);
});

test("périodes : une formule mensuelle garde le plafond de douze", () => {
  assert.strictEqual(periodesAutorisees({ duration: 1 }), 12);
  assert.strictEqual(periodesAutorisees(undefined), 12);
});

// ── normaliserDuree ──────────────────────────────────────────────────────────

test("normalisation : une durée en mois passe en entier", () => {
  assert.deepStrictEqual(normaliserDuree({ duration: "6" }), {
    ok: true,
    champs: { duration: 6 },
  });
});

// La colonne est obligatoire et ignorée sur une formule à vie : y laisser la
// valeur du formulaire ferait afficher « 0 mois » quelque part un jour.
test("normalisation : « à vie » impose une durée de 1, quelle que soit la saisie", () => {
  assert.deepStrictEqual(normaliserDuree({ aVie: true, duration: 99 }), {
    ok: true,
    champs: { aVie: true, duration: 1 },
  });
  assert.deepStrictEqual(normaliserDuree({ aVie: true }), {
    ok: true,
    champs: { aVie: true, duration: 1 },
  });
});

// Le panel envoyait `Number("")`, soit 0, et la formule s'enregistrait. L'erreur
// ne se voyait qu'à l'ACHAT, où `moisAchetes` refusait la durée et la commande
// partait sans date d'expiration — donc sans rappel.
test("normalisation : une durée nulle ou négative est refusée", () => {
  for (const mauvais of [0, -1, "", "abc", 1.5, null]) {
    const r = normaliserDuree({ duration: mauvais });
    assert.strictEqual(r.ok, false, JSON.stringify(mauvais));
    assert.match(r.erreur, /Durée invalide/);
  }
});

test("normalisation : un « à vie » illisible est refusé plutôt que deviné", () => {
  for (const mauvais of ["oui", 1, 0, {}]) {
    assert.strictEqual(normaliserDuree({ aVie: mauvais }).ok, false, JSON.stringify(mauvais));
  }
});

// Convention de `normaliserDescription` : ce que le panel n'envoie pas reste en
// place. Le PATCH qui ne règle que la capacité ne doit pas basculer une formule
// à vie en mensuelle au passage.
test("normalisation : un champ absent ne produit aucune écriture", () => {
  assert.deepStrictEqual(normaliserDuree({}), { ok: true, champs: {} });
  assert.deepStrictEqual(normaliserDuree({ capaciteProfil: 3 }), { ok: true, champs: {} });
});

test("normalisation : décocher « à vie » sans durée ne touche pas la durée", () => {
  assert.deepStrictEqual(normaliserDuree({ aVie: false }), {
    ok: true,
    champs: { aVie: false },
  });
});
