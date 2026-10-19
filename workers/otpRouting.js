// ─────────────────────────────────────────────────────────────────────────────
// Routage des OTP — décide À QUI envoyer un code reçu par email.
//
// Le problème : une même boîte mail (ex. mtechbenin7@gmail.com) porte plusieurs
// profils d'un même compte streaming, vendus à des clients différents. L'email
// d'OTP n'indique jamais quel profil l'a demandé. On ne peut donc pas déduire le
// destinataire de l'email seul — il faut le retrouver côté commandes payées.
//
// Règles retenues (validées avec le métier) :
//   1. On ne cible QUE des commandes réellement payées (CONFIRMED) et encore
//      dans leur période de validité.
//   2. Parmi elles, on retient le dernier acheteur actif du compte concerné.
//   3. Une commande reçoit autant de codes que nécessaire tant qu'elle est
//      valide : Netflix envoie un code de foyer à CHAQUE nouvelle connexion, et
//      un abonné en a légitimement besoin plusieurs fois pendant sa formule.
//      Seul le renvoi d'un code identique déjà traité est ignoré (idempotence).
// ─────────────────────────────────────────────────────────────────────────────

const prisma = require("../src/services/prisma");
const logger = require("../src/utils/logger");
const { estAVie } = require("../src/modules/subscriptions/duree");
const { occupationsActivesDuCompte } = require("../src/modules/subscriptions/occupancy");
const { memeNumero } = require("../src/modules/subscriptions/demandeCode");

// ── Normalisation des adresses ───────────────────────────────────────────────
// Gmail ignore les points et les suffixes +tag : mtech.benin+netflix@gmail.com
// et mtechbenin@gmail.com sont la même boîte. Sans ça, un compte saisi avec une
// variante en admin ne serait jamais rapproché de la boîte surveillée.
function normalizeEmail(raw) {
  if (!raw) return null;
  const email = String(raw).trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at === -1) return email;

  let local = email.slice(0, at);
  const domain = email.slice(at + 1);

  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);

  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}

// ── Extraction du code OTP ───────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Séquences à ne jamais confondre avec un OTP (années, montants, dates…)
function isPlausibleOtp(code) {
  if (!code) return false;
  if (/^(\d)\1+$/.test(code)) return false; // 000000, 111111…
  if (code.length === 4) {
    const n = Number(code);
    if (n >= 1900 && n <= 2100) return false; // une année
  }
  return true;
}

// Le mail parle-t-il bien d'un code de connexion ? Sans ce garde-fou, un simple
// nombre isolé ("Facture de 1500 FCFA") serait pris pour un OTP et envoyé au
// client — on n'accepte les motifs non ancrés que si le contexte le confirme.
const OTP_CONTEXT_RE =
  /\b(code|otp|pin|token|v[ée]rif\w*|verification|verify|confirm\w*|one[- ]?time|usage unique|connexion|sign[- ]?in|log[- ]?in|authenti\w*|s[ée]curit[ée]|security|acc[èe]s|household|foyer|temporary)\b/i;

function extractOTP(text) {
  if (!text) return null;

  // ── Motifs ancrés : le code est explicitement présenté comme tel ──────────
  const anchored = [
    // "483920 is your verification code" (Apple, Spotify)
    /\b(\d{4,8})\b[\s\S]{0,25}?\bis\b[\s\S]{0,25}?\b(?:your\s+)?(?:verification\s+|security\s+|login\s+|one[- ]time\s+)?(?:code|pin|otp|password)\b/i,
    // "votre code de vérification est 483920" / "code: 483920"
    /\b(?:code|otp|pin|token|v[ée]rification|verification|confirm\w*|one[- ]time|usage unique)\b[\s\S]{0,25}?[\s:«"'\-–_]{0,10}(\d{4,8})\b/i,
    // code à 6 chiffres seul sur sa ligne (format le plus courant : code centré)
    /(?:^|\n)\s*(\d{6})\s*(?:\n|$)/m,
  ];

  for (const re of anchored) {
    const m = text.match(re);
    if (m && isPlausibleOtp(m[1])) return m[1];
  }

  // ── Motifs larges : uniquement si le mail parle bien d'un code ────────────
  if (!OTP_CONTEXT_RE.test(text)) return null;

  const loose = [
    /(?:^|\n)\s*(\d{4,8})\s*(?:\n|$)/m, // code seul sur sa ligne, longueur libre
    /\b(\d{6})\b/,
    /\b(\d{8})\b/,
    /\b(\d{4})\b/,
  ];

  for (const re of loose) {
    const m = text.match(re);
    if (m && isPlausibleOtp(m[1])) return m[1];
  }
  return null;
}

// ── Identification du service ────────────────────────────────────────────────
// Alias statiques (expéditeurs/marques) — complétés dynamiquement par les
// services réellement présents en base, pour qu'un nouveau service ajouté en
// admin soit reconnu sans toucher au code.
const SERVICE_ALIASES = {
  netflix: ["netflix"],
  spotify: ["spotify"],
  "apple-music": ["apple", "itunes", "icloud"],
  "disney-plus": ["disney", "disneyplus"],
  "youtube-premium": ["youtube", "google"],
  crunchyroll: ["crunchyroll"],
  canva: ["canva"],
  chatgpt: ["openai", "chatgpt"],
  "prime-video": ["primevideo", "prime video", "amazon"],
  snapchat: ["snapchat"],
  "snapchat-plus": ["snapchat"],
};

let _serviceCache = { at: 0, services: [] };

// Oublie les services memorises.
//
// Le cache dure cinq minutes. C'est sans consequence pour un nom ou un slug,
// mais `transfertOtp` est un interrupteur de SECURITE : l'administrateur le
// coupe parce que des codes partent chez les mauvaises personnes, et attendre
// cinq minutes de plus, c'est cinq minutes de fuite qu'il croit avoir arretee.
// `updateService` appelle donc cette fonction apres chaque enregistrement.
function viderCacheServices() {
  _serviceCache = { at: 0, services: [] };
}

async function loadServices() {
  // Cache 5 min : évite une requête DB à chaque email traité.
  if (Date.now() - _serviceCache.at < 5 * 60 * 1000 && _serviceCache.services.length) {
    return _serviceCache.services;
  }
  const services = await prisma.subscriptionService.findMany({
    select: {
      id: true, name: true, slug: true, category: true,
      // Sans ce champ, le filtre de `resolveTargetOrder` lirait `undefined`
      // sur chaque service et n'ecarterait jamais rien.
      transfertOtp: true,
    },
  });
  _serviceCache = { at: Date.now(), services };
  return services;
}

// Ce service est-il nommé dans ce texte ?
function correspond(svc, botte) {
  const slug = (svc.slug || "").toLowerCase();
  const name = (svc.name || "").trim().toLowerCase();

  // Correspondance directe sur le slug/nom du service en base
  if (slug && botte.includes(slug.replace(/-/g, ""))) return true;
  if (slug && botte.includes(slug)) return true;
  if (name && botte.includes(name)) return true;

  // Correspondance via les alias connus
  const aliases = SERVICE_ALIASES[slug] || [];
  return aliases.some((a) => botte.includes(a));
}

// Quels services ce message désigne-t-il ?
//
// L'EXPÉDITEUR prime, et l'objet ne sert qu'en repli. Ce n'est pas un
// raffinement : la règle précédente cherchait les alias dans « expéditeur +
// objet » d'un seul tenant, et les alias sont des mots courants — « apple »,
// « google », « amazon ». Or l'objet d'un mail de connexion nomme l'APPAREIL.
// « Nouvelle connexion depuis Apple TV », envoyé par Netflix, désignait donc
// Netflix ET Apple Music ; `resolveTargetOrder` fusionnait ensuite les
// commandes des deux services et retenait le dernier acheteur des deux
// confondus. Un client Apple Music a ainsi reçu un code Netflix.
//
// L'expéditeur, lui, ne se trompe pas : c'est l'entreprise qui a émis le code.
// Tous les expéditeurs réels portent leur marque (account.netflix.com,
// email.apple.com, spotify.com, accounts.google.com…).
//
// L'objet reste le repli, et il doit le rester : un renvoi, une passerelle ou
// une adresse générique ne dit rien de la marque, et supprimer ce repli ferait
// perdre des codes légitimes.
function servicesCorrespondants(services, from, subject) {
  const liste = services || [];

  const parExpediteur = liste.filter((svc) =>
    correspond(svc, String(from || "").toLowerCase()),
  );
  if (parExpediteur.length > 0) return parExpediteur;

  const botte = `${from || ""} ${subject || ""}`.toLowerCase();
  return liste.filter((svc) => correspond(svc, botte));
}

// Retourne les SubscriptionService correspondant à l'email reçu.
async function identifyServices(from, subject) {
  const services = await loadServices();
  const matched = servicesCorrespondants(services, from, subject);

  return matched;
}

// ── Validité d'une commande ──────────────────────────────────────────────────
// Depuis l'ajout de `SubscriptionOrder.expiresAt`, la date est stockée et fait
// foi. Le calcul qui suit ne sert plus qu'aux commandes antérieures restées
// sans date : il dérive la durée du plan, en retrouvant par division le
// multiplicateur encodé dans le montant pour les achats via panier. C'est
// précisément ce calcul qui se trompait sur une commande dont le montant
// incluait une quantité ou des frais.
function computeExpiry(order) {
  // La date enregistrée fait foi dès qu'elle existe. L'ancien calcul, qui
  // déduit la durée du montant payé, ne subsiste que pour les commandes
  // antérieures dont la durée n'a pas pu être retrouvée.
  if (order.expiresAt) return new Date(order.expiresAt);

  const plan = order.plan || {};
  const baseMonths = plan.duration || 1;
  const price = plan.price || 0;

  let multiplier = 1;
  if (price > 0 && order.amount > 0) {
    const m = Math.round(order.amount / price);
    // On n'accepte le multiplicateur que si la division tombe juste (±5 %),
    // sinon le montant vient d'autre chose (remise, frais, quantité…).
    if (m >= 1 && m <= 12 && Math.abs(m * price - order.amount) <= price * 0.05) {
      multiplier = m;
    }
  }

  const expiry = new Date(order.createdAt);
  expiry.setMonth(expiry.getMonth() + baseMonths * multiplier);
  return expiry;
}

const GRACE_DAYS = Number(process.env.OTP_VALIDITY_GRACE_DAYS || 3);

function isOrderActive(order, now = new Date()) {
  // Une formule a vie n'expire jamais, et ce test doit passer AVANT
  // `computeExpiry`. Une telle commande n'a volontairement pas d'`expiresAt` :
  // le repli historique s'appliquerait donc, retomberait sur `plan.duration`
  // — 1 par defaut — et couperait au bout d'un mois l'acces d'un client qui a
  // paye precisement pour ne jamais l'etre.
  if (estAVie(order?.plan)) return true;

  const expiry = computeExpiry(order);
  const withGrace = new Date(expiry.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
  return withGrace >= now;
}

// ── Peut-on envoyer sans risque de confusion ? ───────────────────────────────
// Fonction pure : toute la décision « ce code part-il seul, ou remonte-t-il à
// l'admin ? » tient ici, sans base de données.
//
// Un code de foyer arrive sur l'adresse du COMPTE et n'indique jamais quel
// profil ni quelle personne l'a déclenché. Depuis que plusieurs clients
// partagent un profil, l'ambiguïté est la règle et non l'exception : on refuse
// de deviner et on laisse l'administrateur trancher — sauf quand une demande
// explicite du client (`demandeOuverte`) lève cette ambiguïté elle-même.
//
// Les services `link_access` (Spotify, Canva, ChatGPT…) n'ont ni compte ni
// profil : le rattachement n'y est pas manquant, il est structurellement
// impossible. Leur appliquer la même prudence bloquerait leurs codes pour
// toujours, en invitant à une correction qu'aucune page ne permet.
function decideEnvoi({
  categorieService,
  scope,
  occupationsActives,
  candidats,
  demandeOuverte,
}) {
  if (categorieService === "link_access") {
    const clientsActifs = candidats?.length ?? 1;
    if (clientsActifs <= 1) {
      return { envoyer: true, raison: "client-unique", occupantsActifs: clientsActifs };
    }
    // Plusieurs clients actifs, et rien dans le mail ne dit lequel s'est
    // connecte : meme ambiguite que sur un compte partage, meme reponse.
    return { envoyer: false, raison: "ambigu", occupantsActifs: clientsActifs };
  }

  // ── Aucun compte n'a pu etre identifie pour ce code ─────────────────────
  //
  // `resolveTargetOrder` est alors passee par le rapprochement par SERVICE :
  // elle rend un dernier acheteur actif, mais AUCUNE occupation — il n'y a pas
  // de compte dont les lire. La suite de cette fonction raisonne sur les
  // occupations : sans cette branche, un service famille repondait
  // « aucun-occupant » et rien ne partait, alors que le repli demande est
  // precisement d'envoyer au dernier acheteur.
  //
  // Le doute est signale ailleurs (`rapprochementDevine`, imapBot) : ce
  // destinataire n'a pas forcement de profil sur la boite d'ou vient le code.
  if (scope === "service") {
    const clientsActifs = candidats?.length ?? 0;
    if (clientsActifs === 0) {
      return { envoyer: false, raison: "aucun-occupant", occupantsActifs: 0 };
    }
    // Un seul client actif sur tout le service : il n'y a rien a deviner, le
    // code ne peut etre que le sien. Refuser bloquerait un client legitime
    // pour une ambiguite qui n'existe pas.
    if (clientsActifs === 1) {
      return { envoyer: true, raison: "client-unique-service", occupantsActifs: 1 };
    }
    return { envoyer: false, raison: "ambigu", occupantsActifs: clientsActifs };
  }

  const occupations = occupationsActives || [];

  // Une demande ouverte tranche avant tout le reste, y compris quand un seul
  // occupant existe : c'est le client lui-même qui vient de dire qu'il attend
  // un code, et rien n'est plus fiable que ça. C'est ce qui fait disparaître
  // la remontée manuelle à l'administrateur.
  //
  // Deux réserves, et chacune ferme un trou distinct.
  //
  // 1. L'occupation désignée doit figurer PARMI LES ACTIVES au moment de
  //    l'envoi. Une fenêtre dure quinze minutes ; en quinze minutes une place
  //    peut avoir été libérée, déplacée sur un autre profil ou avoir franchi
  //    son `endsAt`. Le code partirait alors à un ex-occupant — et si la place
  //    a été revendue entre-temps, au prédécesseur du nouvel occupant, qui lui
  //    n'obtiendrait rien. Quand l'occupation n'est plus là, on ne « répare »
  //    pas en devinant : on retombe simplement sur le chemin ordinaire, qui
  //    alertera l'admin si le compte est partagé.
  //
  // 2. Le canal de la demande retenue et le nombre d'occupants remontent avec
  //    la décision. Sur le canal `web`, l'identité n'est pas établie — elle est
  //    déclarée : n'importe qui peut y poster le numéro d'un client. Le code
  //    part quand même (le client légitime ne doit pas être puni du fait qu'un
  //    tiers ait pu saisir son numéro), mais l'incident ne doit pas devenir
  //    invisible : c'est ce que porte `alerteAmbiguite`. Sur `whatsapp`,
  //    l'identité de l'expéditeur est établie par le canal lui-même, il n'y a
  //    rien à signaler.
  const occupationDemandee = demandeOuverte?.occupancy;
  const demandeEncoreValable =
    occupationDemandee && occupations.some((o) => o.id === occupationDemandee.id);

  if (demandeEncoreValable) {
    const canalDemande = demandeOuverte.canal ?? null;
    return {
      envoyer: true,
      raison: "demande-ouverte",
      occupation: occupationDemandee,
      demandeId: demandeOuverte.id,
      occupantsActifs: occupations.length,
      canalDemande,
      alerteAmbiguite: canalDemande === "web" && occupations.length > 1,
    };
  }

  if (occupations.length === 0) {
    return { envoyer: false, raison: "aucun-occupant", occupantsActifs: 0 };
  }
  if (occupations.length === 1) {
    return {
      envoyer: true,
      raison: "occupant-unique",
      occupation: occupations[0],
      occupantsActifs: 1,
    };
  }
  // Compte partagé, aucune demande ouverte : le code part au DERNIER ACHETEUR
  // de ce compte, et l'administrateur est alerté.
  //
  // Ce qui rend ce choix légitime ICI, et illégitime plus haut (`scope
  // "service"`), tient en une phrase : ces occupants ont reçu des identifiants
  // dont l'adresse EST celle de la boîte d'où sort ce code
  // (`choisirCompteDestinataire` retient le compte a qui le service a ecrit).
  // Le code leur est donc réellement destiné, à l'un d'entre eux — reste à
  // savoir lequel, et le plus récent acheteur est le pari le moins mauvais.
  //
  // Le repli par SERVICE, lui, désignait le dernier acheteur de tout le
  // service, sans aucun lien avec la boîte : un client sans identifiants sur
  // cette adresse, pour qui le code ne pouvait pas marcher. C'est celui-là qui
  // concentrait les codes de tout le monde sur une seule personne, et lui seul
  // a été supprimé.
  //
  // L'alerte est CONSERVÉE : l'admin voit à qui c'est parti et combien
  // d'occupants étaient en lice. La demande ouverte reste prioritaire — quand
  // le client dit lui-même qu'il attend un code, on ne parie plus du tout.
  const dernier = dernierAcheteur(occupations);
  return {
    envoyer: true,
    raison: "dernier-acheteur",
    occupation: dernier,
    occupantsActifs: occupations.length,
    alerteAmbiguite: true,
  };
}

// Parmi des occupations actives, celle du client qui a acheté le plus
// récemment.
//
// Elle ne tranche QUE parmi les occupants d'un meme compte streaming, c'est-a-
// dire des clients dont les identifiants portent l'adresse d'ou vient le code.
// Elle a un temps servi aussi au repli par SERVICE, sur des candidats sans
// aucun lien avec la boite : c'est cet emploi-la, et lui seul, qui envoyait a
// une personne les codes de tout le monde.
//
// `order.createdAt` fait foi ; à défaut, la date de placement, puis
// l'ordre de la liste — qui arrive déjà triée du plus récent au plus ancien.
// Aucune date exploitable ne doit jamais faire échouer la fonction : le bot
// tomberait alors sans envoyer quoi que ce soit.
function dernierAcheteur(occupations) {
  const instant = (o) => {
    const brut = o?.order?.createdAt ?? o?.startedAt;
    if (!brut) return null;
    const t = new Date(brut).getTime();
    return Number.isNaN(t) ? null : t;
  };

  let meilleur = occupations[0];
  let meilleurT = instant(meilleur);
  for (const candidat of occupations.slice(1)) {
    const t = instant(candidat);
    if (t !== null && (meilleurT === null || t > meilleurT)) {
      meilleur = candidat;
      meilleurT = t;
    }
  }
  return meilleur;
}


// Lequel de ces comptes a RECU ce code ?
//
// Le rapprochement regarde la boite surveillee et tous les destinataires du
// message : quand un compte renvoie vers un autre, deux comptes declares
// peuvent correspondre au meme mail. La boite surveillee prime — c'est elle
// qui a materiellement recu le code. A defaut, un unique compte rapproche fait
// l'affaire. Au-dela, on ne tranche pas : rendre `null` laisse l'appelant
// signaler le doute plutot que de choisir au hasard.
//
// Refonte du 13/10/2026 : le compte est celui dont le service a ECRIT
// l'adresse (`ecrites` : To, Cc, X-Original-To). La boite connectee et
// Delivered-To (`transport`) ne servent qu'en repli, quand aucune adresse
// ecrite ne correspond.
//
// L'ancienne regle faisait primer la boite connectee, « qui a materiellement
// recu le code ». C'est faux des qu'un renvoi ou un alias existe : un mail
// ecrit au compte A et lu dans la boite B partait chez les clients de B. Le
// code d'un foyer ne marche que pour ce foyer — l'adresse a laquelle le service
// l'a envoye est la seule qui dise lequel.
//
// Deux comptes possibles au meme niveau : personne n'est designe (`ambigus`).
// L'ancienne regle les fusionnait et envoyait au dernier acheteur des deux,
// c'est-a-dire potentiellement a quelqu'un sans identifiants sur ce foyer.
function choisirCompteDestinataire(comptes, { ecrites = [], transport = [] } = {}) {
  const liste = comptes || [];
  const ensemble = (adresses) => new Set((adresses || []).map(normalizeEmail).filter(Boolean));
  const parmi = (adresses) => {
    const cibles = ensemble(adresses);
    return liste.filter((c) => cibles.has(normalizeEmail(c.email)));
  };

  const parEcrites = parmi(ecrites);
  if (parEcrites.length === 1) return { compte: parEcrites[0], par: "adresse-ecrite" };
  if (parEcrites.length > 1) return { compte: null, ambigus: parEcrites };

  const parTransport = parmi(transport);
  if (parTransport.length === 1) return { compte: parTransport[0], par: "boite" };
  if (parTransport.length > 1) return { compte: null, ambigus: parTransport };

  return { compte: null, ambigus: [] };
}

// ── L'invariant : ce client detient-il les identifiants de CETTE boite ? ─────
//
// Regle posee par le proprietaire : qui recoit le code venu d'une adresse doit
// avoir recu des identifiants portant cette meme adresse. Sinon le code ne peut
// pas marcher chez lui, et il ouvre le foyer de quelqu'un d'autre.
//
// Le compte est deja rapproche par son mail (`choisirCompteDestinataire`), ce
// qui couvre le cas courant. Reste une faille propre aux PROFILS :
// `dechiffrerIdentifiants` compose le mail envoye au client comme
// `profil.email || compte.email`. Un profil dont la colonne `email` est
// renseignee PRIME donc sur son compte, et rien n'impose que les deux
// concordent. Un profil renseigne de travers donne au client des identifiants
// qu'aucune boite surveillee n'alimente.
//
// Un mail de profil vide est le cas normal (il herite du compte, deja
// rapproche) : on laisse passer. Une boite inconnue ne permet aucune
// comparaison : on laisse passer aussi, le refus se joue ailleurs.
//
// `adresses` est l'ensemble des adresses auxquelles le message a ete ECRIT —
// boite connectee comprise. Comparer a la seule boite connectee etait faux :
// par renvoi, elle n'est que le transport, et le verrou ecartait un occupant
// dont le profil porte justement l'adresse ecrite par le service. Une chaine
// seule reste acceptee.
function detientIdentifiantsDeLaBoite(occupation, adresses) {
  const liste = (Array.isArray(adresses) ? adresses : [adresses])
    .map(normalizeEmail)
    .filter(Boolean);
  if (liste.length === 0) return true;
  const mailIdentifiants = occupation?.profile?.email || null;
  if (!mailIdentifiants) return true;
  return liste.includes(normalizeEmail(mailIdentifiants));
}

// ── Les mails que la plateforme s'envoie a elle-meme ─────────────────────────
//
// Incident du 12/10/2026, releve dans les journaux du VPS : `ADMIN_EMAIL` est
// aussi la boite d'un compte Netflix surveille. A chaque code livre, le bot
// envoyait a l'administrateur « 🔐 OTP reçu — Netflix : 1574 », relisait cette
// alerte dans sa propre boite, ne trouvait aucune marque dans l'expediteur,
// retombait sur l'objet — qui dit « Netflix » — et renvoyait le code au
// dernier acheteur de ce compte. Chaque code partait une seconde fois, chez un
// client a qui il n'etait pas destine.
//
// Un mail emis par notre propre domaine n'est JAMAIS un mail de service. Le
// test porte sur le domaine exact ou un sous-domaine : un simple `includes`
// laisserait `faux-mtechbenin.com` faire taire le bot.
function estCourrielInterne(expediteur, domainesInternes) {
  const trouve = String(expediteur || "").match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (!trouve) return false;
  const domaine = trouve[1].toLowerCase();
  return (domainesInternes || []).some((d) => {
    const ref = String(d || "").trim().toLowerCase();
    return Boolean(ref) && (domaine === ref || domaine.endsWith("." + ref));
  });
}

// ── Résolution du destinataire ───────────────────────────────────────────────
// Renvoie :
//   scope "account" → { scope, compte, occupationsActives, order? }
//     `order` n'est renseigné que s'il n'y a qu'une seule occupation active
//     (cas non ambigu) ; sinon la décision revient à `decideEnvoi`.
//   scope "service" → { scope, order, activeCount, candidates }
//     (link_access, ou boîte inconnue — dernier acheteur actif)
//   échec           → { order: null, scope?, reason }
//
// scope :
//   "account" → rapproché via la boîte mail du compte streaming (précis)
//   "service" → rapproché via le service seul (link_access, ou boîte inconnue)
async function resolveTargetOrder({
  mailboxEmail,
  recipientEmails = [],
  adressesEcrites,
  services,
}) {
  if (!services || services.length === 0) {
    return { order: null, reason: "Service non identifié depuis l'expéditeur/objet" };
  }

  // ── Premier verrou : ce service transmet-il ses codes ? ─────────────────
  //
  // Certains services n'ont AUCUN code a transmettre : ceux qui arrivent dans
  // la boite appartiennent au commercant, pas au client. Les relayer donnerait
  // au client la main sur le compte.
  //
  // Le drapeau est porte par le SERVICE, pas deduit de sa categorie. La
  // categorie decrit comment l'acces est livre (profil partage ou lien), ce
  // qui ne dit rien de la propriete des codes : un service « family » peut
  // n'avoir aucun code a relayer. Deduire l'un de l'autre etait precisement
  // l'erreur de raisonnement de `decideEnvoi`.
  //
  // `transfertOtp !== false` et non `=== true` : un service charge par un
  // vieux cache, ou par un `select` qui aurait oublie le champ, doit garder le
  // comportement d'avant plutot que de se taire sans que personne ne le voie.
  const retenus = services.filter((s) => s.transfertOtp !== false);
  if (retenus.length === 0) {
    return {
      order: null,
      scope: "service",
      // `attendu` distingue un refus VOULU d'un echec de routage. Les autres
      // refus signalent une configuration a corriger ou une ambiguite a
      // trancher : ils doivent alerter. Celui-ci est la consequence exacte de
      // ce que l'administrateur a demande, et alerter a chaque code le
      // noierait sous des notifications qu'il a lui-meme provoquees — jusqu'a
      // lui apprendre a ignorer l'alerte « OTP orphelin », qui est le filet
      // des vrais echecs.
      attendu: true,
      reason:
        `Transfert des codes desactive pour ${services.map((s) => s.name).join(", ")} — ` +
        `aucun code n'est relaye pour ce service.`,
    };
  }

  const serviceIds = retenus.map((s) => s.id);
  const serviceLabel = retenus.map((s) => s.name).join(", ");

  // Deux familles d'adresses, qui ne pesent pas pareil :
  //   • ECRITES — celles que le service a mises dans le message (To, Cc,
  //     X-Original-To). C'est la seule qui dise a quel foyer appartient le code.
  //   • TRANSPORT — la boite connectee et Delivered-To : par ou le mail est
  //     arrive, qui peut etre un renvoi ou un alias.
  // Un appelant qui ne distingue pas les deux (anciens tests) voit ses
  // destinataires traites comme ecrits.
  const ecrites = adressesEcrites ?? recipientEmails;
  const transport = [mailboxEmail, ...recipientEmails];

  // ── 1. Rapprochement par compte (précis) ────────────────────────────────
  const comptesDuService = await prisma.streamingAccount.findMany({
    where: { serviceId: { in: serviceIds } },
    select: { id: true, email: true, serviceId: true },
  });

  const choix = choisirCompteDestinataire(comptesDuService, { ecrites, transport });

  if (choix.ambigus?.length > 1) {
    // Plusieurs comptes possibles. De services differents : on ne sait pas de
    // quel service vient ce code (incident du 05/09). Du meme service : on ne
    // sait pas quel foyer l'a declenche. Dans les deux cas, aucun tirage au
    // sort n'est acceptable — l'ancienne fusion envoyait au dernier acheteur
    // des comptes reunis, possiblement sans identifiants sur ce foyer.
    const servicesDesComptes = new Set(choix.ambigus.map((c) => c.serviceId));
    const noms = retenus
      .filter((s) => servicesDesComptes.has(s.id))
      .map((s) => s.name)
      .join(", ");
    return {
      order: null,
      scope: "account",
      reason:
        servicesDesComptes.size > 1
          ? `Cette boite porte les comptes de ${servicesDesComptes.size} services (${noms}) et le ` +
            `message se rattache a plusieurs d'entre eux : impossible de dire duquel vient ce ` +
            `code sans risquer de l'envoyer aux clients d'un autre service.`
          : `Le message se rattache a ${choix.ambigus.length} comptes ${noms} ` +
            `(${choix.ambigus.map((c) => c.email).join(", ")}) : impossible de dire quel foyer ` +
            `a declenche ce code. Transmettez-le au bon client.`,
    };
  }

  if (choix.compte) {
    const compte = choix.compte;
    const occupationsTrouvees = await occupationsActivesDuCompte(compte.id);

    // Le verrou de l'invariant : le client doit detenir des identifiants
    // portant l'adresse de CE compte. Un profil dont le mail propre differe
    // donne a son occupant des identifiants qu'aucun code d'ici n'atteint.
    const occupationsActives = occupationsTrouvees.filter((o) =>
      detientIdentifiantsDeLaBoite(o, [compte.email]),
    );

    return {
      scope: "account",
      compte,
      comptes: [compte],
      // Comment le compte a ete designe : par l'adresse ecrite par le service
      // (certain), ou par la boite connectee faute de mieux. Consigne au
      // journal pour qu'un doute reste visible.
      rapprochePar: choix.par,
      occupationsActives,
      order: occupationsActives.length === 1 ? occupationsActives[0].order : null,
    };
  }

  // ── 2. Aucun compte ne correspond à cette boîte ─────────────────────────
  // Deux situations très différentes :
  //  • Le service n'utilise pas de comptes famille (link_access : Spotify,
  //    Canva, ChatGPT…) → le rapprochement par service est le seul possible
  //    et il est légitime.
  //  • Le service EST un service famille et des comptes existent, mais aucun
  //    sur cette boîte → l'adresse n'est pas déclarée en admin. Deviner un
  //    destinataire ici reviendrait à envoyer le code d'un compte au client
  //    d'un autre : on refuse et on laisse l'admin trancher.
  // Aucun compte ne porte cette adresse, alors que le service en declare.
  // L'adresse manque en admin, ou comporte une faute de frappe.
  //
  // ON S'ARRETE ICI. Le repli « dernier acheteur actif du service » a ete
  // essaye : il livrait le code plutot que de le perdre, en signalant la
  // devinette. Mais la regle posee par le proprietaire est plus forte que ce
  // compromis — qui recoit le code venu d'une adresse doit avoir recu des
  // identifiants portant CETTE adresse. Ici, par construction, aucun compte ne
  // la porte : le destinataire designe n'a aucun profil sur cette boite, et le
  // code ne peut pas marcher chez lui. Il ouvrirait le foyer d'un autre.
  //
  // Ce refus ne coute qu'une configuration a corriger : l'adresse surveillee
  // doit etre declaree en administration. Tant qu'elle ne l'est pas, aucun
  // destinataire n'est designable, et le silence vaut mieux qu'un code livre
  // au hasard.
  //
  // La distinction avec `link_access` tient a `comptesDuService` : ces services
  // n'ont AUCUN compte declare, le rattachement y est structurellement
  // impossible et non pas manquant. Leur repli par service reste donc permis.
  if (comptesDuService.length > 0) {
    return {
      order: null,
      scope: "service",
      reason:
        `Aucun compte de ${serviceLabel} ne porte l'adresse ${mailboxEmail || "(inconnue)"} : ` +
        `elle n'est pas declaree en administration. Aucun client n'a recu d'identifiants ` +
        `portant cette adresse, donc aucun destinataire n'est designable.`,
    };
  }

  // ── Deuxieme verrou : on ne fusionne JAMAIS deux services ────────────────
  //
  // `servicesCorrespondants` fait desormais primer l'expediteur, ce qui retire
  // la cause connue des identifications multiples. Ce verrou couvre le reste :
  // un expediteur qui nommerait deux marques, un objet ambigu en repli, un
  // alias ajoute plus tard.
  //
  // Sans lui, la requete ci-dessous porte sur `serviceId: { in: serviceIds }`
  // et le « dernier acheteur » est pris TOUS SERVICES CONFONDUS : le code de
  // l'un part alors chez le client de l'autre, qui n'a rien a en faire et pour
  // qui il ne marchera pas. C'est l'incident du 05/09/2026.
  //
  // Meme principe que `choisirCompteDestinataire` un peu plus haut : quand on
  // ne peut pas designer le proprietaire, on ne tire pas au sort — on rend la
  // main a l'administrateur, qui voit le doute et transmet lui-meme.
  if (retenus.length > 1) {
    return {
      order: null,
      scope: "service",
      reason:
        `Message rattache a ${retenus.length} services (${serviceLabel}) et aucun compte ` +
        `ne porte l'adresse : impossible de designer un destinataire sans risquer ` +
        `d'envoyer le code d'un service au client d'un autre.`,
    };
  }

  const candidateOrders = await prisma.subscriptionOrder.findMany({
    where: { serviceId: { in: serviceIds }, status: "CONFIRMED" },
    include: {
      service: { select: { name: true, slug: true, category: true } },
      // `aVie` est indispensable ici : `isOrderActive` le lit, et un `select`
      // qui l'oublierait ferait expirer les formules a vie en silence.
      plan: { select: { label: true, duration: true, price: true, aVie: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  if (candidateOrders.length === 0) {
    return {
      order: null,
      scope: "service",
      reason: `Aucune commande payée (CONFIRMED) pour ${serviceLabel}`,
    };
  }

  // ── 3. On ne garde que les commandes encore valides ───────────────────────
  const active = candidateOrders.filter((o) => isOrderActive(o));
  if (active.length === 0) {
    return {
      order: null,
      scope: "service",
      reason: `${candidateOrders.length} commande(s) trouvée(s) pour ${serviceLabel} mais toutes expirées`,
    };
  }

  // ── 4. Dernier acheteur actif ─────────────────────────────────────────────
  const target = active[0]; // déjà trié par createdAt desc

  return {
    order: target,
    scope: "service",
    activeCount: active.length,
    candidates: active,
    // `rapprochementDevine` a disparu : ce chemin n'est plus atteint que par
    // les services SANS aucun compte declare (link_access), pour lesquels il
    // n'y a pas d'adresse a faire correspondre. Le cas « des comptes existent
    // mais aucun ne porte cette boite » est desormais refuse plus haut, au
    // lieu d'etre livre puis signale.
  };
}

// ── Diagnostic de configuration ──────────────────────────────────────────────
// Repère les comptes famille dont l'adresse n'est surveillée par aucune boîte
// configurée : leurs OTP n'arriveront jamais (faute de frappe, boîte oubliée…).
async function auditAccountCoverage(watchedEmails) {
  const watched = new Set(watchedEmails.map(normalizeEmail).filter(Boolean));
  // Les adresses qui reçoivent les codes vivent désormais sur `StreamingAccount`
  // — `FamilyAccount.email` (le profil) existe toujours mais n'en est plus la
  // source de vérité.
  const comptes = await prisma.streamingAccount.findMany({
    select: { email: true, service: { select: { name: true } } },
  });

  const uncovered = comptes.filter((c) => !watched.has(normalizeEmail(c.email)));
  const grouped = {};
  for (const c of uncovered) {
    const key = c.email;
    if (!grouped[key]) grouped[key] = { count: 0, services: new Set() };
    grouped[key].count += 1;
    grouped[key].services.add(c.service?.name || "?");
  }
  return Object.entries(grouped).map(([email, v]) => ({
    email,
    accounts: v.count,
    services: [...v.services].join(", "),
  }));
}

// ── Fraîcheur d'un courriel ──────────────────────────────────────────────────
//
// Un code de vérification expire en quelques minutes. En expédier un vieux de
// plusieurs jours ne rend service à personne : le client reçoit, sans avoir
// rien demandé, un code qui ne fonctionne pas.
//
// Cette borne existe parce que son absence a coûté cher. La recherche IMAP se
// faisait sur `{ seen: false }` sans aucune limite de date : elle remontait
// donc TOUT l'arriéré non lu d'une boîte. Le jour où deux boîtes jamais
// surveillées ont été ajoutées à IMAP_ACCOUNTS, le bot a rejoué leur
// historique et expédié cinq codes périmés à deux clients en quelques
// secondes — par WhatsApp et par courriel.
//
// Un message sans date est traité : mieux vaut un envoi de trop qu'un code
// légitime perdu parce que l'en-tête manquait.
function estCourrielRecent(dateMessage, maintenant, fenetreMs) {
  if (!(dateMessage instanceof Date) || Number.isNaN(dateMessage.getTime())) return true;
  if (!Number.isFinite(fenetreMs) || fenetreMs <= 0) return true;
  return maintenant - dateMessage.getTime() <= fenetreMs;
}

// Faut-il envoyer une SECONDE copie au destinataire d'un cadeau ?
//
// Le code partait a `giftWhatsapp` sans jamais verifier que ce numero differe
// de celui qui venait de recevoir le message. Un acheteur qui commande « pour
// offrir » en laissant son propre numero — ou en l'ecrivant sous une autre
// forme, « 97 00 00 01 » d'un cote et « +229 97 00 00 01 » de l'autre —
// recevait donc DEUX FOIS le meme code, a deux secondes d'intervalle.
//
// `memeNumero` et non `!==` : les deux valeurs viennent de saisies distinctes
// (le champ acheteur, le champ cadeau), et c'est exactement le rapprochement
// que la notification a l'administrateur fait deja quelques lignes plus loin
// pour ne pas presenter un occupant comme « acheteur distinct » de lui-meme.
//
// Une occupation existante interdit la copie, comme avant : l'occupant a deja
// recu le code — c'est lui le destinataire du cadeau le cas echeant — et un
// code de foyer est a usage unique.
function envoyerCopieCadeau({ occupation, isGift, giftWhatsapp, destinataireWhatsapp }) {
  if (occupation) return false;
  if (!isGift || !giftWhatsapp) return false;
  return !memeNumero(giftWhatsapp, destinataireWhatsapp);
}

// ── Qui recoit le code, et pour quelle commande ─────────────────────────────
//
// Deux valeurs distinctes, et les confondre a deja coute un plantage :
//   • `commandeCible` : la commande qui porte l'abonnement — c'est sur elle que
//     se posent le verrou, le journal d'OTP et le calcul d'echeance ;
//   • `destinataire`  : la personne a qui le code part. Sur un compte partage,
//     l'occupation fait foi : `occupantWhatsapp` porte le bon numero, celui du
//     destinataire pour une commande cadeau, celui de l'acheteur sinon. La
//     commande, elle, ne connait que l'acheteur.
//
// Rend `null` quand il n'y a NI occupation NI commande. Ce cas n'est pas
// theorique : il survient des qu'un code arrive sur une boite dont plus aucun
// client n'occupe de profil — apres une remise a zero de l'inventaire, par
// exemple. Le code appelant lisait alors `.clientWhatsapp` sur `null` et
// plantait AVANT d'atteindre le garde-fou qui savait traiter ce cas.
function choisirDestinataire(decision, order) {
  const occupation = decision?.occupation || null;
  const commandeCible = occupation ? occupation.order : order;
  if (!commandeCible) return null;

  const destinataire = occupation
    ? { whatsapp: occupation.occupantWhatsapp, nom: occupation.occupantName }
    : { whatsapp: commandeCible.clientWhatsapp, nom: commandeCible.clientName };

  return { commandeCible, destinataire };
}

module.exports = {
  // Lu par otpClassement.js : la meme table d'alias reconnait un service par
  // le domaine de son expediteur.
  SERVICE_ALIASES,
  choisirDestinataire,
  envoyerCopieCadeau,
  estCourrielRecent,
  choisirCompteDestinataire,
  detientIdentifiantsDeLaBoite,
  estCourrielInterne,
  dernierAcheteur,
  normalizeEmail,
  stripHtml,
  extractOTP,
  identifyServices,
  // Lu par imapBot : le classement a besoin de TOUS les services, pas d'une
  // identification deja faite par l'objet.
  loadServices,
  servicesCorrespondants,
  viderCacheServices,
  computeExpiry,
  isOrderActive,
  decideEnvoi,
  resolveTargetOrder,
  auditAccountCoverage,
};
