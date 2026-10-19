const test = require("node:test");
const assert = require("node:assert");
const {
  fichiersElaguables,
  intervalleElagageMs,
  HEURES_PAR_DEFAUT,
  MAX_HEURES,
} = require("./whatsappElagage");

// Un echantillon fidele a ce qu'on trouve reellement dans un dossier de
// session, releve en production.
const ECHANTILLON = [
  "creds.json",
  "app-state-sync-key-AAAAAA.json",
  "app-state-sync-version-critical_block.json",
  "pre-key-1024.json",
  "identity-key-100111996719124_1.0.json",
  "session-100111996719124_1.0.json",
  "lid-mapping-100111996719124_reverse.json",
  "sender-key-status@broadcast_22960506320@s.whatsapp.net.json",
  "sender-key-status@broadcast_22997437551@s.whatsapp.net.json",
  "sender-key-120363432897555179@g.us_22960506320@s.whatsapp.net.json",
  "device-list-22944314670.json",
];

test("seules les cles de statut sont elaguees", () => {
  const a = fichiersElaguables(ECHANTILLON);
  assert.strictEqual(a.length, 2);
  assert.ok(a.every((n) => n.startsWith("sender-key-status@")));
});

// Chacune de ces familles, supprimee, casse quelque chose de precis. Le test
// nomme la consequence pour qu'un futur elargissement soit un choix, pas un
// glissement.
test("l identite, la synchronisation et les cles par contact sont conservees", () => {
  const a = fichiersElaguables(ECHANTILLON);
  for (const garde of [
    "creds.json",                                  // perte = nouveau QR
    "app-state-sync-key-AAAAAA.json",              // perte = nouveau QR
    "app-state-sync-version-critical_block.json",
    "pre-key-1024.json",                           // ouverture par un nouveau contact
    "identity-key-100111996719124_1.0.json",       // identite du contact
    "session-100111996719124_1.0.json",            // chiffrement du contact
    "lid-mapping-100111996719124_reverse.json",    // savoir repondre a un entrant
    "device-list-22944314670.json",
  ]) {
    assert.ok(!a.includes(garde), garde + " ne doit jamais etre elague");
  }
});

// Le piege : les deux commencent par `sender-key-`. Seul `status@` distingue
// une cle de diffusion d'une cle de groupe legitime.
test("une cle de GROUPE n est pas confondue avec une cle de statut", () => {
  const a = fichiersElaguables([
    "sender-key-120363432897555179@g.us_22960506320@s.whatsapp.net.json",
    "sender-key-status@broadcast_22960506320@s.whatsapp.net.json",
  ]);
  assert.strictEqual(a.length, 1);
  assert.ok(a[0].includes("status@"));
});

test("une entree qui n est pas une chaine est ignoree, sans lever", () => {
  const a = fichiersElaguables(["sender-key-status@x.json", null, 42, undefined, {}]);
  assert.deepStrictEqual(a, ["sender-key-status@x.json"]);
});

test("une entree absurde rend un tableau vide", () => {
  for (const v of [null, undefined, "chaine", 42, {}]) {
    assert.deepStrictEqual(fichiersElaguables(v), []);
  }
});

// ── Fréquence ───────────────────────────────────────────────────────────────

test("sans reglage, l intervalle par defaut s applique", () => {
  const attendu = HEURES_PAR_DEFAUT * 3600 * 1000;
  for (const v of [undefined, null, ""]) {
    assert.strictEqual(intervalleElagageMs(v), attendu);
  }
});

test("un reglage valide est converti en millisecondes", () => {
  assert.strictEqual(intervalleElagageMs(6), 6 * 3600 * 1000);
  assert.strictEqual(intervalleElagageMs("12"), 12 * 3600 * 1000);
});

// Zero DESACTIVE. Un reglage incomprehensible ne doit pas produire un
// comportement surprenant sur une session de production : il ne fait rien.
test("zero, negatif ou illisible desactive l elagage", () => {
  for (const v of [0, "0", -1, -100, "abc", NaN, Infinity]) {
    assert.strictEqual(intervalleElagageMs(v), 0, "valeur : " + String(v));
  }
});

test("une valeur absurde est bornee plutot que subie", () => {
  // Un an reviendrait a desactiver sans le dire.
  assert.strictEqual(intervalleElagageMs(24 * 365), MAX_HEURES * 3600 * 1000);
});
