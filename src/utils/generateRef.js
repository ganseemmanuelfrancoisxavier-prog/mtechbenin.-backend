const crypto = require("crypto");

// Alphabet sans I, O, 0 ni 1 : la référence est lue à voix haute au téléphone
// et recopiée à la main dans la page de suivi. Les caractères qui se
// confondent coûtent des appels au service client.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LONGUEUR = 8;

// Référence de commande.
//
// L'ancienne version tirait 5 chiffres avec `Math.random()`, et c'est le
// NAVIGATEUR qui la fabriquait — le serveur enregistrait telle quelle celle
// qu'on lui envoyait. Deux problèmes :
//
//   • Collisions. 90 000 valeurs possibles, et le champ est `@unique` : la
//     création échouait avec un 500 opaque dès qu'un tirage retombait sur une
//     référence existante. À 500 commandes, la probabilité qu'au moins deux
//     entrent en collision dépasse 75 %.
//   • Énumération. `GET /api/orders/:ref` est public et renvoie le nom, le
//     téléphone, l'e-mail et les coordonnées GPS de livraison du client.
//     Parcourir 90 000 valeurs est à la portée de n'importe qui.
//
// 32^8 ≈ 1,1×10¹² valeurs tirées d'une source cryptographique : la référence
// redevient un secret, et la collision cesse d'être un sujet.
function generateOrderRef(annee = new Date().getFullYear()) {
  const octets = crypto.randomBytes(LONGUEUR);
  let suffixe = "";
  for (let i = 0; i < LONGUEUR; i++) {
    suffixe += ALPHABET[octets[i] % ALPHABET.length];
  }
  return `MTECH-${annee}-${suffixe}`;
}

// Référence de réparation.
//
// Même alphabet et même longueur que les commandes produit, pour les mêmes
// raisons : elle est lue au téléphone, recopiée à la main dans la page de
// suivi, et cette page est publique — 32^8 valeurs tirées d'une source
// cryptographique la rendent inénumérable.
//
// Seul le préfixe change. Il porte l'information dans le webhook, dans les
// journaux et dans les messages : « REP-… » ne peut pas être confondu avec la
// commande produit « MTECH-… ».
function generateRepairRef(annee = new Date().getFullYear()) {
  const octets = crypto.randomBytes(LONGUEUR);
  let suffixe = "";
  for (let i = 0; i < LONGUEUR; i++) {
    suffixe += ALPHABET[octets[i] % ALPHABET.length];
  }
  return `REP-${annee}-${suffixe}`;
}

function generateReceiptNumber() {
  const date   = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const octets = crypto.randomBytes(4);
  let suffixe = "";
  for (let i = 0; i < 4; i++) {
    suffixe += ALPHABET[octets[i] % ALPHABET.length];
  }
  return `REC-${date}-${suffixe}`;
}

module.exports = { generateOrderRef, generateReceiptNumber, generateRepairRef, ALPHABET, LONGUEUR };
