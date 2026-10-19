const test = require("node:test");
const assert = require("node:assert");
const {
  verifierPlacement,
  verifierSuppression,
  normaliserDateFin,
  forceDemandee,
  resumeSuppression,
  validerClientHorsSite,
} = require("./administration");

// ── verifierPlacement ────────────────────────────────────────────────────────

test("placement : une place libre sous les deux plafonds est acceptée", () => {
  const r = verifierPlacement({ capacite: 4, occupantsActifs: 2, fluxMax: 4, fluxActifs: 3 });
  assert.strictEqual(r.ok, true);
});

test("placement : dernière place du profil et dernier flux du compte", () => {
  const r = verifierPlacement({ capacite: 4, occupantsActifs: 3, fluxMax: 4, fluxActifs: 3 });
  assert.strictEqual(r.ok, true);
});

test("placement : profil plein", () => {
  const r = verifierPlacement({ capacite: 2, occupantsActifs: 2, fluxMax: 8, fluxActifs: 0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.refus, "profil-plein");
  assert.match(r.message, /2/);
});

test("placement : compte au plafond de flux, profil pourtant libre", () => {
  const r = verifierPlacement({ capacite: 4, occupantsActifs: 0, fluxMax: 4, fluxActifs: 4 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.refus, "plafond-flux");
  assert.match(r.message, /4/);
});

// Les deux plafonds sont atteints : on nomme le profil, parce que c'est le
// seul des deux que l'admin peut résoudre en choisissant un autre profil.
test("placement : les deux plafonds atteints — le profil est nommé en premier", () => {
  const r = verifierPlacement({ capacite: 2, occupantsActifs: 2, fluxMax: 2, fluxActifs: 2 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.refus, "profil-plein");
});

// Une capacité illisible passerait toutes les comparaisons : `NaN >= x` vaut
// toujours faux, donc la garde serait silencieusement contournée et le profil
// dépasserait sa capacité. Le même défaut a déjà été corrigé dans
// `modifierProfil` — on le refuse ici explicitement.
test("placement : une valeur illisible est refusée, jamais ignorée", () => {
  for (const cas of [
    { capacite: NaN, occupantsActifs: 0, fluxMax: 4, fluxActifs: 0 },
    { capacite: 4, occupantsActifs: undefined, fluxMax: 4, fluxActifs: 0 },
    { capacite: 4, occupantsActifs: 0, fluxMax: undefined, fluxActifs: 0 },
    { capacite: 4, occupantsActifs: 0, fluxMax: 4, fluxActifs: "deux" },
  ]) {
    const r = verifierPlacement(cas);
    assert.strictEqual(r.ok, false, JSON.stringify(cas));
    assert.strictEqual(r.refus, "donnees-illisibles");
  }
});

// Un profil hérité, rattaché à aucun compte streaming, n'a aucun plafond de
// flux à respecter — il n'y a pas de compte pour en porter un. L'absence est
// déclarée par `null`, pour qu'elle ne se confonde jamais avec une valeur
// qu'on aurait échoué à lire.
test("placement : sans plafond de flux, seule la capacité compte", () => {
  const libre = verifierPlacement({
    capacite: 3, occupantsActifs: 1, fluxMax: null, fluxActifs: 99,
  });
  assert.strictEqual(libre.ok, true);

  const plein = verifierPlacement({
    capacite: 1, occupantsActifs: 1, fluxMax: null, fluxActifs: 0,
  });
  assert.strictEqual(plein.ok, false);
  assert.strictEqual(plein.refus, "profil-plein");
});

// ── verifierSuppression ──────────────────────────────────────────────────────

test("suppression : aucun obstacle", () => {
  const r = verifierSuppression([
    { nombre: 0, singulier: "occupation", pluriel: "occupations" },
  ]);
  assert.strictEqual(r.ok, true);
});

test("suppression : liste vide", () => {
  assert.strictEqual(verifierSuppression([]).ok, true);
});

test("suppression : un seul obstacle, au singulier", () => {
  const r = verifierSuppression([
    { nombre: 1, singulier: "occupation", pluriel: "occupations" },
  ]);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /1 occupation\b/);
  assert.doesNotMatch(r.message, /occupations/);
});

test("suppression : un seul obstacle, au pluriel", () => {
  const r = verifierSuppression([
    { nombre: 3, singulier: "occupation", pluriel: "occupations" },
  ]);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /3 occupations/);
});

// Le message doit nommer TOUT ce qui bloque : sinon l'admin corrige le premier
// obstacle, réessaie, et découvre le second — autant d'allers-retours que de
// tables référençant la ligne.
test("suppression : plusieurs obstacles sont tous nommés", () => {
  const r = verifierSuppression([
    { nombre: 2, singulier: "commande", pluriel: "commandes" },
    { nombre: 1, singulier: "client de lien", pluriel: "clients de liens" },
  ]);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /2 commandes/);
  assert.match(r.message, /1 client de lien\b/);
});

test("suppression : les obstacles à zéro ne sont pas nommés", () => {
  const r = verifierSuppression([
    { nombre: 0, singulier: "commande", pluriel: "commandes" },
    { nombre: 2, singulier: "occupation", pluriel: "occupations" },
  ]);
  assert.strictEqual(r.ok, false);
  assert.doesNotMatch(r.message, /commande/);
  assert.match(r.message, /2 occupations/);
});

// ── normaliserDateFin ────────────────────────────────────────────────────────

test("date de fin : absente, l'occupation n'expire pas", () => {
  for (const vide of [null, "", undefined]) {
    const r = normaliserDateFin(vide);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.date, null);
  }
});

// « jusqu'au 30 septembre » veut dire « toute la journée du 30 », pas « à
// minuit au début du 30 ». Le Bénin est à UTC+1, donc la fin de cette journée
// locale tombe à 22 h 59 UTC.
test("date de fin : un jour seul couvre toute la journée béninoise", () => {
  const r = normaliserDateFin("2026-09-30");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.date.toISOString(), "2026-09-30T22:59:59.999Z");
});

// Le formulaire du panel n'affiche qu'un jour. Rouvrir une occupation créée
// par un paiement (dont `expiresAt` porte l'heure de l'achat) puis enregistrer
// sans rien changer ne doit JAMAIS raccourcir l'accès du client : la borne se
// déplace vers la fin de la journée, jamais vers son début.
test("date de fin : un aller-retour par le formulaire n'ampute pas le client", () => {
  const achat = new Date("2026-09-30T14:32:00.000Z");
  const jourAffiche = achat.toISOString().slice(0, 10);
  const apres = normaliserDateFin(jourAffiche).date;
  assert.ok(apres.getTime() > achat.getTime());
  // Et l'aller-retour suivant est stable : le jour affiché ne glisse pas.
  assert.strictEqual(apres.toISOString().slice(0, 10), jourAffiche);
});

// Un horodatage complet vient d'un appel API, pas du formulaire : on le
// respecte tel quel plutôt que de l'arrondir à une journée.
test("date de fin : un horodatage complet est conservé", () => {
  const r = normaliserDateFin("2026-09-30T14:32:00.000Z");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.date.toISOString(), "2026-09-30T14:32:00.000Z");
});

test("date de fin : une valeur illisible est refusée", () => {
  for (const mauvais of ["hier", "2026-13-45", "30/09/2026", {}]) {
    assert.strictEqual(normaliserDateFin(mauvais).ok, false, String(mauvais));
  }
});


// ── forceDemandee ────────────────────────────────────────────────────────────

// Le forçage détruit de l'historique client : il ne doit JAMAIS s'activer par
// défaut, ni par une valeur approchante. Une chaîne vide, un `0` ou un `?force`
// nu venus d'une URL mal formée doivent laisser la garde en place.
test("force : absente par défaut", () => {
  assert.strictEqual(forceDemandee({}), false);
  assert.strictEqual(forceDemandee({ query: {} }), false);
  assert.strictEqual(forceDemandee(undefined), false);
});

test("force : seules les valeurs explicites l'activent", () => {
  for (const v of ["1", "true", true]) {
    assert.strictEqual(forceDemandee({ query: { force: v } }), true, String(v));
  }
});

test("force : une valeur approchante ne force pas", () => {
  for (const v of ["", "0", "false", "oui", 1, null]) {
    assert.strictEqual(forceDemandee({ query: { force: v } }), false, String(v));
  }
});

// Un DELETE porte rarement un corps, mais les deux clients existent : lire une
// seule des deux sources rendrait un bouton « Supprimer quand même » sans effet.
test("force : lue aussi dans le corps de la requête", () => {
  assert.strictEqual(forceDemandee({ body: { force: true } }), true);
  assert.strictEqual(forceDemandee({ query: {}, body: { force: "1" } }), true);
});

// ── resumeSuppression ────────────────────────────────────────────────────────

const LIBELLES = {
  commandes: ["commande", "commandes"],
  occupations: ["client placé", "clients placés"],
};

test("résumé : rien d'emporté ne produit aucune incise", () => {
  assert.strictEqual(resumeSuppression({ commandes: 0, occupations: 0 }, LIBELLES), "");
  assert.strictEqual(resumeSuppression({}, LIBELLES), "");
  assert.strictEqual(resumeSuppression(undefined, LIBELLES), "");
});

test("résumé : le singulier et le pluriel suivent le compte", () => {
  assert.strictEqual(
    resumeSuppression({ commandes: 1, occupations: 3 }, LIBELLES),
    " (emporté : 1 commande, 3 clients placés)",
  );
});

// Un zéro tu au milieu ne doit pas laisser de virgule orpheline : l'admin lit
// ce compte rendu comme la seule trace de ce qu'il vient de détruire.
test("résumé : les catégories vides sont tues", () => {
  assert.strictEqual(
    resumeSuppression({ commandes: 0, occupations: 2 }, LIBELLES),
    " (emporté : 2 clients placés)",
  );
});

// ── validerClientHorsSite ────────────────────────────────────────────────────
//
// Refonte OTP du 13/10/2026. Des clients detenaient les identifiants du compte
// Netflix B sans jamais avoir commande sur le site : invisibles pour le bot,
// qui envoyait donc tous les codes de B au seul client enregistre. Le panel
// doit pouvoir les enregistrer. La saisie est validee ici, pure.

const MAINTENANT = new Date("2026-10-13T12:00:00Z");
const valide = { nom: "  Koffi Mensah ", whatsapp: "+229 01 97 00 00 00", finLe: "2026-11-13" };

test("hors site : une saisie complete est acceptee et nettoyee", () => {
  const r = validerClientHorsSite(valide, { aVie: false, maintenant: MAINTENANT });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.valeurs.nom, "Koffi Mensah");
  assert.strictEqual(r.valeurs.whatsapp, "+2290197000000");
  assert.strictEqual(r.valeurs.montant, 0, "sans montant saisi : 0, pas de chiffre d'affaires invente");
  assert.strictEqual(r.valeurs.email, null);
  assert.strictEqual(r.valeurs.finLe.toISOString().slice(0, 10), "2026-11-13");
});

test("hors site : le nom et le WhatsApp sont obligatoires", () => {
  assert.strictEqual(validerClientHorsSite({ ...valide, nom: " " }, { maintenant: MAINTENANT }).ok, false);
  assert.strictEqual(validerClientHorsSite({ ...valide, whatsapp: "" }, { maintenant: MAINTENANT }).ok, false);
});

// C'est le numero qui decide a qui part le code : un numero illisible
// enverrait les codes dans le vide.
test("hors site : un numero WhatsApp illisible est refuse", () => {
  assert.strictEqual(validerClientHorsSite({ ...valide, whatsapp: "abc" }, { maintenant: MAINTENANT }).ok, false);
  assert.strictEqual(validerClientHorsSite({ ...valide, whatsapp: "1234" }, { maintenant: MAINTENANT }).ok, false);
});

test("hors site : une echeance est obligatoire, et dans le futur", () => {
  assert.strictEqual(validerClientHorsSite({ ...valide, finLe: "" }, { aVie: false, maintenant: MAINTENANT }).ok, false);
  assert.strictEqual(validerClientHorsSite({ ...valide, finLe: "2026-10-01" }, { aVie: false, maintenant: MAINTENANT }).ok, false);
  assert.strictEqual(validerClientHorsSite({ ...valide, finLe: "pas une date" }, { aVie: false, maintenant: MAINTENANT }).ok, false);
});

test("hors site : une formule a vie n'a pas d'echeance", () => {
  const r = validerClientHorsSite({ ...valide, finLe: "" }, { aVie: true, maintenant: MAINTENANT });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.valeurs.finLe, null);
});

test("hors site : le montant est un entier positif en FCFA", () => {
  assert.strictEqual(validerClientHorsSite({ ...valide, montant: "2500" }, { maintenant: MAINTENANT }).valeurs.montant, 2500);
  assert.strictEqual(validerClientHorsSite({ ...valide, montant: -5 }, { maintenant: MAINTENANT }).ok, false);
  assert.strictEqual(validerClientHorsSite({ ...valide, montant: "12.5" }, { maintenant: MAINTENANT }).ok, false);
});

test("hors site : un e-mail mal forme est refuse, un e-mail valide est garde", () => {
  assert.strictEqual(validerClientHorsSite({ ...valide, email: "pas-un-mail" }, { maintenant: MAINTENANT }).ok, false);
  assert.strictEqual(
    validerClientHorsSite({ ...valide, email: " Client@Mail.com " }, { maintenant: MAINTENANT }).valeurs.email,
    "client@mail.com",
  );
});
