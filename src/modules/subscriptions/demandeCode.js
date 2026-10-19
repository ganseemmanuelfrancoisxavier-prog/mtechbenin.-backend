// ─────────────────────────────────────────────────────────────────────────────
// Demande de code — décisions pures.
//
// Aucun accès base de données ici : l'appelant compose les demandes depuis la
// base (voir demandeCodeStore.js) et applique le résultat.
// ─────────────────────────────────────────────────────────────────────────────

// Assez pour que la plateforme envoie son mail après la tentative de connexion,
// assez court pour qu'une demande oubliée ne capte pas le code de quelqu'un
// d'autre une heure plus tard.
const FENETRE_MS = 15 * 60 * 1000;

// Un numéro n'a pas d'écriture canonique dans ce projet : saisi à la main en
// admin, il porte tantôt un « + », des espaces ou des tirets ; Baileys le livre
// sous la forme `22997437551@s.whatsapp.net`. On compare donc les chiffres
// seuls. En deçà de 8 chiffres, ce n'est pas un numéro joignable : on rend
// `null` plutôt qu'une chaîne courte qui pourrait en croiser une autre.
function normaliserNumero(brut) {
  if (!brut) return null;
  const chiffres = String(brut).replace(/\D/g, "");
  return chiffres.length >= 8 ? chiffres : null;
}

// Nombre de chiffres de fin qu'il faut partager pour qu'on accepte de
// rapprocher deux ecritures d'un meme numero. Huit : la longueur d'un numero
// national au Benin. En dessous, on rassemblerait des inconnus.
const CHIFFRES_SIGNIFICATIFS = 8;

// Deux ecritures designent-elles le meme numero ?
//
// L'egalite stricte ne suffit pas, et c'est ce qui faisait echouer la demande
// de code : le client saisit spontanement sa forme locale (« 97 00 00 00 »)
// alors que sa commande porte la forme internationale (« +229 97 00 00 00 »).
// Aucune occupation ne correspondait, et le canal web repondait quand meme
// « Demande enregistree » — il attendait un code qui ne pouvait pas partir.
//
// On rapproche donc deux ecritures de LONGUEURS DIFFERENTES quand la plus
// courte termine la plus longue. Deux numeros de MEME longueur restent compares
// a l'identique : le Togo est en +228 et le Benin en +229, et se rapprocher par
// la fin y confondrait deux personnes distinctes.
function memeNumero(a, b) {
  const na = normaliserNumero(a);
  const nb = normaliserNumero(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length === nb.length) return false;

  const [court, long] = na.length < nb.length ? [na, nb] : [nb, na];
  return court.length >= CHIFFRES_SIGNIFICATIFS && long.endsWith(court);
}

// Le numéro de la boutique sert aussi au service client. Le bot ne réagit donc
// qu'à un mot exact : « je veux un code » est une conversation, pas une
// commande, et y répondre automatiquement serait s'immiscer dedans.
function motCleDemande(texte) {
  if (!texte) return false;
  return String(texte).trim().toLowerCase() === "code";
}

// La demande valide qui fait foi. « Valide » veut dire : pas encore servie, et
// pas encore expirée.
//
// L'ordre de priorité n'est PAS « la plus récente » seule, et c'est la garde
// contre le sabotage : le formulaire public n'établit aucune identité, on y
// déclare un numéro. Un tiers qui y poste le numéro d'un client ouvre une
// fenêtre sur tous ses comptes et fait partir chez lui les codes que les autres
// occupants déclenchent — le tout sans alerte, puisqu'une demande ouverte fait
// justement disparaître la remontée « ambigu ». Sur WhatsApp au contraire,
// l'identité de l'expéditeur est établie par le canal lui-même.
//
// D'où : le canal `whatsapp` prime sur `web`, quelle que soit l'heure ; à
// canal égal, la plus récente l'emporte (le dernier à avoir tenté de se
// connecter est presque toujours celui qui a déclenché le mail).
function choisirDemande(demandes, maintenant = new Date()) {
  const valides = (demandes || []).filter(
    (d) => !d.servedAt && new Date(d.expiresAt) > maintenant,
  );
  if (valides.length === 0) return null;

  const rang = (d) => (d.canal === "whatsapp" ? 1 : 0);

  return valides.reduce((meilleure, d) => {
    if (rang(d) !== rang(meilleure)) return rang(d) > rang(meilleure) ? d : meilleure;
    return new Date(d.requestedAt) > new Date(meilleure.requestedAt) ? d : meilleure;
  });
}

// ── Plafond anti-abus ────────────────────────────────────────────────────────
//
// Le plafond vaut par TENTATIVE, pas par ligne écrite. `ouvrirDemandes` crée
// volontairement une ligne par occupation active : un client abonné à trois
// services produit trois lignes d'un seul « CODE ». Compter les lignes
// bloquerait ce client dès sa deuxième tentative — c'est-à-dire précisément
// quand il redemande parce qu'il n'a rien reçu, et, sur le canal web, en lui
// affichant le message de succès. Il attendrait alors un code qui ne viendra
// jamais.
//
// Une tentative = toutes les lignes ouvertes au même instant : `ouvrirDemandes`
// pose le même `requestedAt` (l'objet `maintenant`) sur toute la fournée.
const PLAFOND_TENTATIVES = 5;

function compterTentatives(demandes) {
  const instants = new Set();
  for (const d of demandes || []) {
    const t = new Date(d.requestedAt).getTime();
    if (Number.isFinite(t)) instants.add(t);
  }
  return instants.size;
}

function plafondAtteint(demandes) {
  return compterTentatives(demandes) >= PLAFOND_TENTATIVES;
}

module.exports = {
  FENETRE_MS,
  PLAFOND_TENTATIVES,
  normaliserNumero,
  memeNumero,
  motCleDemande,
  choisirDemande,
  compterTentatives,
  plafondAtteint,
};
