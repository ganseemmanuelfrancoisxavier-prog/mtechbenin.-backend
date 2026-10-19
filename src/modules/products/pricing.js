// Calcul du prix unitaire d'un produit selon les caractéristiques choisies.
//
// Fonction pure et sans accès base : c'est elle qui fait autorité pour la
// facturation, et elle est reprise telle quelle côté navigateur pour
// l'affichage. Toute divergence entre les deux se traduirait par une commande
// refusée au paiement, d'où l'isolement dans un module testé.
//
// `selected` traverse une frontière de confiance : il vient tel quel du
// navigateur du client. Toute forme inattendue (élément non-objet,
// caractéristique inconnue, valeur de supplément corrompue) doit se traduire
// par un refus explicite (`ok:false`) — jamais par une exception non gérée,
// et jamais par une valeur silencieusement ignorée qui sous-facturerait le
// client.

// Valeur inscrite par le formulaire quand une caractéristique facultative n'a
// pas été renseignée. Doit rester identique à celle de
// `mtechbenin-frontend/src/lib/variants.js`.
const VALEUR_NON_CHOISIE = "Non choisi";

function computeUnitPrice({ basePrice, variantTypes, selected }) {
  const base = Number(basePrice);
  if (!Number.isFinite(base)) {
    return { ok: false, erreur: "Prix de base invalide" };
  }

  // `variantTypes` absent (produit simple, sans caractéristique) est un cas
  // normal et vaut « aucune caractéristique ». En revanche, s'il est fourni
  // mais n'est pas un tableau, c'est un appelant qui a mal chargé les
  // caractéristiques du produit : on refuse plutôt que de retomber
  // silencieusement sur le prix de base d'une caractéristique obligatoire et
  // payante.
  let types;
  if (variantTypes === undefined) {
    types = [];
  } else if (!Array.isArray(variantTypes)) {
    return { ok: false, erreur: "Caractéristiques du produit invalides" };
  } else {
    types = variantTypes;
  }

  const choix = Array.isArray(selected) ? selected : [];

  let total = base;

  // Chaque entrée de `selected` doit être un objet exploitable et référencer
  // une caractéristique réellement proposée par le produit — y compris
  // lorsque sa valeur est VALEUR_NON_CHOISIE : une caractéristique que le
  // produit ne propose pas ne doit jamais apparaître dans les choix reçus,
  // qu'elle soit "remplie" ou "laissée vide".
  for (const c of choix) {
    if (!c || typeof c !== "object" || typeof c.typeName !== "string") {
      return { ok: false, erreur: "Choix invalide" };
    }
    if (!types.some((t) => t.name === c.typeName)) {
      return { ok: false, erreur: `Caractéristique inconnue : ${c.typeName}` };
    }
  }

  for (const type of types) {
    const choisi = choix.find((c) => c.typeName === type.name);
    const valeur =
      choisi && choisi.value !== VALEUR_NON_CHOISIE ? choisi.value : null;

    if (!valeur) {
      if (type.required) {
        return { ok: false, erreur: `Choix requis : ${type.name}` };
      }
      continue;
    }

    const option = (type.options || []).find((o) => o.value === valeur);
    if (!option) {
      return { ok: false, erreur: `Valeur indisponible : ${valeur}` };
    }

    // Un supplément corrompu (chaîne, NaN, Infinity, décimal) ne doit jamais
    // être avalé silencieusement en 0 : les montants sont des entiers XOF, et
    // une valeur invalide en base doit bloquer le calcul plutôt que
    // sous-facturer le client sans trace.
    const delta = option.priceDelta;
    if (
      typeof delta !== "number" ||
      !Number.isFinite(delta) ||
      !Number.isInteger(delta)
    ) {
      return { ok: false, erreur: `Supplément invalide pour : ${valeur}` };
    }
    total += delta;
  }

  if (!Number.isFinite(total)) {
    return { ok: false, erreur: "Le prix calculé est invalide" };
  }
  if (total < 0) {
    return { ok: false, erreur: "Le prix calculé est négatif" };
  }
  return { ok: true, unitPrice: total };
}

module.exports = { computeUnitPrice, VALEUR_NON_CHOISIE };
