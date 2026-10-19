// Tests du classement des mails recus par le bot OTP.
//
// Les textes viennent de VRAIS mails Netflix (boites des comptes A et B, du 07
// au 12/10/2026), anonymises sans en changer la forme — voir
// __fixtures__/courriels-netflix.json. C'est cette forme exacte qui piegeait
// l'ancien extracteur : un test ecrit sur un texte invente n'aurait pas echoue.
const test = require("node:test");
const assert = require("node:assert");
const {
  domaineDe,
  servicesParExpediteur,
  extraireCode,
  typeCourriel,
  lienApprobation,
  signatureVerifiee,
  classerCourriel,
} = require("./otpClassement");
const { extractOTP } = require("./otpRouting");
const COURRIELS = require("./__fixtures__/courriels-netflix.json");

const NETFLIX = { id: "s-netflix", name: "Netflix", slug: "netflix" };
const APPLE = { id: "s-apple", name: "Apple Music", slug: "apple-music" };
const DISNEY = { id: "s-disney", name: "Disney+", slug: "disney-plus" };
const SERVICES = [NETFLIX, APPLE, DISNEY];
const INTERNES = ["mtechbenin.com"];

// En-tete releve sur les vrais mails Netflix des boites A et B (13/10/2026).
const SIGNE_NETFLIX =
  "mx.google.com; dkim=pass header.i=@account.netflix.com header.s=x; dkim=pass header.i=@amazonses.com; " +
  "spf=pass smtp.mailfrom=bounces.netflix.com; dmarc=pass (p=REJECT) header.from=netflix.com";

const classer = (nom, authentification = SIGNE_NETFLIX) => {
  const c = COURRIELS[nom];
  return classerCourriel({
    expediteur: c.expediteur,
    sujet: c.sujet,
    texte: c.texte,
    authentification,
    services: SERVICES,
    domainesInternes: INTERNES,
  });
};

// ── Le domaine de l'expediteur ──────────────────────────────────────────────

test("domaine : extrait d'une adresse nue ou d'un nom affiche", () => {
  assert.strictEqual(domaineDe("info@account.netflix.com"), "account.netflix.com");
  assert.strictEqual(domaineDe('"Netflix" <info@Account.Netflix.com>'), "account.netflix.com");
  assert.strictEqual(domaineDe(""), null);
  assert.strictEqual(domaineDe(null), null);
});

// ── Le service, par le SEUL domaine de l'expediteur ─────────────────────────
//
// L'objet et le nom affiche ne comptent plus. C'est l'objet qui ouvrait la
// boucle du 12/10 (« 🔐 OTP reçu — Netflix : 1574 », envoye par nous) et le
// melange de services du 05/09 (« Nouvelle connexion depuis Apple TV », envoye
// par Netflix).

test("service : reconnu par un libelle du domaine", () => {
  assert.deepStrictEqual(
    servicesParExpediteur(SERVICES, "info@account.netflix.com").map((s) => s.slug),
    ["netflix"],
  );
  assert.deepStrictEqual(
    servicesParExpediteur(SERVICES, "no-reply@disneyplus.com").map((s) => s.slug),
    ["disney-plus"],
  );
});

test("service : le nom affiche ne fait pas l'expediteur", () => {
  assert.deepStrictEqual(servicesParExpediteur(SERVICES, '"Netflix" <alerte@escroc.com>'), []);
});

// Un domaine tiers peut se donner un sous-domaine a la marque :
// netflix.escroc.com appartient a escroc.com. Seul le domaine officiel, ou un
// de ses sous-domaines, fait foi.
test("service : un sous-domaine a la marque d'un domaine tiers ne passe pas", () => {
  assert.deepStrictEqual(servicesParExpediteur(SERVICES, "x@netflix.escroc.com"), []);
  assert.deepStrictEqual(servicesParExpediteur(SERVICES, "x@account.netflix.com.escroc.io"), []);
});

test("lien : un lien hors du domaine officiel n'est pas retenu", () => {
  const texte = "Approuver l'identification\n[https://netflix.escroc.com/approuver]\n";
  assert.strictEqual(lienApprobation(texte, ["netflix.com"]), null);
  assert.strictEqual(
    lienApprobation("Approuver l'identification\n[https://www.netflix.com/ok?x=1]\n", ["netflix.com"]),
    "https://www.netflix.com/ok?x=1",
  );
});

test("service : un domaine qui contient la marque sans l'etre ne passe pas", () => {
  assert.deepStrictEqual(servicesParExpediteur(SERVICES, "x@netflix-codes.com"), []);
  assert.deepStrictEqual(servicesParExpediteur(SERVICES, "x@monnetflix.com"), []);
});

// ── L'extraction du code ignore les liens ───────────────────────────────────

test("code : l'ancien extracteur se faisait pieger par les liens (preuve)", () => {
  // Si ces deux assertions cessent d'etre vraies, les echantillons ne
  // reproduisent plus le defaut et les tests ci-dessous ne prouvent plus rien.
  assert.ok(extractOTP(COURRIELS["information-nouvel-appareil"].texte));
  assert.ok(extractOTP(COURRIELS["connexion-compte-a"].texte));
});

test("code : aucun code n'est lu dans un lien", () => {
  assert.strictEqual(extraireCode(COURRIELS["information-nouvel-appareil"]), null);
  assert.strictEqual(extraireCode(COURRIELS["connexion-compte-a"]), null);
});

test("code : le vrai code d'identification est trouve", () => {
  assert.strictEqual(extraireCode(COURRIELS["connexion-compte-b"]), "4821");
});

test("code : le vrai code de confirmation est trouve", () => {
  assert.strictEqual(extraireCode(COURRIELS["gestion-confirmation"]), "582913");
});

// ── Le type de mail ─────────────────────────────────────────────────────────

test("type : code d'identification -> connexion", () => {
  const c = COURRIELS["connexion-compte-b"];
  assert.strictEqual(typeCourriel({ ...c, code: "4821" }), "connexion");
});

test("type : modification des informations du compte -> gestion", () => {
  const c = COURRIELS["gestion-confirmation"];
  assert.strictEqual(typeCourriel({ ...c, code: "582913" }), "gestion");
});

test("type : demande d'identification par lien -> lien", () => {
  assert.strictEqual(typeCourriel({ ...COURRIELS["connexion-compte-a"], code: null }), "lien");
});

// Le mail « nouvel appareil » est une information, meme si un nombre y
// trainait : c'est de lui qu'etait sorti le faux code 8471 du 08/10.
test("type : nouvel appareil -> information, quoi qu'il contienne", () => {
  assert.strictEqual(
    typeCourriel({ ...COURRIELS["information-nouvel-appareil"], code: "6523" }),
    "information",
  );
});

test("type : paiement mis a jour et promotion -> information", () => {
  assert.strictEqual(typeCourriel({ ...COURRIELS["information-paiement"], code: null }), "information");
  assert.strictEqual(typeCourriel({ ...COURRIELS.promotion, code: null }), "information");
});

test("type : code de foyer / acces temporaire -> foyer", () => {
  assert.strictEqual(
    typeCourriel({ sujet: "Votre code d'accès temporaire", texte: "Saisissez ce code : 4821", code: "4821" }),
    "foyer",
  );
  assert.strictEqual(
    typeCourriel({ sujet: "Your temporary access code", texte: "Enter this code: 4821", code: "4821" }),
    "foyer",
  );
});

test("type : un code de connexion en anglais est reconnu", () => {
  assert.strictEqual(
    typeCourriel({ sujet: "Your sign-in code", texte: "Enter this code to sign in 4821", code: "4821" }),
    "connexion",
  );
});

// Refonte du 13/10/2026 : un code dont le type n'est PAS reconnu ne part plus
// chez un client par defaut. Un mail de gestion formule autrement que prevu
// serait sinon remis a un client. Inconnu -> administrateur.
test("type : un code d'un type non reconnu -> inconnu, jamais connexion", () => {
  assert.strictEqual(
    typeCourriel({ sujet: "Information importante", texte: "Votre code : 4821", code: "4821" }),
    "inconnu",
  );
});

// ── Le lien d'approbation ───────────────────────────────────────────────────

test("lien : le lien « Approuver » est retrouve", () => {
  const l = lienApprobation(COURRIELS["connexion-compte-a"].texte);
  assert.ok(l && /^https:\/\/www\.netflix\.com\//.test(l), `lien inattendu : ${l}`);
});

test("lien : rien a approuver dans un mail de code", () => {
  assert.strictEqual(lienApprobation(COURRIELS["connexion-compte-b"].texte), null);
});

// ── Le verdict d'ensemble, sur chaque mail reel ─────────────────────────────

test("verdict : notre propre alerte est interne", () => {
  assert.strictEqual(classer("interne-alerte").verdict, "interne");
});

test("verdict : code d'identification -> a router, code 4821", () => {
  const v = classer("connexion-compte-b");
  assert.strictEqual(v.verdict, "a-router");
  assert.strictEqual(v.type, "connexion");
  assert.strictEqual(v.code, "4821");
  assert.deepStrictEqual(v.services.map((s) => s.slug), ["netflix"]);
});

test("verdict : code de confirmation -> gestion, jamais a router", () => {
  const v = classer("gestion-confirmation");
  assert.strictEqual(v.verdict, "gestion");
  assert.strictEqual(v.code, "582913");
});

test("verdict : demande d'identification -> lien, sans code", () => {
  const v = classer("connexion-compte-a");
  assert.strictEqual(v.verdict, "lien");
  assert.strictEqual(v.code, null);
  assert.ok(v.lien);
});

test("verdict : nouvel appareil, paiement, promotion -> information", () => {
  for (const nom of ["information-nouvel-appareil", "information-paiement", "promotion"]) {
    assert.strictEqual(classer(nom).verdict, "information", nom);
  }
});

test("verdict : expediteur sans marque mais objet qui en nomme une, avec code -> non verifie", () => {
  const v = classerCourriel({
    expediteur: "quelquun@gmail.com",
    sujet: "Fwd: Netflix : Votre code d'identification",
    texte: "Saisissez ce code pour vous identifier\n4821\n",
    services: SERVICES,
    domainesInternes: INTERNES,
  });
  assert.strictEqual(v.verdict, "non-verifie");
  assert.deepStrictEqual(v.services, []);
});

test("verdict : mail sans rapport -> hors service", () => {
  const v = classerCourriel({
    expediteur: "news@journal.bj",
    sujet: "Les nouvelles du jour",
    texte: "Rien a voir.",
    services: SERVICES,
    domainesInternes: INTERNES,
  });
  assert.strictEqual(v.verdict, "hors-service");
});

// ── Signature de l'expediteur (DKIM / DMARC) ────────────────────────────────
//
// Le domaine de `From` se falsifie. Gmail inscrit en tete du mail le resultat
// de ses verifications (`Authentication-Results`) : on exige une signature
// valide pour un domaine OFFICIEL du service. Une signature valide pour un
// autre domaine (amazonses.com, qui relaie Netflix, ou le domaine du faussaire)
// ne prouve rien.

test("signature : DMARC valide pour netflix.com -> verifie", () => {
  assert.strictEqual(signatureVerifiee(SIGNE_NETFLIX, ["netflix.com"]), true);
});

test("signature : DKIM valide pour un sous-domaine officiel suffit", () => {
  assert.strictEqual(signatureVerifiee("mx.google.com; dkim=pass header.i=@account.netflix.com", ["netflix.com"]), true);
});

test("signature : une signature valide pour un AUTRE domaine ne prouve rien", () => {
  assert.strictEqual(
    signatureVerifiee("mx.google.com; dkim=pass header.i=@amazonses.com; dmarc=fail header.from=netflix.com", ["netflix.com"]),
    false,
  );
  assert.strictEqual(signatureVerifiee("mx.google.com; dkim=pass header.d=escroc.com", ["netflix.com"]), false);
});

test("signature : absente ou en echec -> non verifie", () => {
  assert.strictEqual(signatureVerifiee("", ["netflix.com"]), false);
  assert.strictEqual(signatureVerifiee(undefined, ["netflix.com"]), false);
  assert.strictEqual(signatureVerifiee("mx.google.com; dmarc=fail header.from=netflix.com", ["netflix.com"]), false);
});

test("verdict : un vrai code Netflix, sans signature valide -> non verifie, jamais a router", () => {
  const v = classer("connexion-compte-b", "mx.google.com; dmarc=fail header.from=netflix.com");
  assert.strictEqual(v.verdict, "non-verifie");
});

test("verdict : un code d'un type non reconnu -> inconnu (administrateur)", () => {
  const v = classerCourriel({
    expediteur: "info@account.netflix.com",
    sujet: "Information importante",
    texte: "Votre code : 4821",
    authentification: SIGNE_NETFLIX,
    services: SERVICES,
    domainesInternes: INTERNES,
  });
  assert.strictEqual(v.verdict, "inconnu");
  assert.strictEqual(v.code, "4821");
});
