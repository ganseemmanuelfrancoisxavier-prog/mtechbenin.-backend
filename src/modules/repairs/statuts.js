// Cycle de vie d'une réparation.
//
// Fonction pure : elle ne connaît ni la base ni WhatsApp. Le contrôleur lui
// demande si un passage est permis, elle répond ; c'est lui qui écrit et qui
// notifie.

// L'ordre du tableau EST la règle : on ne peut avancer que vers le suivant.
const STATUTS = [
  "EN_ATTENTE",
  "PAYEE",
  "A_RECUPERER",
  "RECUPEREE",
  "EN_ATELIER",
  "REPAREE",
  "A_RENDRE",
  "RENDUE",
];

const LIBELLES = {
  EN_ATTENTE: "En attente de paiement",
  PAYEE: "Payée",
  A_RECUPERER: "À récupérer",
  RECUPEREE: "Récupérée",
  EN_ATELIER: "En atelier",
  REPAREE: "Réparée",
  A_RENDRE: "À rendre",
  RENDUE: "Rendue",
  ANNULEE: "Annulée",
};

// Ce que le client lit à chaque étape. `null` = on ne le dérange pas.
//
// `PAYEE` est volontairement muet : le client vient de payer sous ses propres
// yeux, un message le lui apprenant n'apporte rien.
const MESSAGES = {
  EN_ATTENTE: null,
  PAYEE: null,
  A_RECUPERER: "Votre demande est confirmée. Un livreur va passer récupérer votre appareil.",
  RECUPEREE: "Nous avons bien récupéré votre appareil.",
  EN_ATELIER: "Votre appareil est entre les mains de nos techniciens.",
  REPAREE: "Bonne nouvelle : votre appareil est réparé.",
  A_RENDRE: "Votre appareil est prêt. Nous vous contactons pour convenir de la remise.",
  RENDUE: "Votre appareil vous a été remis. Merci de votre confiance.",
  ANNULEE: "Votre demande de réparation a été annulée. Nous vous contactons pour la suite.",
};

function libelleStatut(statut) {
  return LIBELLES[statut] || statut;
}

function messageClient(statut) {
  return MESSAGES[statut] ?? null;
}

// Un passage est-il permis ?
//
// Deux refus, et chacun protège le client :
//   • RECULER produirait une seconde notification contredisant la première —
//     « votre appareil est réparé » puis « votre appareil est en atelier ».
//   • SAUTER une étape lui ferait manquer un message qu'il attend, typiquement
//     l'annonce du passage du livreur.
function transitionAutorisee(depuis, vers) {
  if (!LIBELLES[depuis] || !LIBELLES[vers]) {
    return { ok: false, erreur: "Statut inconnu" };
  }
  if (depuis === "RENDUE" || depuis === "ANNULEE") {
    return { ok: false, erreur: `Une réparation ${libelleStatut(depuis).toLowerCase()} est close` };
  }
  if (vers === "ANNULEE") return { ok: true };

  const i = STATUTS.indexOf(depuis);
  const j = STATUTS.indexOf(vers);
  if (j < i) return { ok: false, erreur: "Impossible de revenir en arrière" };
  if (j === i) return { ok: false, erreur: "La réparation est déjà dans cet état" };
  if (j > i + 1) {
    return { ok: false, erreur: `Étape sautée : ${libelleStatut(STATUTS[i + 1])} doit venir avant` };
  }
  return { ok: true };
}

module.exports = { STATUTS, LIBELLES, transitionAutorisee, libelleStatut, messageClient };
