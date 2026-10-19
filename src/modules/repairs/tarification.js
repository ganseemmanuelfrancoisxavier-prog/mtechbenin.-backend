// Calcul du montant d'une réparation.
//
// Fonction pure, sans base : l'appelant a déjà lu les options en base et
// validé le coupon, elle calcule. C'est ce qui permet de la tester sans
// PostgreSQL et de garantir que le montant affiché, le montant enregistré et
// le montant envoyé à FedaPay sortent tous du MÊME calcul.
//
// Le navigateur n'envoie jamais de prix : il n'envoie que des identifiants
// d'options, et c'est ici que le montant naît. Sans cette règle on choisit son
// prix depuis la console — c'est exactement ce que `buildValidatedItems`
// empêche déjà côté panier.

function estEntierPositif(v) {
  return Number.isInteger(v) && v >= 0;
}

// `Coupon.value` est une colonne `Int` non nulle en base, mais ce calcul ne
// dépend pas de la validation qui l'a précédé. Une valeur illisible
// (`undefined`, `"abc"`, `NaN`) ou négative doit devenir « aucune remise »,
// jamais un `NaN` propagé jusqu'au paiement ni une remise qui gonfle le total
// au lieu de le réduire.
function valeurCouponValide(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function calculerReparation({ options, coupon = null, tauxFrais = 0 }) {
  const liste = Array.isArray(options) ? options : [];
  if (liste.length === 0) {
    return { ok: false, erreur: "Aucune réparation sélectionnée" };
  }

  for (const o of liste) {
    if (!estEntierPositif(o?.price)) {
      return { ok: false, erreur: `Prix illisible pour « ${o?.jobName || "?"} »` };
    }
  }

  const subtotal = liste.reduce((somme, o) => somme + o.price, 0);

  let discount = 0;
  if (coupon) {
    const plancher = Number(coupon.minOrder) || 0;
    if (subtotal < plancher) {
      return {
        ok: false,
        erreur: `Ce coupon demande un minimum de ${plancher} FCFA (total : ${subtotal} FCFA)`,
      };
    }
    // Arrondi UNE SEULE FOIS, ici. Arrondir plus tard ferait diverger d'un
    // franc le total affiché et celui envoyé au paiement.
    discount =
      coupon.type === "PERCENTAGE"
        ? Math.round((subtotal * valeurCouponValide(coupon.value)) / 100)
        : valeurCouponValide(coupon.value);
    // Une remise fixe supérieure au panier ne doit pas produire un total
    // négatif — ni un remboursement involontaire. `valeurCouponValide` a déjà
    // exclu les valeurs négatives, ce `Math.min` ne plafonne que par le haut :
    // la remise reste ainsi bornée à `[0, subtotal]`.
    discount = Math.min(discount, subtotal);
  }

  // ── Contrat de montant : MIROIR EXACT de `Order.total`, pas la même chose ──
  //
  // `Order.total` (parcours produit, orders.controller.js) INCLUT les frais de
  // service : `total = base + feeAmount`, et c'est cette somme qui doit être
  // affichée au client, pendant que FedaPay ne reçoit que `base`.
  //
  // Ici, `total` EXCLUT les frais de service : `total = subtotal - discount`,
  // `feeAmount` calculé PAR-DESSUS. Le montant que le client doit voir avant
  // de payer est donc `total + feeAmount` (pas `total` seul), et c'est
  // `creerCommandeReparation` qui documente ce contrat côté API.
  //
  // Cette divergence est délibérée pour le lot 1 (elle évite de toucher au
  // format déjà lu par le lot 2) mais DANGEREUSE pour qui la découvre en
  // copiant le parcours produit : y calquer un total « frais compris » sans
  // le savoir sous-facturerait les frais FedaPay deux fois (une fois en les
  // laissant dans `total`, une fois en les soustrayant à nouveau avant
  // l'envoi au paiement). Ne pas « corriger » silencieusement sans aligner
  // aussi `RepairOrder.total` en base et le contrat FedaPay du lot 2.
  const total = subtotal - discount;
  const feeAmount = Math.round(total * (Number(tauxFrais) || 0));

  const lignes = liste.map((o) => ({
    jobName: o.jobName,
    optionLabel: o.label,
    unitPrice: o.price,
    delay: o.delay ?? null,
    optionId: o.id ?? null,
    jobId: o.jobId ?? null,
    horsCatalogue: false,
  }));

  return { ok: true, subtotal, discount, feeAmount, total, lignes };
}

module.exports = { calculerReparation };
