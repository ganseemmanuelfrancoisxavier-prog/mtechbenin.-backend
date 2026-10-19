// ─────────────────────────────────────────────────────────────────────────────
// Élagage de la session WhatsApp — décision pure.
//
// Aucune dépendance : ni Baileys, ni disque, ni base. Ce fichier ne décide que
// d'une chose — quels fichiers de session peuvent disparaître sans casser quoi
// que ce soit — et cette décision doit pouvoir être testée sans ouvrir de
// session sur le numéro de production.
// ─────────────────────────────────────────────────────────────────────────────

// ── Pourquoi un élagage par NATURE, et non par âge ──────────────────────────
//
// L'intention de départ était « supprimer les données de session plus vieilles
// que N jours ». Deux mesures en production l'ont écartée :
//
//  1. Les dates des FICHIERS ne veulent rien dire. Au démarrage, la session est
//     restaurée depuis la base et tout le dossier est réécrit : les `mtime`
//     sont alors identiques et ne disent rien de l'âge des données.
//
//  2. Les dates DANS le contenu ne discriminent pas non plus. Les fichiers
//     `session-*` portent bien un `indexInfo.used` en millisecondes — un
//     horodatage réel, immunisé contre la réécriture. Mais sur 2 943 sessions
//     mesurées, la PLUS ANCIENNE avait 4 jours : Baileys rafraîchit `used`
//     bien plus souvent qu'on ne l'imagine. Un seuil à 7, 30 ou 180 jours
//     libérait exactement zéro fichier.
//
// Ce qui grossit réellement, mesuré sur 20 heures après un élagage complet :
// `sender-key-status@broadcast` est repassé de 0 à 2 045 fichiers et 3,83 Mo,
// soit 35 % du poids de la session. Ce sont les clés servant à DÉCHIFFRER LES
// STATUTS publiés par les contacts. Un bot qui envoie des notifications de
// commande et lit des messages entrants n'a jamais lu un statut et n'en lira
// jamais. Si l'une venait à manquer, WhatsApp la renverrait.
//
// La « durée donnée » demandée porte donc sur la FRÉQUENCE de l'élagage, pas
// sur l'âge des fichiers : `WHATSAPP_ELAGAGE_HEURES`.

// ── Ce à quoi on ne touche pas, et pourquoi ─────────────────────────────────
//
//   creds.json          l'identité — la perdre impose de rescanner un QR
//   app-state-sync-*    synchronisation ; même conséquence
//   session-*           chiffrement propre à un contact ; en supprimer un
//                       provoque un échec de déchiffrement avec ce contact
//   identity-key-*      l'identité de ce contact, même raison
//   pre-key-*           permettent à un NOUVEAU contact d'ouvrir une session ;
//                       le serveur WhatsApp les annonce déjà de son côté
//   lid-mapping-*       correspondance identifiant masqué ↔ numéro, utilisée
//                       pour répondre aux messages entrants. Moitié des
//                       fichiers, mais 0,16 Mo : le gain ne vaut pas le risque
//                       de ne plus savoir répondre à un client.
//   sender-key-<groupe> clés de groupe ; 0,11 Mo, sans intérêt à supprimer
//
// Le préfixe est vérifié avec `startsWith` sur le nom complet, et la famille
// des statuts est distinguée des autres `sender-key-` par le marqueur
// `status@`. Une correspondance approximative risquerait d'emporter une clé de
// groupe légitime.
const PREFIXE_STATUT = "sender-key-status@";

/**
 * Parmi `noms`, ceux qui peuvent être supprimés sans conséquence.
 *
 * Rend un tableau, éventuellement vide. Ne lève jamais : une entrée qui n'est
 * pas une chaîne est ignorée plutôt que de faire échouer tout l'élagage.
 */
function fichiersElaguables(noms) {
  if (!Array.isArray(noms)) return [];
  return noms.filter(
    (nom) => typeof nom === "string" && nom.startsWith(PREFIXE_STATUT),
  );
}

// ── Fréquence ───────────────────────────────────────────────────────────────
//
// 24 h par défaut : à 3,8 Mo produits en 20 heures, un passage quotidien suffit
// à empêcher l'accumulation sans agiter la session.
//
// `0` — ou toute valeur illisible ou négative — DÉSACTIVE l'élagage. Un
// réglage incompréhensible ne doit pas se traduire par un comportement
// surprenant sur une session de production : il doit ne rien faire.
const HEURES_PAR_DEFAUT = 24;
const MAX_HEURES = 24 * 30;

function intervalleElagageMs(brut, parDefaut = HEURES_PAR_DEFAUT) {
  if (brut === undefined || brut === null || brut === "") {
    return parDefaut * 3600 * 1000;
  }
  const n = Number(brut);
  if (!Number.isFinite(n) || n <= 0) return 0; // désactivé
  // Borné : une valeur absurde (un an) reviendrait à désactiver sans le dire.
  return Math.min(n, MAX_HEURES) * 3600 * 1000;
}

module.exports = {
  fichiersElaguables,
  intervalleElagageMs,
  PREFIXE_STATUT,
  HEURES_PAR_DEFAUT,
  MAX_HEURES,
};
