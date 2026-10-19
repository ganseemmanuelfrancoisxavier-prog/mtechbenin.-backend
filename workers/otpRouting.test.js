const test = require("node:test");
const assert = require("node:assert");
const {
  decideEnvoi,
  dernierAcheteur,
  choisirCompteDestinataire,
  detientIdentifiantsDeLaBoite,
  estCourrielInterne,
  estCourrielRecent,
  choisirDestinataire,
} = require("./otpRouting");

// ── L'invariant des identifiants ────────────────────────────────────────────
//
// Regle du proprietaire : qui recoit le code venu d'une adresse doit avoir recu
// des identifiants portant CETTE adresse.
//
// `dechiffrerIdentifiants` compose le mail envoye au client comme
// `profil.email || compte.email` : un profil dont le mail est renseigne PRIME
// sur celui de son compte. Rien n'impose que les deux concordent — c'est par
// la que l'invariant peut se rompre sans qu'aucun ecran ne le montre.

const occupationAvecProfil = (mailProfil) => ({
  id: "occ-1",
  profile: { id: "p-1", profile: "AMSTERDAM", email: mailProfil },
});

test("identifiants : un profil sans mail propre herite de son compte, deja rapproche", () => {
  assert.strictEqual(
    detientIdentifiantsDeLaBoite(occupationAvecProfil(""), "boite@gmail.com"),
    true,
  );
  assert.strictEqual(
    detientIdentifiantsDeLaBoite(occupationAvecProfil(null), "boite@gmail.com"),
    true,
  );
});

test("identifiants : un profil dont le mail est celui de la boite passe", () => {
  assert.strictEqual(
    detientIdentifiantsDeLaBoite(occupationAvecProfil("Boite@Gmail.com "), "boite@gmail.com"),
    true,
    "la casse, les espaces et les points gmail ne separent pas deux ecritures",
  );
});

// Le cas qui rompt la regle : le client detient des identifiants pour une autre
// adresse. Aucun code venu de cette boite ne peut marcher chez lui, et celui-ci
// ouvrirait le foyer de quelqu'un d'autre.
test("identifiants : un profil portant un AUTRE mail ne recoit pas ce code", () => {
  assert.strictEqual(
    detientIdentifiantsDeLaBoite(occupationAvecProfil("autre-compte@gmail.com"), "boite@gmail.com"),
    false,
  );
});

test("identifiants : sans boite connue, il n'y a rien a verifier", () => {
  assert.strictEqual(detientIdentifiantsDeLaBoite(occupationAvecProfil("x@y.com"), null), true);
});

// Un mail arrive par renvoi dans une boite tierce : Netflix l'a ECRIT au compte,
// la boite connectee n'est que le transport. Le verrou comparait le mail du
// profil a la boite connectee, et ecartait donc a tort un occupant dont le
// profil porte, en toutes lettres, l'adresse a laquelle le code a ete envoye.
test("identifiants : par renvoi, l'adresse ecrite par le service fait foi", () => {
  assert.strictEqual(
    detientIdentifiantsDeLaBoite(occupationAvecProfil("compte@gmail.com"), [
      "boite-tierce@gmail.com",
      "compte@gmail.com",
    ]),
    true,
  );
  assert.strictEqual(
    detientIdentifiantsDeLaBoite(occupationAvecProfil("autre@gmail.com"), [
      "boite-tierce@gmail.com",
      "compte@gmail.com",
    ]),
    false,
  );
});

// ── Les mails que la plateforme s'envoie a elle-meme ────────────────────────
//
// Incident du 12/10/2026, releve dans les journaux du VPS. `ADMIN_EMAIL` est
// aussi la boite d'un compte Netflix surveille. A chaque code livre, le bot
// envoie a l'administrateur « 🔐 OTP reçu — Netflix : 1574 » ; il relisait
// cette alerte dans sa propre boite, n'y trouvait pas de marque dans
// l'expediteur, retombait sur l'objet — qui dit « Netflix » — et renvoyait le
// code au dernier acheteur de ce compte. Chaque code partait ainsi une seconde
// fois, chez un client a qui il n'etait pas destine.
const INTERNES = ["mtechbenin.com"];

test("interne : l'alerte que le bot s'envoie n'est jamais un mail de service", () => {
  assert.strictEqual(estCourrielInterne("noreply@mtechbenin.com", INTERNES), true);
  assert.strictEqual(estCourrielInterne('"MTECHBENIN" <noreply@mtechbenin.com>', INTERNES), true);
});

test("interne : la casse et un sous-domaine ne la font pas passer", () => {
  assert.strictEqual(estCourrielInterne("NoReply@MTECHBENIN.com", INTERNES), true);
  assert.strictEqual(estCourrielInterne("alerte@mail.mtechbenin.com", INTERNES), true);
});

test("interne : un vrai mail de service passe", () => {
  assert.strictEqual(estCourrielInterne("info@account.netflix.com", INTERNES), false);
});

// Un domaine qui CONTIENT le notre n'est pas le notre : un simple `includes`
// laisserait un tiers faire taire le bot en s'inscrivant sur un tel domaine.
test("interne : un domaine voisin n'est pas le notre", () => {
  assert.strictEqual(estCourrielInterne("x@faux-mtechbenin.com", INTERNES), false);
  assert.strictEqual(estCourrielInterne("x@mtechbenin.com.evil.io", INTERNES), false);
});

test("interne : sans expediteur, rien n'est presume", () => {
  assert.strictEqual(estCourrielInterne("", INTERNES), false);
  assert.strictEqual(estCourrielInterne(null, INTERNES), false);
  assert.strictEqual(estCourrielInterne("noreply@mtechbenin.com", []), false);
});

const occupation = (id, nom, achat = null) => ({
  id,
  occupantName: nom,
  occupantWhatsapp: "229" + id,
  order: { id: "cmd-" + id, createdAt: achat },
});

// ── Services famille : la décision se prend sur les occupations du compte ────

test("une seule occupation active : le code part à cet occupant", () => {
  const occ = occupation("1", "Kofi");
  const r = decideEnvoi({ categorieService: "family", occupationsActives: [occ] });
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.raison, "occupant-unique");
  assert.strictEqual(r.occupation.id, "1");
});

// Le cœur du partage : un code de foyer arrive sur le COMPTE et n'indique ni
// le profil ni la personne.
//
// Ces occupants ont reçu des identifiants dont l'adresse EST celle de la boîte
// d'où sort ce code : il est réellement destiné à l'un d'entre eux. Le dernier
// acheteur est le pari le moins mauvais, et l'admin est alerté.
//
// À NE PAS CONFONDRE avec le repli par service, plus bas, qui désignait le
// dernier acheteur de TOUT le service — sans lien avec la boîte. C'est ce
// dernier, et lui seul, qui envoyait les codes de tout le monde à une seule
// personne.
test("plusieurs occupations sur le compte de la boîte : le dernier acheteur reçoit", () => {
  const kofi = occupation("1", "Kofi", "2026-01-10T00:00:00Z");
  const ama = occupation("2", "Ama", "2026-03-02T00:00:00Z");
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [kofi, ama],
  });
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.raison, "dernier-acheteur");
  assert.strictEqual(r.occupation.id, "2");
  assert.strictEqual(r.occupantsActifs, 2);
  assert.strictEqual(r.alerteAmbiguite, true);
});

test("aucune occupation active : personne à qui envoyer", () => {
  const r = decideEnvoi({ categorieService: "family", occupationsActives: [] });
  assert.strictEqual(r.envoyer, false);
  assert.strictEqual(r.raison, "aucun-occupant");
});

test("liste d'occupations absente : traitée comme vide", () => {
  const r = decideEnvoi({ categorieService: "family" });
  assert.strictEqual(r.envoyer, false);
  assert.strictEqual(r.raison, "aucun-occupant");
});

// ── Services link_access : comportement inchangé ─────────────────────────────
// Ils n'ont ni compte ni profil ; le rattachement ne peut jamais devenir
// certain. Exiger cette certitude bloquait leurs codes pour toujours.

test("link_access avec un seul client actif", () => {
  const r = decideEnvoi({ categorieService: "link_access", candidats: [{ id: "a" }] });
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.raison, "client-unique");
});

test("link_access avec plusieurs clients : aucun envoi, l'admin tranche", () => {
  const r = decideEnvoi({
    categorieService: "link_access",
    candidats: [{ id: "a" }, { id: "b" }, { id: "c" }],
  });
  assert.strictEqual(r.envoyer, false);
  assert.strictEqual(r.raison, "ambigu");
  assert.strictEqual(r.occupantsActifs, 3);
});

// ── Étape 2 : une demande ouverte lève l'ambiguïté ───────────────────────────
// C'est la raison d'être de cette étape : le mail n'indique pas qui a déclenché
// le code, mais le client, lui, vient de le dire.

test("demande ouverte : le code part au demandeur, meme avec plusieurs occupants", () => {
  const kofi = occupation("1", "Kofi");
  const ama = occupation("2", "Ama");
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [kofi, ama],
    demandeOuverte: { id: "d1", occupancy: ama },
  });
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.raison, "demande-ouverte");
  assert.strictEqual(r.occupation.id, "2");
  assert.strictEqual(r.demandeId, "d1");
});

test("demande ouverte alors qu'un seul occupant : la demande fait foi quand meme", () => {
  const kofi = occupation("1", "Kofi");
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [kofi],
    demandeOuverte: { id: "d2", occupancy: kofi },
  });
  assert.strictEqual(r.raison, "demande-ouverte");
  assert.strictEqual(r.demandeId, "d2");
});

test("sans demande, on retombe sur le dernier acheteur", () => {
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [
      occupation("1", "Kofi", "2026-01-10T00:00:00Z"),
      occupation("2", "Ama", "2026-03-02T00:00:00Z"),
    ],
    demandeOuverte: null,
  });
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.raison, "dernier-acheteur");
  assert.strictEqual(r.occupation.id, "2");
});

test("une demande ouverte ne change rien pour un service link_access", () => {
  const r = decideEnvoi({
    categorieService: "link_access",
    candidats: [{ id: "a" }, { id: "b" }],
    demandeOuverte: { id: "d3", occupancy: occupation("9", "X") },
  });
  assert.strictEqual(r.raison, "ambigu");
  assert.strictEqual(r.demandeId, undefined);
});

// ── L'occupation designee doit etre encore active ────────────────────────────
// Une fenetre dure 15 minutes. En 15 minutes, une place peut avoir ete
// liberee, deplacee ou avoir franchi son `endsAt` — et avoir ete revendue.

test("demande ouverte dont l'occupation n'est plus active : le chemin demande ne s'applique pas", () => {
  const ancienne = occupation("1", "Kofi"); // liberee entre-temps
  const nouvelle = occupation("2", "Ama"); // a repris la place
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [nouvelle],
    demandeOuverte: { id: "d1", canal: "whatsapp", occupancy: ancienne },
  });
  // On retombe sur le comportement ordinaire : ici un occupant unique. Le code
  // ne part surtout PAS a l'ex-occupant.
  assert.strictEqual(r.raison, "occupant-unique");
  assert.strictEqual(r.occupation.id, "2");
  assert.strictEqual(r.demandeId, undefined);
});

test("occupation disparue et compte partage : dernier acheteur, l'admin est alerte", () => {
  const partie = occupation("3", "Yao", "2026-05-01T00:00:00Z");
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [
      occupation("1", "Kofi", "2026-01-10T00:00:00Z"),
      occupation("2", "Ama", "2026-03-02T00:00:00Z"),
    ],
    demandeOuverte: { id: "d2", canal: "whatsapp", occupancy: partie },
  });
  // Surtout PAS Yao, dont l'occupation n'est plus active — meme s'il a achete
  // le plus recemment. On retombe sur le chemin ordinaire, borne aux occupants
  // encore presents sur ce compte.
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.raison, "dernier-acheteur");
  assert.strictEqual(r.occupation.id, "2");
  assert.strictEqual(r.alerteAmbiguite, true);
});

// ── Le canal de la demande retenue remonte avec la decision ──────────────────
// Le formulaire public n'etablit aucune identite : n'importe qui peut y poster
// le numero d'un client. Le code part quand meme (le client legitime ne doit
// pas etre puni), mais l'incident doit rester visible.

test("demande web sur un compte a plusieurs occupants : envoi ET alerte admin", () => {
  const kofi = occupation("1", "Kofi");
  const ama = occupation("2", "Ama");
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [kofi, ama],
    demandeOuverte: { id: "d3", canal: "web", occupancy: ama },
  });
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.occupation.id, "2");
  assert.strictEqual(r.canalDemande, "web");
  assert.strictEqual(r.alerteAmbiguite, true);
  assert.strictEqual(r.occupantsActifs, 2);
});

test("demande whatsapp sur un compte a plusieurs occupants : envoi, sans alerte", () => {
  const kofi = occupation("1", "Kofi");
  const ama = occupation("2", "Ama");
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [kofi, ama],
    demandeOuverte: { id: "d4", canal: "whatsapp", occupancy: ama },
  });
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.canalDemande, "whatsapp");
  assert.strictEqual(r.alerteAmbiguite, false);
});

// Un occupant seul n'a personne a qui voler un code : rien a signaler.
test("demande web sur un compte a un seul occupant : aucune alerte", () => {
  const kofi = occupation("1", "Kofi");
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [kofi],
    demandeOuverte: { id: "d5", canal: "web", occupancy: kofi },
  });
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.raison, "demande-ouverte");
  assert.strictEqual(r.alerteAmbiguite, false);
});

// ── Le dernier acheteur ─────────────────────────────────────────────────────

// Une demande ouverte reste PRIORITAIRE sur le dernier acheteur : quand le
// client dit lui-meme qu'il attend un code, on ne devine plus.
test("une demande ouverte prime sur le dernier acheteur", () => {
  const kofi = occupation("1", "Kofi", "2026-01-10T00:00:00Z");
  const ama = occupation("2", "Ama", "2026-03-02T00:00:00Z");
  const r = decideEnvoi({
    categorieService: "family",
    occupationsActives: [kofi, ama],
    demandeOuverte: { id: "d1", canal: "whatsapp", occupancy: kofi },
  });
  assert.strictEqual(r.raison, "demande-ouverte");
  assert.strictEqual(r.occupation.id, "1");
});

test("dernier acheteur : la date d'achat tranche, pas l'ordre de la liste", () => {
  const vieux = occupation("1", "Kofi", "2026-01-10T00:00:00Z");
  const recent = occupation("2", "Ama", "2026-03-02T00:00:00Z");
  assert.strictEqual(dernierAcheteur([vieux, recent]).id, "2");
  assert.strictEqual(dernierAcheteur([recent, vieux]).id, "2");
});

// La liste arrive deja triee du plus recent au plus ancien : sans date
// exploitable, son premier element est le meilleur pari. Surtout, la fonction
// ne doit jamais echouer — le bot n'enverrait plus rien du tout.
test("dernier acheteur : sans date exploitable, le premier de la liste", () => {
  const a = occupation("1", "Kofi");
  const b = occupation("2", "Ama");
  assert.strictEqual(dernierAcheteur([a, b]).id, "1");
  assert.strictEqual(dernierAcheteur([{ id: "x" }, { id: "y" }]).id, "x");
});

test("dernier acheteur : une date illisible ne fait pas gagner son occupation", () => {
  const illisible = occupation("1", "Kofi", "pas une date");
  const bon = occupation("2", "Ama", "2026-03-02T00:00:00Z");
  assert.strictEqual(dernierAcheteur([illisible, bon]).id, "2");
});

// A defaut de commande, la date de placement fait foi.
test("dernier acheteur : repli sur la date de placement", () => {
  const a = { id: "1", startedAt: "2026-01-01T00:00:00Z" };
  const b = { id: "2", startedAt: "2026-06-01T00:00:00Z" };
  assert.strictEqual(dernierAcheteur([a, b]).id, "2");
});

// ── A quel compte appartient ce code ? ──────────────────────────────────────
//
// Refonte du 13/10/2026. Un code appartient au compte dont le service a ECRIT
// l'adresse (To, Cc, X-Original-To). La boite connectee n'est qu'un transport :
// elle ne sert qu'en repli, quand aucune adresse ecrite ne correspond.
//
// L'ancienne regle faisait primer la boite connectee. Un mail ecrit au compte A
// mais lu dans la boite du compte B partait alors chez les clients de B — le
// code d'un foyer donne au client d'un autre, pour qui il ne marche pas.

const cpte = (email) => ({ id: email, email });

test("compte : l'adresse ecrite par le service prime sur la boite connectee", () => {
  const r = choisirCompteDestinataire([cpte("a@gmail.com"), cpte("b@gmail.com")], {
    ecrites: ["a@gmail.com"],
    transport: ["b@gmail.com"],
  });
  assert.strictEqual(r.compte.email, "a@gmail.com");
  assert.strictEqual(r.par, "adresse-ecrite");
});

test("compte : sans adresse ecrite reconnue, la boite connectee sert de repli", () => {
  const r = choisirCompteDestinataire([cpte("a@gmail.com")], {
    ecrites: ["inconnue@gmail.com"],
    transport: ["a@gmail.com"],
  });
  assert.strictEqual(r.compte.email, "a@gmail.com");
  assert.strictEqual(r.par, "boite");
});

test("compte : la casse, les espaces et les points gmail ne separent pas deux ecritures", () => {
  const r = choisirCompteDestinataire([cpte("Mon.Compte@Gmail.com ")], {
    ecrites: ["  moncompte@gmail.com"],
  });
  assert.strictEqual(r.compte.email, "Mon.Compte@Gmail.com ");
});

// Ecrit a deux comptes declares a la fois : on ne sait pas lequel a declenche
// le code. Plus de fusion : personne n'est designe, l'admin tranche.
test("compte : deux comptes ecrits a la fois -> personne, ambiguite signalee", () => {
  const r = choisirCompteDestinataire([cpte("a@gmail.com"), cpte("b@gmail.com")], {
    ecrites: ["a@gmail.com", "b@gmail.com"],
  });
  assert.strictEqual(r.compte, null);
  assert.strictEqual(r.ambigus.length, 2);
});

test("compte : aucune correspondance", () => {
  assert.deepStrictEqual(choisirCompteDestinataire([], { ecrites: ["a@gmail.com"] }), {
    compte: null,
    ambigus: [],
  });
  assert.deepStrictEqual(choisirCompteDestinataire(null, {}), { compte: null, ambigus: [] });
});

// ── Boite non declaree : le repli sur le dernier acheteur ───────────────────
//
// Quand aucun compte ne porte l adresse d ou vient le code, `resolveTargetOrder`
// passe par le rapprochement par SERVICE : elle rend un dernier acheteur mais
// AUCUNE occupation, puisqu il n y a pas de compte dont les lire. Sans le
// `scope`, la suite raisonnait sur les occupations et rendait « aucun-occupant »
// pour un service famille — le repli n avait aucune chance de s appliquer.

test("scope service avec plusieurs candidats : aucun envoi", () => {
  const r = decideEnvoi({
    categorieService: "family",
    scope: "service",
    occupationsActives: undefined,
    candidats: [{ id: "a" }, { id: "b" }],
  });
  assert.strictEqual(r.envoyer, false);
  assert.strictEqual(r.raison, "ambigu");
  assert.strictEqual(r.occupantsActifs, 2);
});

// Un seul client actif sur tout le service : il n'y a rien a deviner, le code
// ne peut etre que le sien. Refuser ici bloquerait un client legitime pour une
// ambiguite qui n'existe pas.
test("scope service avec un seul candidat : le code part", () => {
  const r = decideEnvoi({
    categorieService: "family",
    scope: "service",
    occupationsActives: undefined,
    candidats: [{ id: "a" }],
  });
  assert.strictEqual(r.envoyer, true);
  assert.strictEqual(r.raison, "client-unique-service");
  assert.strictEqual(r.occupantsActifs, 1);
});

test("scope service sans aucun candidat : rien a envoyer", () => {
  const r = decideEnvoi({ categorieService: "family", scope: "service", candidats: [] });
  assert.strictEqual(r.envoyer, false);
  assert.strictEqual(r.raison, "aucun-occupant");
});

// Le scope ne doit pas court-circuiter le chemin normal : un compte identifie
// decide toujours sur ses occupations.
test("scope account : le raisonnement sur les occupations est intact", () => {
  const r = decideEnvoi({
    categorieService: "family",
    scope: "account",
    occupationsActives: [occupation("1", "Kofi", "2026-01-10T00:00:00Z")],
  });
  assert.strictEqual(r.raison, "occupant-unique");
  assert.strictEqual(r.occupation.id, "1");
});

// ── Fraicheur des courriels ─────────────────────────────────────────────────
//
// Ces cas encadrent un incident reel : deux boites jamais surveillees ont ete
// ajoutees a IMAP_ACCOUNTS, et la recherche IMAP, non bornee dans le temps, a
// rejoue leur arriere non lu — cinq codes perimes expedies a deux clients.

const MAINTENANT = Date.parse("2026-08-31T12:00:00Z");
const UNE_HEURE = 60 * 60 * 1000;

test("un courriel recent est traite", () => {
  const il_y_a_5_min = new Date(MAINTENANT - 5 * 60 * 1000);
  assert.strictEqual(estCourrielRecent(il_y_a_5_min, MAINTENANT, UNE_HEURE), true);
});

test("un courriel plus vieux que la fenetre est ecarte", () => {
  const il_y_a_3_h = new Date(MAINTENANT - 3 * UNE_HEURE);
  assert.strictEqual(estCourrielRecent(il_y_a_3_h, MAINTENANT, UNE_HEURE), false);
});

test("l arriere d une boite jamais surveillee est ecarte en bloc", () => {
  const anciens = [30, 90, 365].map((j) => new Date(MAINTENANT - j * 24 * UNE_HEURE));
  for (const d of anciens) {
    assert.strictEqual(estCourrielRecent(d, MAINTENANT, UNE_HEURE), false);
  }
});

test("la borne est inclusive : pile a la limite, le courriel passe", () => {
  const pile = new Date(MAINTENANT - UNE_HEURE);
  assert.strictEqual(estCourrielRecent(pile, MAINTENANT, UNE_HEURE), true);
});

// Mieux vaut un envoi de trop qu un code legitime perdu parce qu un en-tete
// manquait ou etait illisible.
test("une date absente ou invalide ne fait pas ecarter le courriel", () => {
  assert.strictEqual(estCourrielRecent(undefined, MAINTENANT, UNE_HEURE), true);
  assert.strictEqual(estCourrielRecent(null, MAINTENANT, UNE_HEURE), true);
  assert.strictEqual(estCourrielRecent(new Date("pas une date"), MAINTENANT, UNE_HEURE), true);
  assert.strictEqual(estCourrielRecent("2026-08-31", MAINTENANT, UNE_HEURE), true);
});

// Une fenetre mal configuree ne doit pas rendre le bot muet.
test("une fenetre absurde desactive le filtre plutot que de tout bloquer", () => {
  const vieux = new Date(MAINTENANT - 10 * 24 * UNE_HEURE);
  assert.strictEqual(estCourrielRecent(vieux, MAINTENANT, 0), true);
  assert.strictEqual(estCourrielRecent(vieux, MAINTENANT, -1), true);
  assert.strictEqual(estCourrielRecent(vieux, MAINTENANT, NaN), true);
});

// ── Choix du destinataire ───────────────────────────────────────────────────
//
// Cas reel : apres une remise a zero de l inventaire, un code est arrive sur
// une boite dont plus aucun client n occupait de profil. Le code lisait
// `.clientWhatsapp` sur `null` et plantait AVANT le garde-fou qui savait
// pourtant traiter ce cas. Le mail etait deja marque \Seen : le code perdu.

const commande = {
  id: "cmd-1",
  clientName: "Kofi",
  clientWhatsapp: "22997000000",
};

test("sans occupation, le destinataire est l acheteur de la commande", () => {
  const r = choisirDestinataire({}, commande);
  assert.strictEqual(r.commandeCible.id, "cmd-1");
  assert.strictEqual(r.destinataire.whatsapp, "22997000000");
  assert.strictEqual(r.destinataire.nom, "Kofi");
});

test("avec occupation, l occupation fait foi sur le destinataire", () => {
  const occupation = {
    occupantWhatsapp: "22996000000",
    occupantName: "Ama",
    order: commande,
  };
  const r = choisirDestinataire({ occupation }, null);
  // La commande reste celle de l acheteur — verrou, journal et echeance s y
  // rattachent — mais le code part a l occupant.
  assert.strictEqual(r.commandeCible.id, "cmd-1");
  assert.strictEqual(r.destinataire.whatsapp, "22996000000");
  assert.strictEqual(r.destinataire.nom, "Ama");
});

test("ni occupation ni commande : rend null au lieu de planter", () => {
  assert.strictEqual(choisirDestinataire({}, null), null);
  assert.strictEqual(choisirDestinataire({ occupation: null }, null), null);
  assert.strictEqual(choisirDestinataire(null, null), null);
  assert.strictEqual(choisirDestinataire(undefined, undefined), null);
});

test("une occupation sans commande rattachee rend null", () => {
  const r = choisirDestinataire({ occupation: { occupantWhatsapp: "229", order: null } }, null);
  assert.strictEqual(r, null);
});

// ── Identification du service : l'expéditeur prime sur l'objet ───────────────
//
// Incident de production : un client ayant acheté Apple Music a reçu le code
// d'un AUTRE service. Cause : les alias sont des mots courants ("apple",
// "google", "amazon") cherchés dans « expéditeur + objet », et l'objet d'un
// mail de connexion nomme l'APPAREIL. « Nouvelle connexion depuis Apple TV »,
// envoyé par Netflix, identifiait donc Netflix ET Apple Music — puis
// `resolveTargetOrder` fusionnait les commandes des deux (`serviceId: { in }`)
// et retenait le dernier acheteur des deux services confondus.
const { servicesCorrespondants } = require("./otpRouting");

const CATALOGUE = [
  { id: "s-netflix", name: "Netflix", slug: "netflix", category: "family" },
  { id: "s-spotify", name: "Spotify", slug: "spotify", category: "family" },
  { id: "s-apple", name: "Apple Music", slug: "apple-music", category: "family" },
  { id: "s-yt", name: "YouTube Premium", slug: "youtube-premium", category: "family" },
];

const noms = (r) => r.map((s) => s.name);

test("identification : l'appareil cité dans l'objet ne désigne pas un service", () => {
  const r = servicesCorrespondants(
    CATALOGUE,
    "info@account.netflix.com",
    "Nouvelle connexion depuis Apple TV",
  );
  assert.deepStrictEqual(noms(r), ["Netflix"]);
});

test("identification : un appareil Apple sur un mail Spotify reste Spotify", () => {
  const r = servicesCorrespondants(
    CATALOGUE,
    "no-reply@spotify.com",
    "Nouvelle connexion sur votre appareil Apple",
  );
  assert.deepStrictEqual(noms(r), ["Spotify"]);
});

test("identification : un vrai mail Apple désigne bien Apple Music", () => {
  const r = servicesCorrespondants(
    CATALOGUE,
    "noreply@email.apple.com",
    "Votre code de vérification",
  );
  assert.deepStrictEqual(noms(r), ["Apple Music"]);
});

// L'objet reste utile quand l'expéditeur ne dit rien (renvoi, passerelle,
// adresse générique) : le supprimer ferait perdre des codes légitimes.
test("identification : l'objet sert de repli quand l'expéditeur ne dit rien", () => {
  const r = servicesCorrespondants(
    CATALOGUE,
    "no-reply@mail-relay.example.com",
    "Votre code Netflix",
  );
  assert.deepStrictEqual(noms(r), ["Netflix"]);
});

// ── Copie au destinataire d'un cadeau ───────────────────────────────────────
//
// Le code partait au numéro du cadeau sans jamais vérifier qu'il diffère de
// celui qui venait de le recevoir. Un acheteur qui commande « pour offrir » en
// laissant son propre numéro — ou en l'écrivant sous une autre forme, « 97 00
// 00 00 » contre « +229 97 00 00 00 » — recevait donc DEUX FOIS le même code,
// à deux secondes d'intervalle.
const { envoyerCopieCadeau } = require("./otpRouting");

test("cadeau : le destinataire distinct reçoit sa copie", () => {
  const r = envoyerCopieCadeau({
    isGift: true,
    giftWhatsapp: "+22997000001",
    destinataireWhatsapp: "+22997000002",
  });
  assert.strictEqual(r, true);
});

test("cadeau : un numéro identique ne déclenche pas de second envoi", () => {
  const r = envoyerCopieCadeau({
    isGift: true,
    giftWhatsapp: "+22997000001",
    destinataireWhatsapp: "+22997000001",
  });
  assert.strictEqual(r, false);
});

// Le cas qui se produit reellement : le client saisit sa forme locale dans un
// champ et sa forme internationale dans l'autre. Une comparaison stricte les
// croit distincts.
test("cadeau : deux écritures du même numéro ne comptent que pour un envoi", () => {
  const r = envoyerCopieCadeau({
    isGift: true,
    giftWhatsapp: "97000001",
    destinataireWhatsapp: "+229 97 00 00 01",
  });
  assert.strictEqual(r, false);
});

// Sur un compte partagé, l'occupant a déjà reçu le code : c'est lui le
// destinataire du cadeau le cas échéant, et un code de foyer est à usage
// unique. Comportement inchangé.
test("cadeau : une occupation existante interdit toute seconde copie", () => {
  const r = envoyerCopieCadeau({
    occupation: { id: "occ-1" },
    isGift: true,
    giftWhatsapp: "+22997000001",
    destinataireWhatsapp: "+22997000002",
  });
  assert.strictEqual(r, false);
});

test("cadeau : une commande ordinaire n'envoie jamais de copie", () => {
  assert.strictEqual(
    envoyerCopieCadeau({ isGift: false, giftWhatsapp: "+22997000001", destinataireWhatsapp: "+22997000002" }),
    false,
  );
  assert.strictEqual(
    envoyerCopieCadeau({ isGift: true, giftWhatsapp: null, destinataireWhatsapp: "+22997000002" }),
    false,
  );
});

// ── Le pivot de tout le routage : « sur cette boîte » ou « sur ce service » ──
//
// Ces deux cas ont la même forme — plusieurs clients actifs, aucune demande
// ouverte — et appellent des réponses OPPOSÉES. Les confondre est ce qui a
// produit l'incident : un client recevait les codes de tout le monde.
//
// Ce qui les sépare n'est pas le nombre de candidats mais leur LIEN AVEC LA
// BOÎTE d'où sort le code :
//   • occupations  → ces gens ont des identifiants portant l'adresse de cette
//     boîte. Le code est à l'un d'eux ; on parie sur le dernier acheteur.
//   • scope service → aucun compte ne porte cette adresse. Le « dernier
//     acheteur » y est celui de tout le service, sans le moindre rapport avec
//     la boîte : le code ne marcherait même pas chez lui.
test("pivot : même situation, réponse opposée selon le lien avec la boîte", () => {
  const clients = [
    occupation("1", "Kofi", "2026-01-10T00:00:00Z"),
    occupation("2", "Ama", "2026-03-02T00:00:00Z"),
  ];

  // Boîte déclarée : ces occupants ont les identifiants de CETTE adresse.
  const surLaBoite = decideEnvoi({
    categorieService: "family",
    occupationsActives: clients,
  });
  assert.strictEqual(surLaBoite.envoyer, true);
  assert.strictEqual(surLaBoite.occupation.id, "2");

  // Boîte non déclarée : les candidats ne sont rattachés à aucune adresse.
  const surLeService = decideEnvoi({
    categorieService: "family",
    scope: "service",
    occupationsActives: undefined,
    candidats: [{ id: "a" }, { id: "b" }],
  });
  assert.strictEqual(surLeService.envoyer, false);
  assert.strictEqual(surLeService.raison, "ambigu");
});
