const test = require("node:test");
const assert = require("node:assert");
const {
  validerNouveauMotDePasse,
  LONGUEUR_MIN_MOT_DE_PASSE,
} = require("./settings.controller");

// ── Le defaut que ces cas verrouillent ──────────────────────────────────────
//
// Le code testait `if (key === "adminPassword" && value)`. Une chaine vide est
// falsy : elle echappait au hachage et etait enregistree TELLE QUELLE. Le mot
// de passe devenait "", bcrypt.compare ne pouvait plus jamais correspondre, et
// PERSONNE ne pouvait se reconnecter — alors que l'API repondait
// « Parametres mis a jour ».

test("une chaine vide est refusee, jamais enregistree", () => {
  const r = validerNouveauMotDePasse("");
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /vide/i);
});

test("des espaces seuls ne constituent pas un mot de passe", () => {
  for (const valeur of [" ", "   ", "\t", "\n  \t"]) {
    assert.strictEqual(validerNouveauMotDePasse(valeur).ok, false);
  }
});

test("ce qui n'est pas une chaine est refuse", () => {
  for (const valeur of [undefined, null, 0, 12345678, true, {}, []]) {
    assert.strictEqual(validerNouveauMotDePasse(valeur).ok, false);
  }
});

test("un mot de passe trop court est refuse", () => {
  const court = "a".repeat(LONGUEUR_MIN_MOT_DE_PASSE - 1);
  const r = validerNouveauMotDePasse(court);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, new RegExp(String(LONGUEUR_MIN_MOT_DE_PASSE)));
});

test("pile a la longueur minimale, il passe", () => {
  const pile = "a".repeat(LONGUEUR_MIN_MOT_DE_PASSE);
  assert.strictEqual(validerNouveauMotDePasse(pile).ok, true);
});

test("un mot de passe valide est rendu INTACT", () => {
  // Pas de `trim()` sur la valeur conservee : un espace de tete ou de fin peut
  // faire partie du mot de passe choisi. Le rogner enregistrerait autre chose
  // que ce que l'exploitant a tape — et il ne pourrait plus se connecter.
  const valeur = " Mot De Passe Avec Espaces ";
  const r = validerNouveauMotDePasse(valeur);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.valeur, valeur);
});
