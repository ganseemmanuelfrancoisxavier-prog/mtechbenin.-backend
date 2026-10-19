const test = require("node:test");
const assert = require("node:assert");
const { choisirProfil } = require("./placement");

// Fabrique un candidat lisible. `compte` est partagé entre plusieurs profils
// quand on veut simuler des profils d'un même compte.
const profil = (id, { capacite = 1, occupantsActifs = 0, compte, jour = 1 }) => ({
  id,
  capacite,
  occupantsActifs,
  createdAt: new Date(2026, 0, jour),
  compte,
});
const compte = (id, { maxFluxSimultanes = 4, occupantsActifs = 0 }) => ({
  id,
  maxFluxSimultanes,
  occupantsActifs,
});

test("aucun profil : rien à choisir", () => {
  const r = choisirProfil([]);
  assert.strictEqual(r.profil, null);
  assert.strictEqual(r.raison, "aucun-profil");
});

test("un profil libre est retenu", () => {
  const c = compte("c1", {});
  const r = choisirProfil([profil("p1", { compte: c })]);
  assert.strictEqual(r.profil.id, "p1");
  assert.strictEqual(r.raison, "place-libre");
});

test("un profil plein n'est pas retenu", () => {
  const c = compte("c1", { occupantsActifs: 1 });
  const r = choisirProfil([profil("p1", { capacite: 1, occupantsActifs: 1, compte: c })]);
  assert.strictEqual(r.profil, null);
  assert.strictEqual(r.raison, "profils-pleins");
});

test("une capacité de 4 laisse entrer un quatrième occupant", () => {
  const c = compte("c1", { maxFluxSimultanes: 10, occupantsActifs: 3 });
  const r = choisirProfil([profil("p1", { capacite: 4, occupantsActifs: 3, compte: c })]);
  assert.strictEqual(r.profil.id, "p1");
});

// Les deux causes de refus doivent se distinguer : l'une se règle en ajoutant
// un profil, l'autre en achetant un compte.
test("compte saturé en flux : refus distinct de profils pleins", () => {
  const c = compte("c1", { maxFluxSimultanes: 4, occupantsActifs: 4 });
  const r = choisirProfil([profil("p1", { capacite: 4, occupantsActifs: 0, compte: c })]);
  assert.strictEqual(r.profil, null);
  assert.strictEqual(r.raison, "plafond-flux");
});

test("on étale : le compte avec le plus de marge l'emporte", () => {
  const charge = compte("charge", { maxFluxSimultanes: 4, occupantsActifs: 3 });
  const libre = compte("libre", { maxFluxSimultanes: 4, occupantsActifs: 0 });
  const r = choisirProfil([
    profil("p-charge", { capacite: 4, compte: charge }),
    profil("p-libre", { capacite: 4, compte: libre }),
  ]);
  assert.strictEqual(r.profil.id, "p-libre");
});

test("à marge égale, le profil le moins rempli l'emporte", () => {
  const c = compte("c1", { maxFluxSimultanes: 10, occupantsActifs: 3 });
  const r = choisirProfil([
    profil("p-rempli", { capacite: 4, occupantsActifs: 2, compte: c }),
    profil("p-vide", { capacite: 4, occupantsActifs: 1, compte: c }),
  ]);
  assert.strictEqual(r.profil.id, "p-vide");
});

test("à égalité complète, le plus ancien l'emporte — le choix reste déterministe", () => {
  const c = compte("c1", { maxFluxSimultanes: 10, occupantsActifs: 0 });
  const r = choisirProfil([
    profil("recent", { capacite: 4, compte: c, jour: 20 }),
    profil("ancien", { capacite: 4, compte: c, jour: 2 }),
  ]);
  assert.strictEqual(r.profil.id, "ancien");
});

// Deux cas que la première passe n'avait pas couverts. Le comportement était
// déjà correct, mais rien ne l'attestait : une simplification future de la
// garde `!candidats` ou du test `<` serait passée inaperçue.
test("appelée sans argument : traitée comme aucune candidature", () => {
  const r = choisirProfil();
  assert.strictEqual(r.profil, null);
  assert.strictEqual(r.raison, "aucun-profil");
});

test("une capacité nulle ou négative n'admet personne", () => {
  const c = compte("c1", { maxFluxSimultanes: 10, occupantsActifs: 0 });
  for (const capacite of [0, -1]) {
    const r = choisirProfil([profil("p1", { capacite, occupantsActifs: 0, compte: c })]);
    assert.strictEqual(r.profil, null, `capacite=${capacite} ne doit accueillir personne`);
    assert.strictEqual(r.raison, "profils-pleins");
  }
});
