// ─────────────────────────────────────────────────────────────────────────────
// Rapprochement paiement → commande.
//
// Le webhook FedaPay ne dit pas toujours quelle commande il paie. Trois voies
// existent, dans cet ordre de fiabilité :
//
//   1. `custom_metadata.orderRef`     → désigne une commande produit. Certain.
//   2. `custom_metadata.subOrderId`   → désigne une commande abonnement. Certain.
//   3. Rapprochement par montant      → une SUPPOSITION, réservée aux paiements
//      antérieurs à l'ajout des métadonnées.
//
// La voie 3 retenait « le candidat dont le montant est le plus proche ». Quand
// deux commandes ont exactement le même montant — le cas normal, deux clients
// achetant la même formule — la distance est identique et l'ancien code gardait
// simplement le premier de la liste, c'est-à-dire l'ordre de la base. Le
// paiement d'un client pouvait donc confirmer la commande d'un autre, et lui
// envoyer ses identifiants.
//
// On refuse désormais de départager un ex æquo : mieux vaut alerter l'admin que
// livrer au mauvais client.
// ─────────────────────────────────────────────────────────────────────────────

// Fonction pure. Renvoie { candidat, raison } — `candidat` à null si aucun
// choix ne peut être fait sans deviner.
function choisirParMontant(candidats, montant, getMontant = (c) => c.amount) {
  if (!candidats || candidats.length === 0) {
    return { candidat: null, raison: "aucun-candidat" };
  }

  const distances = candidats.map((c) => Math.abs(getMontant(c) - montant));
  const minimum = Math.min(...distances);
  const exAequo = candidats.filter((_, i) => distances[i] === minimum);

  if (exAequo.length > 1) {
    return { candidat: null, raison: "ambigu", exAequo: exAequo.length };
  }
  return { candidat: exAequo[0], raison: "montant-unique" };
}

module.exports = { choisirParMontant };
