// ─────────────────────────────────────────────────────────────────────────────
// Classement d'un mail recu par le bot OTP — fonctions pures, sans base.
//
// Repond, dans cet ordre, a trois questions : de QUI vient ce mail, de QUOI
// parle-t-il, et quel CODE porte-t-il. Le routage (a qui l'envoyer) vit dans
// ./otpRouting.js et ne commence qu'une fois ces trois reponses certaines.
//
// Refonte du 13/10/2026. Chaque regle ci-dessous ferme un incident observe en
// production, et chacune est testee sur les vrais mails Netflix de cette
// periode (voir __fixtures__/courriels-netflix.json) :
//
//   • Le service se lit dans le DOMAINE de l'expediteur, jamais dans l'objet
//     ni dans le nom affiche. L'objet avait ouvert une boucle : le bot relisait
//     ses propres alertes « 🔐 OTP reçu — Netflix : 1574 » et renvoyait le code
//     a un autre client (12/10). Il avait aussi melange deux services
//     (« connexion depuis Apple TV », envoye par Netflix, 05/09).
//
//   • Le code n'est jamais lu dans un lien. Un identifiant de lien
//     (`…password?g=4d0a1b62-dae2-4d3e-8471-…`) avait ete envoye comme code a
//     deux clients (08/10), et un lien d'approbation sans aucun code avait
//     produit un faux code (07/10).
//
//   • Un code de GESTION du compte (modification des informations, mot de
//     passe, e-mail) n'appartient qu'a l'administrateur. Il etait parti chez un
//     client (12/10).
// ─────────────────────────────────────────────────────────────────────────────

const { extractOTP, SERVICE_ALIASES, estCourrielInterne } = require("./otpRouting");

// ── L'expediteur ─────────────────────────────────────────────────────────────

// Domaine de l'adresse, en minuscules. L'adresse entre chevrons prime sur un
// nom affiche qui contiendrait lui-meme une adresse : `"info@netflix.com"
// <x@escroc.com>` vient d'escroc.com.
function domaineDe(expediteur) {
  const brut = String(expediteur || "");
  const m =
    brut.match(/<\s*[^<>\s@]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*>/) ||
    brut.match(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return m ? m[1].toLowerCase() : null;
}

// Les cles qui designent un service : son slug sans tirets, et ses alias d'un
// seul mot. Ne servent plus qu'a reconnaitre un service NOMME dans un texte.
function clesDuService(svc) {
  const slug = String(svc?.slug || "").toLowerCase();
  return [
    slug.replace(/-/g, ""),
    ...(SERVICE_ALIASES[slug] || []).filter((a) => !/\s/.test(a)),
  ].filter(Boolean);
}

// Domaines OFFICIELS d'expedition de chaque service. Un mail n'est attribue a
// un service que si son expediteur est l'un de ces domaines ou l'un de leurs
// sous-domaines (`account.netflix.com`).
//
// Une liste explicite, et non plus « la marque figure parmi les libelles du
// domaine » : avec cette regle, `netflix.escroc.com` — un sous-domaine qu'un
// tiers peut creer sur son propre domaine — etait pris pour Netflix, et ses
// « codes » ou ses liens d'approbation transmis aux clients ou a l'admin.
// Un service absent de la liste n'est reconnu que par `<slug>.com`.
const DOMAINES_OFFICIELS = {
  netflix: ["netflix.com"],
  spotify: ["spotify.com"],
  "apple-music": ["apple.com", "itunes.com", "icloud.com"],
  "disney-plus": ["disneyplus.com", "disney.com"],
  "youtube-premium": ["youtube.com", "google.com"],
  crunchyroll: ["crunchyroll.com"],
  canva: ["canva.com"],
  chatgpt: ["openai.com", "chatgpt.com"],
  "prime-video": ["primevideo.com", "amazon.com"],
  snapchat: ["snapchat.com"],
  "snapchat-plus": ["snapchat.com"],
};

function domainesOfficiels(svc) {
  const slug = String(svc?.slug || "").toLowerCase();
  return DOMAINES_OFFICIELS[slug] || (slug ? [`${slug.replace(/-/g, "")}.com`] : []);
}

// Domaine exact, ou sous-domaine ancre sur un point : `account.netflix.com`
// passe, `netflix.com.escroc.io` et `monnetflix.com` non.
function appartientA(domaine, base) {
  return domaine === base || domaine.endsWith(`.${base}`);
}

function servicesParExpediteur(services, expediteur) {
  const domaine = domaineDe(expediteur);
  if (!domaine) return [];
  return (services || []).filter((svc) =>
    domainesOfficiels(svc).some((base) => appartientA(domaine, base)),
  );
}

// Services NOMMES dans un texte (l'objet). Ne sert plus a identifier : seulement
// a reconnaitre un mail qui parle d'un service sans en venir — un renvoi
// manuel, typiquement — pour le signaler a l'administrateur.
function servicesNommes(services, texte) {
  const botte = String(texte || "").toLowerCase();
  return (services || []).filter((svc) => {
    const nom = String(svc?.name || "").trim().toLowerCase();
    if (nom && botte.includes(nom)) return true;
    return clesDuService(svc).some((cle) => cle.length >= 4 && botte.includes(cle));
  });
}

// ── Le code ──────────────────────────────────────────────────────────────────

// Retire ce qui ressemble a un code sans en etre un :
//   • les liens — entre crochets (parties texte des mails), entre chevrons, nus ;
//   • les IDENTIFIANTS hors liens : suites d'au moins trois groupes separes par
//     des tirets ou soulignes, melant lettres et chiffres (UUID, « SRC: » de
//     suivi en pied de mail).
// Le faux code 8471 du 08/10 etait dans les deux : le lien
// `…password?g=4d0a1b62-dae2-4d3e-8471-…` ET le pied
// `SRC: 5F639529_4d0a1b62-dae2-4d3e-8471-…_fr`. Retirer les seuls liens
// laissait le second. Une date (2026-10-12) n'a pas de lettre : elle reste,
// et l'extracteur ecarte deja les annees.
function sansLiens(texte) {
  return String(texte || "")
    .replace(/\[\s*(?:https?:\/\/|www\.)[^\]]*\]/gi, " ")
    .replace(/<\s*(?:https?:\/\/|www\.)[^>]*>/gi, " ")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\b[0-9A-Za-z]+(?:[-_][0-9A-Za-z]+){2,}\b/g, (jeton) =>
      /\d/.test(jeton) && /[A-Za-z]/.test(jeton) ? " " : jeton,
    );
}

function extraireCode({ sujet, texte } = {}) {
  return extractOTP(sansLiens(texte)) || extractOTP(sansLiens(sujet)) || null;
}

// ── Le type de mail ──────────────────────────────────────────────────────────
//
// Les motifs portent sur l'objet ET le corps (liens retires). L'ordre compte :
// la gestion passe en premier — un code qui modifie le compte ne doit jamais
// etre pris pour un code de connexion, quoi que dise le reste du mail.

const GESTION =
  /code de confirmation|confirm\w*\s+(?:la\s+|votre\s+)?modification|modification des informations|r[ée]initialis\w*[^.\n]{0,30}mot de passe|password reset|reset your password|confirm (?:your )?(?:e-?mail|email address|phone|change)|v[ée]rifi\w* (?:votre )?(?:adresse e-?mail|num[ée]ro de t[ée]l[ée]phone)|changement d'adresse e-?mail/i;

const LIEN =
  /demande d'identification|approuve\w*[^.\n]{0,25}identification|approve[^.\n]{0,25}sign[- ]?in|sign[- ]?in request/i;

const INFORMATION =
  /nouvel appareil|new device|s'est connect[ée]|signed in (?:to|on)|informations de paiement|mode de paiement mis|payment (?:method|information|details)(?: was| has been)? updated/i;

// Formules propres aux codes de foyer. Le mot « foyer » seul ne suffit pas :
// le vrai code d'identification dit « ne partagez ce code avec personne en
// dehors de votre foyer ».
const FOYER =
  /acc[eè]s temporaire|temporary access|(?:mettre|mise) [àa] jour (?:de |du |le |votre )*foyer|foyer netflix|netflix household|update (?:your )?household|household (?:update|verification)|vous [eê]tes en voyage|while (?:you'?re )?travel/i;

// Formules d'un code de CONNEXION. Elles doivent etre reconnues pour qu'un
// code parte chez un client : un code dont le type n'est pas reconnu va a
// l'administrateur (« inconnu »). L'inverse — tout code non classe traite
// comme connexion — remettait a un client n'importe quel mail de gestion
// formule autrement que prevu.
const CONNEXION =
  /code d'identification|code de connexion|vous identifier|identifiez-vous|sign[- ]?in code|code to sign in|log[- ]?in code|code de v[ée]rification|verification code|one[- ]time (?:code|password|passcode)|code (?:à|a) usage unique/i;

function typeCourriel({ sujet, texte, code } = {}) {
  const botte = `${sujet || ""}\n${sansLiens(texte)}`;
  if (GESTION.test(botte)) return "gestion";
  if (LIEN.test(botte)) return "lien";
  if (!code) return "information";
  if (INFORMATION.test(botte)) return "information";
  if (FOYER.test(botte)) return "foyer";
  if (CONNEXION.test(botte)) return "connexion";
  return "inconnu";
}

// ── La signature de l'expediteur ─────────────────────────────────────────────
//
// Le domaine de `From` se falsifie. Le serveur qui recoit le mail (Gmail pour
// toutes nos boites) inscrit en TETE le resultat de ses verifications :
// `Authentication-Results`. On ne lit que cet en-tete-la — l'appelant fournit
// le plus haut, celui du serveur de reception ; un faussaire ne peut glisser le
// sien que plus bas.
//
// On exige un DMARC ou un DKIM valide pour un domaine OFFICIEL du service. Une
// signature valide pour un autre domaine ne prouve rien : Netflix passe par
// amazonses.com, dont la signature est valide elle aussi, et un faussaire
// signe tres bien pour son propre domaine.
//
// Verifie sur les vrais mails des boites A et B le 13/10/2026 : tous portent
// `dmarc=pass header.from=netflix.com` et `dkim=pass` pour leur sous-domaine.
function signatureVerifiee(entete, domaines) {
  const texte = String(entete || "");
  const officiel = (domaine) =>
    (domaines || []).some((base) => appartientA(String(domaine).toLowerCase(), base));
  for (const m of texte.matchAll(/\bdmarc=pass\b[^;]*?\bheader\.from=([\w.-]+)/gi)) {
    if (officiel(m[1])) return true;
  }
  for (const m of texte.matchAll(/\bdkim=pass\b[^;]*?\bheader\.[id]=@?([\w.-]+)/gi)) {
    if (officiel(m[1])) return true;
  }
  return false;
}

// Le lien « Approuver l'identification » d'une demande par lien. Le premier
// lien qui suit le mot — l'en-tete « Approuvez la nouvelle demande », sans
// lien, est saute de lui-meme.
//
// `domaines` : quand il est fourni, le lien n'est retenu que si son hote est
// l'un de ces domaines officiels. Un lien d'approbation est transmis tel quel a
// l'administrateur, qui cliquera dessus : il ne doit jamais mener ailleurs.
function lienApprobation(texte, domaines) {
  const m = String(texte || "").match(
    /(?:approuv|approve)\w*[^\n[]*\s*\[?\s*(https:\/\/[^\s\]>]+)/i,
  );
  if (!m) return null;
  if (!domaines) return m[1];
  let hote;
  try {
    hote = new URL(m[1]).hostname.toLowerCase();
  } catch {
    return null;
  }
  return domaines.some((base) => appartientA(hote, base)) ? m[1] : null;
}

// ── Le verdict d'ensemble ────────────────────────────────────────────────────
//
//   interne      notre propre mail (alertes, confirmations) : ignore
//   hors-service aucun service reconnu : ignore
//   non-verifie  un code dont l'expediteur n'est pas prouve : objet qui nomme
//                un service sans en venir (renvoi manuel ?), ou expediteur a la
//                marque sans signature DKIM/DMARC valide (usurpation ?).
//                Signale a l'admin, jamais transmis a un client
//   information  un service, rien a transmettre (nouvel appareil, promotion…)
//   gestion      code de gestion du compte : a l'administrateur seul
//   inconnu      code d'un type non reconnu : a l'administrateur
//   lien         demande d'identification par lien : a l'administrateur
//   a-router     code de connexion ou de foyer : a transmettre au client
function classerCourriel({
  expediteur,
  sujet,
  texte,
  authentification,
  services,
  domainesInternes,
} = {}) {
  if (estCourrielInterne(expediteur, domainesInternes)) {
    return { verdict: "interne", services: [], type: null, code: null };
  }

  const parExpediteur = servicesParExpediteur(services, expediteur);
  const code = extraireCode({ sujet, texte });

  if (parExpediteur.length === 0) {
    const nommes = servicesNommes(services, sujet);
    if (nommes.length > 0 && code) {
      return { verdict: "non-verifie", services: [], servicesNommes: nommes, type: null, code };
    }
    return { verdict: "hors-service", services: [], type: null, code: null };
  }

  // L'expediteur dit etre ce service : encore faut-il qu'il le prouve. Sans
  // signature valide pour un domaine officiel, le mail est traite comme un
  // renvoi ou une usurpation — signale a l'administrateur s'il porte un code,
  // jamais transmis a un client.
  const domainesDuService = parExpediteur.flatMap(domainesOfficiels);
  if (!signatureVerifiee(authentification, domainesDuService)) {
    if (code) return { verdict: "non-verifie", services: [], servicesNommes: parExpediteur, type: null, code };
    return { verdict: "hors-service", services: [], type: null, code: null };
  }

  const type = typeCourriel({ sujet, texte, code });
  if (type === "gestion") return { verdict: "gestion", services: parExpediteur, type, code };
  if (type === "lien") {
    return {
      verdict: "lien",
      services: parExpediteur,
      type,
      code: null,
      lien: lienApprobation(texte, domainesDuService),
    };
  }
  if (type === "information") {
    return { verdict: "information", services: parExpediteur, type, code: null };
  }
  // Un code dont on ne reconnait pas la nature : a l'administrateur.
  if (type === "inconnu") return { verdict: "inconnu", services: parExpediteur, type, code };
  return { verdict: "a-router", services: parExpediteur, type, code };
}

module.exports = {
  domaineDe,
  servicesParExpediteur,
  servicesNommes,
  sansLiens,
  extraireCode,
  typeCourriel,
  lienApprobation,
  signatureVerifiee,
  classerCourriel,
};
