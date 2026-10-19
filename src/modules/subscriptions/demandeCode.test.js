const test = require("node:test");
const assert = require("node:assert");
const {
  FENETRE_MS,
  PLAFOND_TENTATIVES,
  normaliserNumero,
  memeNumero,
  choisirDemande,
  motCleDemande,
  compterTentatives,
  plafondAtteint,
} = require("./demandeCode");

// ── Normalisation des numéros ────────────────────────────────────────────────
// `clientWhatsapp` est saisi à la main et stocké tel quel ; Baileys livre un
// identifiant technique. Sans normalisation, une demande sur deux échouerait.

test("retire l'indicatif technique de Baileys", () => {
  assert.strictEqual(normaliserNumero("22997437551@s.whatsapp.net"), "22997437551");
});

test("retire le plus, les espaces et les tirets", () => {
  assert.strictEqual(normaliserNumero("+229 97 43-75 51"), "22997437551");
});

test("un numéro trop court n'est pas un numéro", () => {
  assert.strictEqual(normaliserNumero("1234"), null);
  assert.strictEqual(normaliserNumero(""), null);
  assert.strictEqual(normaliserNumero(null), null);
});

test("deux écritures du même numéro se reconnaissent", () => {
  assert.strictEqual(memeNumero("+229 97 43 75 51", "22997437551@s.whatsapp.net"), true);
});

test("deux numéros différents ne se confondent pas", () => {
  assert.strictEqual(memeNumero("22997437551", "22997437552"), false);
});

test("un numéro illisible ne correspond à rien, pas même à lui-même", () => {
  assert.strictEqual(memeNumero("abc", "abc"), false);
});

// ── Mot-clé ──────────────────────────────────────────────────────────────────
// Le numéro de la boutique sert aussi au service client. Le bot ne réagit donc
// qu'à un mot exact : « je veux un code » est une conversation, pas une
// commande, et y répondre automatiquement serait s'immiscer dedans.

test("reconnait le mot-cle quelle que soit la casse et les espaces", () => {
  for (const t of ["CODE", "code", "  Code  ", "cOdE"]) {
    assert.strictEqual(motCleDemande(t), true, `« ${t} » doit declencher`);
  }
});

test("reste muet sur tout autre message", () => {
  for (const t of ["bonjour", "je veux un code svp", "codes", "", null]) {
    assert.strictEqual(motCleDemande(t), false, `« ${t} » ne doit pas declencher`);
  }
});

// ── Choix de la demande ──────────────────────────────────────────────────────

const demande = (id, minutes, servedAt = null) => ({
  id,
  requestedAt: new Date(Date.UTC(2026, 7, 20, 12, minutes)),
  expiresAt: new Date(Date.UTC(2026, 7, 20, 12, minutes) + FENETRE_MS),
  servedAt,
});
const MAINTENANT = new Date(Date.UTC(2026, 7, 20, 12, 10));

test("aucune demande : personne n'attend", () => {
  assert.strictEqual(choisirDemande([], MAINTENANT), null);
  assert.strictEqual(choisirDemande(undefined, MAINTENANT), null);
});

test("une seule demande valide : retenue", () => {
  const d = demande("a", 5);
  assert.strictEqual(choisirDemande([d], MAINTENANT).id, "a");
});

// Le dernier à avoir tenté de se connecter est presque toujours celui qui a
// declenche le mail.
test("plusieurs demandes valides : la plus recente l'emporte", () => {
  const r = choisirDemande([demande("vieille", 1), demande("recente", 8)], MAINTENANT);
  assert.strictEqual(r.id, "recente");
});

test("une demande expiree ne capte aucun code", () => {
  assert.strictEqual(choisirDemande([demande("expiree", -30)], MAINTENANT), null);
});

test("une demande deja servie ne sert pas deux fois", () => {
  const servie = demande("servie", 5, new Date(Date.UTC(2026, 7, 20, 12, 6)));
  assert.strictEqual(choisirDemande([servie], MAINTENANT), null);
});

test("entre une recente servie et une plus ancienne valide, la valide gagne", () => {
  const servie = demande("recente-servie", 8, new Date(Date.UTC(2026, 7, 20, 12, 9)));
  const r = choisirDemande([servie, demande("ancienne-valide", 3)], MAINTENANT);
  assert.strictEqual(r.id, "ancienne-valide");
});

// ── Priorité de canal ────────────────────────────────────────────────────────
// Le formulaire public n'établit aucune identité : on y DÉCLARE un numéro. Sur
// WhatsApp, l'identité de l'expéditeur est établie par le canal lui-même. Un
// tiers qui poste le numéro d'un client ne doit donc pas pouvoir évincer la
// demande que ce client vient de faire depuis WhatsApp.

const demandeCanal = (id, minutes, canal) => ({
  ...demande(id, minutes),
  canal,
});

test("une demande whatsapp prime sur une demande web plus recente", () => {
  const r = choisirDemande(
    [demandeCanal("web-recente", 9, "web"), demandeCanal("wa-ancienne", 1, "whatsapp")],
    MAINTENANT,
  );
  assert.strictEqual(r.id, "wa-ancienne");
});

test("a canal egal, la plus recente l'emporte toujours", () => {
  const web = choisirDemande(
    [demandeCanal("web-1", 2, "web"), demandeCanal("web-2", 8, "web")],
    MAINTENANT,
  );
  assert.strictEqual(web.id, "web-2");

  const wa = choisirDemande(
    [demandeCanal("wa-1", 2, "whatsapp"), demandeCanal("wa-2", 8, "whatsapp")],
    MAINTENANT,
  );
  assert.strictEqual(wa.id, "wa-2");
});

// La priorite ne doit pas ressusciter une demande whatsapp expiree ou servie :
// le filtre de validite passe AVANT le classement.
test("une demande whatsapp expiree ne prime sur rien", () => {
  const r = choisirDemande(
    [demandeCanal("wa-expiree", -30, "whatsapp"), demandeCanal("web-valide", 5, "web")],
    MAINTENANT,
  );
  assert.strictEqual(r.id, "web-valide");
});

// ── Plafond anti-abus : par tentative, pas par ligne ─────────────────────────
// `ouvrirDemandes` cree UNE LIGNE PAR OCCUPATION ACTIVE. Compter les lignes
// bloquerait un client a 3 services des sa 2e tentative — precisement quand il
// redemande parce qu'il n'a rien recu.

// Une tentative = toutes les lignes posees au meme instant.
const tentative = (minute, occupations) =>
  Array.from({ length: occupations }, (_, i) => ({
    id: `t${minute}-${i}`,
    requestedAt: new Date(Date.UTC(2026, 7, 20, 12, minute)),
  }));

test("un numero a 3 occupations peut faire 5 tentatives, pas une seule", () => {
  const lignes = [];
  for (let n = 0; n < 4; n += 1) {
    lignes.push(...tentative(n, 3));
    // 4 tentatives = 12 lignes. L'ancien comptage bloquait des la 2e.
    assert.strictEqual(plafondAtteint(lignes), false, `bloque a la tentative ${n + 1}`);
  }
  assert.strictEqual(compterTentatives(lignes), 4);
  assert.strictEqual(lignes.length, 12);

  lignes.push(...tentative(4, 3));
  assert.strictEqual(compterTentatives(lignes), 5);
  assert.strictEqual(plafondAtteint(lignes), true);
});

test("le plafond reste atteignable pour un numero a une seule occupation", () => {
  const lignes = [];
  for (let n = 0; n < PLAFOND_TENTATIVES; n += 1) lignes.push(...tentative(n, 1));
  assert.strictEqual(plafondAtteint(lignes), true);
});

test("aucune demande, aucune tentative", () => {
  assert.strictEqual(compterTentatives([]), 0);
  assert.strictEqual(compterTentatives(undefined), 0);
  assert.strictEqual(plafondAtteint([]), false);
});

// ── Formes locale et internationale du meme numero ───────────────────────────
//
// Au Benin, un client ecrit spontanement son numero local (« 97 00 00 00 »)
// tandis que la commande, elle, l a enregistre en international
// (« +229 97 00 00 00 »). L egalite stricte des chiffres les separait : la
// demande ne trouvait aucune occupation, et le canal web repondait quand meme
// « Demande enregistree » — le client attendait un code qui ne pouvait pas
// partir. C est exactement la panne remontee apres le test en production.

test("numero : forme locale et forme internationale se rejoignent", () => {
  assert.strictEqual(memeNumero("97000000", "22997000000"), true);
  assert.strictEqual(memeNumero("+229 97 00 00 00", "97 00 00 00"), true);
  assert.strictEqual(memeNumero("0022997000000", "22997000000"), true);
});

// Le Togo est en +228, le Benin en +229 : deux numeros complets ne differant
// que par l indicatif designent des personnes differentes. Deux numeros de
// MEME longueur sont donc compares a l identique, jamais par leur fin.
test("numero : deux indicatifs differents ne se confondent pas", () => {
  assert.strictEqual(memeNumero("22897000000", "22997000000"), false);
});

// En dessous de huit chiffres communs, un rapprochement par la fin
// rassemblerait des inconnus.
test("numero : une fin trop courte ne suffit pas", () => {
  assert.strictEqual(memeNumero("1234567", "229971234567"), false);
});

test("numero : l identite stricte marche toujours", () => {
  assert.strictEqual(memeNumero("22997000000", "+229 97 00 00 00"), true);
  assert.strictEqual(memeNumero("22997000000", "22997000001"), false);
});

test("numero : une valeur absente ne rapproche rien", () => {
  for (const vide of [null, undefined, "", "abc"]) {
    assert.strictEqual(memeNumero(vide, "22997000000"), false);
    assert.strictEqual(memeNumero("22997000000", vide), false);
  }
});
