const test = require("node:test");
const assert = require("node:assert");
const { transitionAutorisee, libelleStatut, messageClient } = require("./statuts");

test("statuts : on avance d'un cran", () => {
  assert.strictEqual(transitionAutorisee("PAYEE", "A_RECUPERER").ok, true);
  assert.strictEqual(transitionAutorisee("RECUPEREE", "EN_ATELIER").ok, true);
  assert.strictEqual(transitionAutorisee("A_RENDRE", "RENDUE").ok, true);
});

// Reculer est refusé : un statut est une promesse faite au client, et le faire
// revenir en arrière produirait une seconde notification contradictoire.
test("statuts : on ne recule pas", () => {
  const r = transitionAutorisee("EN_ATELIER", "PAYEE");
  assert.strictEqual(r.ok, false);
  assert.match(r.erreur, /revenir|arrière/i);
});

test("statuts : on ne saute pas une étape", () => {
  assert.strictEqual(transitionAutorisee("PAYEE", "REPAREE").ok, false);
});

// L'annulation part de partout : un appareil peut se révéler irréparable à
// n'importe quel moment.
test("statuts : ANNULEE est atteignable depuis n'importe quel état", () => {
  for (const depuis of ["EN_ATTENTE", "PAYEE", "RECUPEREE", "EN_ATELIER", "A_RENDRE"]) {
    assert.strictEqual(transitionAutorisee(depuis, "ANNULEE").ok, true, depuis);
  }
});

test("statuts : rien ne sort de RENDUE ni de ANNULEE", () => {
  assert.strictEqual(transitionAutorisee("RENDUE", "A_RENDRE").ok, false);
  assert.strictEqual(transitionAutorisee("ANNULEE", "PAYEE").ok, false);
});

test("statuts : un statut inconnu est refusé, pas ignoré", () => {
  assert.strictEqual(transitionAutorisee("PAYEE", "PARTIE_EN_VACANCES").ok, false);
  assert.strictEqual(transitionAutorisee(undefined, "PAYEE").ok, false);
});

test("statuts : chaque état a un libellé lisible", () => {
  assert.strictEqual(libelleStatut("A_RECUPERER"), "À récupérer");
  assert.strictEqual(libelleStatut("EN_ATELIER"), "En atelier");
});

// Le paiement ne déclenche AUCUN message : le client vient de payer, il sait.
test("statuts : le passage à PAYEE ne notifie pas le client", () => {
  assert.strictEqual(messageClient("PAYEE"), null);
  assert.ok(messageClient("A_RECUPERER"));
  assert.ok(messageClient("RENDUE"));
});
