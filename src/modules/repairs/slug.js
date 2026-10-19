const crypto = require("crypto");

// Slugs du catalogue de réparation.
//
// Fonctions pures, sans base : l'appelant fournit les slugs déjà pris, elles
// décident. C'est ce qui les rend testables sans PostgreSQL, comme
// `administration.js` et `duree.js`.

// « iPhone 15 Pro » → « iphone-15-pro ».
//
// Un nom sans aucun caractère latin exploitable (« ★★★ ») donnerait une chaîne
// vide. Or le slug est unique en base : deux vides entreraient en collision, et
// l'administrateur recevrait une erreur d'unicité illisible. On retombe donc
// sur un identifiant tiré au sort, laid mais valide et modifiable ensuite.
function slugifier(texte) {
  const base = String(texte || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (base) return base;
  return `modele-${crypto.randomBytes(4).toString("hex")}`;
}

// Le premier slug libre à partir de `base`.
//
// `prisExistants` est la liste des slugs déjà en base pour ce niveau. On
// suffixe (`-2`, `-3`…) plutôt que de laisser PostgreSQL rejeter l'écriture :
// deux marques vendent légitimement un « A15 », et ce n'est pas à
// l'administrateur de trouver un nom qui ne heurte personne.
function slugDisponible(base, prisExistants) {
  const pris = new Set(prisExistants || []);
  if (!pris.has(base)) return base;

  let n = 2;
  while (pris.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

module.exports = { slugifier, slugDisponible };
