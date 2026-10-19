// Tests de `resolveTargetOrder`, la fonction qui choisit À QUI un code part.
//
// Fichier séparé de `otpRouting.test.js`, qui n'exerce que des fonctions pures.
// Celle-ci lit la base : on la teste avec un `prisma` bouchonné, injecté dans
// le cache de modules AVANT de charger le routage. Un vrai accès base rendrait
// ces tests inexécutables en intégration continue — or ce sont précisément
// ceux qui gardent la porte fermée sur un incident de fuite déjà survenu.
const test = require("node:test");
const assert = require("node:assert");

const prismaPath = require.resolve("../src/services/prisma");

// Ce que la base contiendra pour un test donné.
let BASE = { services: [], comptes: [], commandes: [] };

require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: {
    subscriptionService: { findMany: async () => BASE.services },
    streamingAccount: {
      findMany: async ({ where }) =>
        BASE.comptes.filter((c) => where.serviceId.in.includes(c.serviceId)),
    },
    subscriptionOrder: {
      findMany: async ({ where }) =>
        BASE.commandes.filter((o) => where.serviceId.in.includes(o.serviceId)),
    },
    // Filtre par compte : sans lui, le CHOIX du compte ne se verrait pas dans
    // les occupations rendues, et un test ne pourrait pas le contredire.
    profileOccupancy: {
      findMany: async ({ where } = {}) =>
        (BASE.occupations || []).filter(
          (o) =>
            !where?.profile?.accountId || !o.accountId || o.accountId === where.profile.accountId,
        ),
    },
  },
};

const { resolveTargetOrder } = require("./otpRouting");

const NETFLIX = {
  id: "s-netflix", name: "Netflix", slug: "netflix",
  category: "family", transfertOtp: true,
};
const APPLE = {
  id: "s-apple", name: "Apple Music", slug: "apple-music",
  category: "family", transfertOtp: true,
};

const commande = (id, serviceId, nom, jour) => ({
  id, serviceId, clientName: nom, status: "CONFIRMED",
  createdAt: new Date(jour), expiresAt: new Date("2030-01-01"),
  service: { name: nom, slug: serviceId, category: "family" },
  plan: { label: "Standard", duration: 1, price: 3500, aVie: false },
});

const BOITE = { mailboxEmail: "boutique@gmail.com", recipientEmails: ["boutique@gmail.com"] };

// ── Le verrou anti-fusion ───────────────────────────────────────────────────
//
// Incident du 05/09/2026 : un mail Netflix dont l'objet nommait « Apple TV »
// identifiait Netflix ET Apple Music. Les commandes des deux services étaient
// alors versées dans le même panier (`serviceId: { in: [...] }`) et le
// « dernier acheteur » était pris toutes commandes confondues — le client
// Apple Music, qui avait acheté le plus récemment, a reçu le code Netflix.
//
// `servicesCorrespondants` empêche désormais cette double identification en
// faisant primer l'expéditeur. Ce test garde le second verrou : même si deux
// services arrivent malgré tout jusqu'ici, aucun code ne part.
test("résolution : deux services identifiés, aucun destinataire n'est choisi", async () => {
  BASE = {
    services: [NETFLIX, APPLE],
    comptes: [],
    commandes: [
      commande("cmd-apple", "s-apple", "Client Apple Music", "2026-09-04"),
      commande("cmd-netflix", "s-netflix", "Client Netflix", "2026-09-01"),
    ],
  };

  const r = await resolveTargetOrder({ ...BOITE, services: [NETFLIX, APPLE] });

  assert.strictEqual(r.order, null, "aucun code ne doit partir sur une identification ambiguë");
  assert.match(r.reason, /2 services/);
});

// Le cas nominal doit continuer de fonctionner : un seul service identifié,
// aucun compte sur cette boîte, le dernier acheteur de CE service reçoit.
test("résolution : un seul service, le dernier acheteur de ce service reçoit", async () => {
  BASE = {
    services: [NETFLIX],
    comptes: [],
    commandes: [
      commande("cmd-n2", "s-netflix", "Netflix récent", "2026-09-03"),
      commande("cmd-n1", "s-netflix", "Netflix ancien", "2026-09-01"),
    ],
  };

  const r = await resolveTargetOrder({ ...BOITE, services: [NETFLIX] });

  assert.ok(r.order, "un service unique doit encore désigner un destinataire");
  assert.strictEqual(r.order.serviceId, "s-netflix");
});

// ── L'interrupteur de transfert ─────────────────────────────────────────────
//
// « Aucun abonné Apple Music ne reçoit de code » : les codes qui arrivent dans
// la boîte pour ce service appartiennent au commerçant, pas au client. Le
// drapeau est porté par le SERVICE et ne se déduit pas de sa catégorie — ce
// service est « family » comme Netflix, et pourtant il ne relaie rien.
test("résolution : un service dont le transfert est coupé ne livre aucun code", async () => {
  const appleCoupe = { ...APPLE, transfertOtp: false };
  BASE = {
    services: [appleCoupe],
    comptes: [],
    commandes: [commande("cmd-a", "s-apple", "Client Apple Music", "2026-09-04")],
  };

  const r = await resolveTargetOrder({ ...BOITE, services: [appleCoupe] });

  assert.strictEqual(r.order, null);
  assert.match(r.reason, /desactive/i);
});

// Un service chargé par un vieux cache, ou par un `select` qui aurait oublié
// le champ, doit garder le comportement d'avant plutôt que de se taire sans
// que personne ne s'en aperçoive.
test("résolution : un drapeau absent laisse le transfert actif", async () => {
  const sansDrapeau = { id: "s-netflix", name: "Netflix", slug: "netflix", category: "family" };
  BASE = {
    services: [sansDrapeau],
    comptes: [],
    commandes: [commande("cmd-n", "s-netflix", "Client Netflix", "2026-09-01")],
  };

  const r = await resolveTargetOrder({ ...BOITE, services: [sansDrapeau] });

  assert.ok(r.order, "un champ absent ne doit pas couper un service qui marchait");
});

// ── Le verrou anti-fusion, variante « par compte » ──────────────────────────
//
// Le commercant utilise souvent UNE seule boite Gmail pour plusieurs services.
// Quand deux services sont identifies, `comptesDuService` ramene alors le
// compte Netflix ET le compte Apple Music, tous deux a cette adresse.
// `choisirCompteProprietaire` retenait le PREMIER dont l'adresse correspond —
// c'est-a-dire au hasard — et les occupations de ce compte devenaient les
// destinataires. Le code de l'un partait chez les clients de l'autre : la meme
// fuite que celle du 05/09/2026, par l'autre chemin.
test("résolution : deux comptes de services différents sur la même boîte, rien ne part", async () => {
  BASE = {
    services: [NETFLIX, APPLE],
    comptes: [
      { id: "c-netflix", email: "boutique@gmail.com", serviceId: "s-netflix" },
      { id: "c-apple", email: "boutique@gmail.com", serviceId: "s-apple" },
    ],
    occupations: [],
    commandes: [],
  };

  const r = await resolveTargetOrder({ ...BOITE, services: [NETFLIX, APPLE] });

  assert.strictEqual(r.order, null, "on ne choisit pas un service au hasard");
  assert.ok(r.reason, "le refus doit être motivé pour que l'admin transmette lui-même");
});

// Refonte du 13/10/2026 : deux comptes du MEME service rapproches a la fois ne
// sont plus fusionnes. Fusionner, c'etait envoyer le code d'un foyer au client
// d'un autre ; la regle posee par le proprietaire est que le destinataire
// detienne les identifiants de l'adresse a laquelle le service a ecrit. On ne
// sait pas laquelle : personne n'est designe, l'admin tranche.
test("résolution : deux comptes du même service rapprochés à la fois, rien ne part", async () => {
  BASE = {
    services: [NETFLIX],
    comptes: [
      { id: "c-n1", email: "boutique@gmail.com", serviceId: "s-netflix" },
      { id: "c-n2", email: "boutique@gmail.com", serviceId: "s-netflix" },
    ],
    occupations: [],
    commandes: [],
  };

  const r = await resolveTargetOrder({ ...BOITE, services: [NETFLIX] });

  assert.strictEqual(r.order, null);
  assert.ok(r.reason, "le refus doit etre motive pour que l'admin transmette lui-meme");
});

// ── Le compte est celui a qui le service a ECRIT ────────────────────────────
//
// Le cas qui a fait reecrire cette partie. Un mail ecrit au compte A arrive
// dans la boite du compte B (renvoi, alias). L'ancienne regle faisait primer la
// boite connectee : le code partait chez le client de B, pour qui il ne marche
// pas — et le client de A, qui l'attendait, ne recevait rien.
const occ = (id, accountId, nom, debut) => ({
  id, accountId,
  occupantName: nom, occupantWhatsapp: "+22900000000",
  startedAt: new Date(debut), endsAt: null, releasedAt: null,
  profile: { id: `p-${id}`, profile: nom.toUpperCase(), capacite: 1, email: "" },
  order: { id: `cmd-${id}`, clientName: nom, clientWhatsapp: "+22900000000", createdAt: new Date(debut) },
});

test("résolution : un mail écrit au compte A mais lu dans la boîte B va aux clients de A", async () => {
  BASE = {
    services: [NETFLIX],
    comptes: [
      { id: "c-a", email: "compte-a@gmail.com", serviceId: "s-netflix" },
      { id: "c-b", email: "compte-b@gmail.com", serviceId: "s-netflix" },
    ],
    occupations: [occ("o-aubina", "c-a", "Aubina", "2026-10-07"), occ("o-tounde", "c-b", "Tounde", "2026-09-16")],
    commandes: [],
  };

  const r = await resolveTargetOrder({
    mailboxEmail: "compte-b@gmail.com",
    recipientEmails: ["compte-b@gmail.com"],
    adressesEcrites: ["compte-a@gmail.com"],
    services: [NETFLIX],
  });

  assert.strictEqual(r.compte?.id, "c-a", "le compte est celui a qui Netflix a ecrit");
  assert.deepStrictEqual(r.occupationsActives.map((o) => o.occupantName), ["Aubina"]);
});

test("résolution : sans adresse écrite reconnue, la boîte connectée désigne le compte", async () => {
  BASE = {
    services: [NETFLIX],
    comptes: [{ id: "c-b", email: "compte-b@gmail.com", serviceId: "s-netflix" }],
    occupations: [occ("o-tounde", "c-b", "Tounde", "2026-09-16")],
    commandes: [],
  };

  const r = await resolveTargetOrder({
    mailboxEmail: "compte-b@gmail.com",
    recipientEmails: ["compte-b@gmail.com"],
    adressesEcrites: ["liste-de-diffusion@netflix.com"],
    services: [NETFLIX],
  });

  assert.strictEqual(r.compte?.id, "c-b");
  assert.deepStrictEqual(r.occupationsActives.map((o) => o.occupantName), ["Tounde"]);
});

// ── Un refus délibéré n'est pas un incident ─────────────────────────────────
//
// Couper le transfert d'un service, c'est dire « ces codes sont les miens ».
// Chaque code reçu ensuite remontait pourtant comme « OTP orphelin », avec
// une alerte WhatsApp — l'administrateur se noyait sous des notifications
// qu'il avait lui-même provoquées, et apprenait à ignorer une alerte qui est
// le filet des VRAIS échecs de routage.
test("résolution : un transfert coupé est un refus ATTENDU, pas une alerte", async () => {
  const coupe = { ...APPLE, transfertOtp: false };
  BASE = { services: [coupe], comptes: [], occupations: [], commandes: [] };

  const r = await resolveTargetOrder({ ...BOITE, services: [coupe] });

  assert.strictEqual(r.order, null);
  assert.strictEqual(r.attendu, true, "l'appelant doit pouvoir se taire sur ce refus");
});

// Les autres refus restent des incidents : ils signalent une configuration à
// corriger ou une ambiguïté à trancher, et doivent continuer d'alerter.
test("résolution : une ambiguïté reste un incident à signaler", async () => {
  BASE = { services: [NETFLIX, APPLE], comptes: [], occupations: [], commandes: [] };

  const r = await resolveTargetOrder({ ...BOITE, services: [NETFLIX, APPLE] });

  assert.strictEqual(r.order, null);
  assert.ok(!r.attendu, "une ambiguïté doit rester bruyante");
});

// ── L'invariant : le destinataire détient les identifiants de CETTE boîte ────
//
// Règle posée par le propriétaire : qui reçoit le code venu d'une adresse doit
// avoir reçu des identifiants portant cette même adresse. Sans quoi le code ne
// peut pas marcher chez lui — il ouvre le foyer de quelqu'un d'autre.
//
// Le service déclare un compte, mais pas celui d'où sort ce code : l'adresse
// surveillée est absente de l'administration, ou mal saisie. Le repli
// « dernier acheteur actif du service » désignait alors un client dont les
// identifiants portent une AUTRE adresse. Un seul client actif suffisait à le
// déclencher, `decideEnvoi` ne refusant que sur pluralité.
//
// C'était le cas de Netflix à trois clients actifs : protégé par l'ambiguïté
// seule. Dès qu'il n'en reste qu'un, le repli redevenait passant.
test("résolution : une boîte non déclarée ne fait pas deviner un destinataire", async () => {
  BASE = {
    services: [NETFLIX],
    comptes: [{ id: "cpt-1", serviceId: "s-netflix", email: "compte-netflix@gmail.com" }],
    occupations: [],
    commandes: [commande("cmd-seul", "s-netflix", "Client unique", "2026-09-01")],
  };

  const r = await resolveTargetOrder({
    mailboxEmail: "boite-inconnue@gmail.com",
    recipientEmails: ["boite-inconnue@gmail.com"],
    services: [NETFLIX],
  });

  assert.strictEqual(
    r.order,
    null,
    "le service déclare des comptes et aucun ne porte cette adresse : rien ne doit partir",
  );
  assert.ok(!r.attendu, "une adresse non déclarée est une configuration à corriger");
});

// Le pendant du test précédent : sans AUCUN compte déclaré, il n'y a pas
// d'adresse à faire correspondre. C'est le cas `link_access` (Spotify, Canva),
// où le rattachement est structurellement impossible et non pas manquant. Le
// repli par service y reste légitime — le verrou ne doit pas l'emporter avec.
test("résolution : sans compte déclaré, le repli par service reste permis", async () => {
  BASE = {
    services: [NETFLIX],
    comptes: [],
    occupations: [],
    commandes: [commande("cmd-seul", "s-netflix", "Client unique", "2026-09-01")],
  };

  const r = await resolveTargetOrder({
    mailboxEmail: "boite-inconnue@gmail.com",
    recipientEmails: ["boite-inconnue@gmail.com"],
    services: [NETFLIX],
  });

  assert.ok(r.order, "aucun compte déclaré : le repli par service doit encore désigner");
});
