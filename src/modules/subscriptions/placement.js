// ─────────────────────────────────────────────────────────────────────────────
// Choix du profil qui accueillera un nouvel acheteur.
//
// Fonction pure : elle ne lit ni n'écrit la base. L'appelant compose les
// candidats depuis la base (voir occupancy.js) et applique le résultat dans une
// transaction, car entre ce calcul et l'écriture une place peut disparaître.
// ─────────────────────────────────────────────────────────────────────────────

// Un profil accepte un occupant de plus si sa propre capacité n'est pas
// atteinte ET si le compte n'a pas épuisé ses flux simultanés. Les deux
// conditions sont distinctes : la première se règle en ajoutant un profil, la
// seconde en achetant un compte. On les remonte donc séparément.
function aDeLaPlace(candidat) {
  return candidat.occupantsActifs < candidat.capacite;
}

function compteADuFlux(candidat) {
  return candidat.compte.occupantsActifs < candidat.compte.maxFluxSimultanes;
}

function margeDeFlux(candidat) {
  return candidat.compte.maxFluxSimultanes - candidat.compte.occupantsActifs;
}

function choisirProfil(candidats) {
  if (!candidats || candidats.length === 0) {
    return { profil: null, raison: "aucun-profil" };
  }

  const avecPlace = candidats.filter(aDeLaPlace);
  if (avecPlace.length === 0) {
    return { profil: null, raison: "profils-pleins" };
  }

  const eligibles = avecPlace.filter(compteADuFlux);
  if (eligibles.length === 0) {
    return { profil: null, raison: "plafond-flux" };
  }

  // On étale plutôt qu'on entasse : quatre clients répartis sur quatre comptes
  // ne se coupent jamais la vidéo, les mêmes quatre sur un seul compte si.
  // Départages successifs pour que le choix reste déterministe — deux
  // attributions identiques doivent donner le même profil.
  const trie = [...eligibles].sort(
    (a, b) =>
      margeDeFlux(b) - margeDeFlux(a) ||
      a.occupantsActifs - b.occupantsActifs ||
      new Date(a.createdAt) - new Date(b.createdAt),
  );

  return { profil: trie[0], raison: "place-libre" };
}

module.exports = { choisirProfil };
