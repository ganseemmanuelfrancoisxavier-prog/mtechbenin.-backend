const test = require("node:test");
const assert = require("node:assert");
const {
  extraireAdressage,
  horodatageMs,
  messageTropAncien,
  TOLERANCE_ARRIERE_MS,
} = require("./whatsappMessage");

// ── Adressage ────────────────────────────────────────────────────────────────
// Deux valeurs, jamais interchangeables : à quoi répondre, et quoi rapprocher
// des occupations. Sur un identifiant masqué elles n'ont pas les mêmes chiffres.

test("JID classique : l'adresse et le numéro sont la même valeur", () => {
  const r = extraireAdressage({ remoteJid: "22997437551@s.whatsapp.net" });
  assert.strictEqual(r.adresse, "22997437551@s.whatsapp.net");
  assert.strictEqual(r.numero, "22997437551@s.whatsapp.net");
  assert.strictEqual(r.masque, false);
});

test("JID masqué avec remoteJidAlt : on répond au LID, on rapproche sur l'alt", () => {
  const r = extraireAdressage({
    remoteJid: "123456789012345@lid",
    remoteJidAlt: "22997437551@s.whatsapp.net",
    addressingMode: "lid",
  });
  // L'adresse de réponse est le JID D'ORIGINE, repris tel quel : reconstruire
  // `<chiffres du LID>@s.whatsapp.net` viserait un numéro inexistant.
  assert.strictEqual(r.adresse, "123456789012345@lid");
  assert.strictEqual(r.numero, "22997437551@s.whatsapp.net");
  assert.strictEqual(r.masque, true);
});

// Les chiffres d'un LID font plus de 8 caractères : `normaliserNumero` les
// accepterait, aucune occupation ne correspondrait, et le client s'entendrait
// répondre qu'il n'a aucun abonnement. On préfère ne rien rendre.
test("JID masqué sans remoteJidAlt : aucun numéro exploitable", () => {
  assert.strictEqual(extraireAdressage({ remoteJid: "123456789012345@lid" }), null);
  assert.strictEqual(
    extraireAdressage({ remoteJid: "123456789012345@lid", remoteJidAlt: "" }),
    null,
  );
});

test("clé absente ou sans remoteJid : rien à traiter", () => {
  assert.strictEqual(extraireAdressage(undefined), null);
  assert.strictEqual(extraireAdressage({}), null);
  assert.strictEqual(extraireAdressage({ remoteJid: 12345 }), null);
});

// ── Horodatage ───────────────────────────────────────────────────────────────

test("lit un horodatage en secondes", () => {
  assert.strictEqual(horodatageMs(1_700_000_000), 1_700_000_000_000);
});

test("lit un horodatage en Long protobuf", () => {
  assert.strictEqual(horodatageMs({ low: 1_700_000_000, high: 0 }), 1_700_000_000_000);
  assert.strictEqual(
    horodatageMs({ toNumber: () => 1_700_000_000 }),
    1_700_000_000_000,
  );
});

test("un horodatage illisible ne se devine pas", () => {
  for (const brut of [undefined, null, "", "abc", {}, 0, -5, NaN]) {
    assert.strictEqual(horodatageMs(brut), null, `« ${String(brut)} » doit rendre null`);
  }
});

// ── Messages rejoués à la reconnexion ────────────────────────────────────────

const MAINTENANT = 1_700_000_000_000;

test("un message reçu à l'instant passe", () => {
  assert.strictEqual(messageTropAncien(MAINTENANT / 1000, MAINTENANT), false);
});

test("un message d'il y a deux jours est écarté", () => {
  const ilYADeuxJours = (MAINTENANT - 2 * 24 * 3600 * 1000) / 1000;
  assert.strictEqual(messageTropAncien(ilYADeuxJours, MAINTENANT), true);
});

// La dérive entre l'horloge du serveur et celle de WhatsApp ne doit pas jeter
// une demande légitime : un message daté LÉGÈREMENT dans le futur reste valide.
test("un message légèrement en avance sur l'horloge du serveur passe", () => {
  const dansTrenteSecondes = (MAINTENANT + 30_000) / 1000;
  assert.strictEqual(messageTropAncien(dansTrenteSecondes, MAINTENANT), false);
});

test("la bascule se fait à la tolérance annoncée", () => {
  const juste = (MAINTENANT - TOLERANCE_ARRIERE_MS) / 1000;
  const audela = (MAINTENANT - TOLERANCE_ARRIERE_MS - 1000) / 1000;
  assert.strictEqual(messageTropAncien(juste, MAINTENANT), false);
  assert.strictEqual(messageTropAncien(audela, MAINTENANT), true);
});

// Explicitement : un message sans horodatage lisible ne doit PAS être jeté.
test("un message sans horodatage lisible n'est jamais écarté", () => {
  for (const brut of [undefined, null, "abc", {}]) {
    assert.strictEqual(messageTropAncien(brut, MAINTENANT), false);
  }
});
