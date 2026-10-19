// Fonctions pures liées à la réserve de liens d'accès.
//
// Sans accès base ni service externe : c'est ce qui permet de les tester
// directement, là où le reste de la fonctionnalité ne se vérifie que sur une
// vraie base.

// Seuls http et https sont acceptés. Un « lien » qui n'ouvre pas une page web
// — texte libre, schéma exotique, `javascript:` — envoyé à un client serait
// pire que ne rien envoyer : il paierait pour un accès inutilisable.
const SCHEMAS_AUTORISES = new Set(["http:", "https:"]);

function lienValide(valeur) {
  if (typeof valeur !== "string") return false;
  const propre = valeur.trim();
  if (!propre) return false;

  let analyse;
  try {
    analyse = new URL(propre);
  } catch {
    // `new URL` lève sur une entrée illisible : on répond `false` plutôt que
    // de laisser l'exception remonter jusqu'au contrôleur.
    return false;
  }
  if (!SCHEMAS_AUTORISES.has(analyse.protocol)) return false;
  return Boolean(analyse.hostname);
}

// Statut à écrire sur la ligne cliente après les deux tentatives d'envoi.
//
// Un seul canal suffit : le client a reçu son lien. Les deux en échec laissent
// la ligne « en_attente », avec le lien déjà renseigné — elle réapparaît alors
// dans l'écran de saisie manuelle, où l'administrateur réessaie en un clic.
//
// En cas d'appel sans argument (ou avec null/undefined), retourne « en_attente »
// plutôt que de lever. Cette fonction est le juge prudent du système : si une
// fonction d'envoi en amont oublie de retourner son objet, il est bien préférable
// qu'on laisse la ligne visible pour l'administrateur que de faire tomber toute la
// requête. Silence prudent plutôt que crash.
function statutApresEnvoi(params = {}) {
  // Traite null/undefined comme un objet vide pour éviter toute levée.
  const { whatsappOk = false, emailOk = false } = params || {};
  return whatsappOk === true || emailOk === true ? "envoyé" : "en_attente";
}

module.exports = { lienValide, statutApresEnvoi };
