// ─────────────────────────────────────────────────────────────────────────────
// Messages WhatsApp entrants — décisions pures.
//
// Aucune dépendance : ni Baileys, ni base, ni journal. Ce fichier ne contient
// que ce qui doit pouvoir être testé sans ouvrir de session — c'est-à-dire
// exactement les deux points où un message entrant peut être mal interprété :
// l'adresse de son expéditeur, et sa date.
// ─────────────────────────────────────────────────────────────────────────────

// ── Adressage : JID classique ou identifiant masqué (`@lid`) ─────────────────
//
// Baileys 7 peut livrer un message individuel sous DEUX formes selon le mode
// d'adressage négocié par le serveur WhatsApp :
//   • `remoteJid = "22997437551@s.whatsapp.net"` — le numéro est dans le JID ;
//   • `remoteJid = "123456789012345@lid"` — identifiant masqué : les chiffres
//     ne sont PAS un numéro de téléphone. Le vrai numéro, quand il est connu,
//     arrive dans `remoteJidAlt`.
//
// Confondre les deux est silencieux et coûteux : un LID fait plus de 8
// chiffres, donc `normaliserNumero` l'accepte, aucune occupation ne lui
// correspond, et le client s'entend répondre qu'il n'a aucun abonnement. Pire,
// la réponse repartirait vers `<chiffres du LID>@s.whatsapp.net`, une adresse
// qui n'existe pas — personne ne reçoit rien et rien ne l'explique.
//
// On rend donc DEUX valeurs distinctes, jamais interchangeables :
//   • `adresse` : le JID d'origine, à réutiliser TEL QUEL pour répondre. Il ne
//     doit jamais être reconstruit à partir de ses chiffres.
//   • `numero`  : la valeur à rapprocher des occupations enregistrées.
//
// Un `@lid` sans `remoteJidAlt` n'offre aucun numéro exploitable : on rend
// `null` plutôt que de deviner, et l'appelant se tait.
function extraireAdressage(key) {
  const remoteJid = key?.remoteJid;
  if (!remoteJid || typeof remoteJid !== "string") return null;

  if (!remoteJid.endsWith("@lid")) {
    return { adresse: remoteJid, numero: remoteJid, masque: false };
  }

  const alt = key?.remoteJidAlt;
  if (!alt || typeof alt !== "string") return null;

  return { adresse: remoteJid, numero: alt, masque: true };
}

// ── Horodatage : écarter les messages rejoués à la reconnexion ───────────────
//
// Cinq minutes. Le choix se justifie des deux côtés :
//   • trop serré (quelques secondes) jetterait des demandes légitimes :
//     l'horloge du serveur Render et celle de WhatsApp ne sont pas alignées au
//     millimètre, et un message peut attendre le temps d'un aller-retour
//     réseau avant d'être remis ;
//   • trop large laisserait passer ce qu'on veut précisément écarter. Une
//     déconnexion Baileys, un redémarrage Render ou un nouveau QR font rejouer
//     en `type: "notify"` tout l'arriéré à la reconnexion — un « CODE » vieux
//     de deux jours ouvrirait alors une fenêtre de 15 minutes MAINTENANT, sur
//     un compte partagé, et capterait le code d'un autre occupant. C'est
//     exactement ce que la fenêtre existe pour empêcher.
// Cinq minutes couvrent largement la dérive d'horloge et les micro-coupures,
// tout en restant en deçà de la fenêtre de 15 minutes qu'un message accepté
// ouvrirait.
const TOLERANCE_ARRIERE_MS = 5 * 60 * 1000;

// `messageTimestamp` arrive tantôt en nombre de secondes, tantôt en `Long`
// protobuf (`{ low, high }` ou porteur d'un `toNumber()`), tantôt en chaîne,
// tantôt pas du tout. Rendre `null` sur ce qu'on ne sait pas lire est
// volontaire : un message sans horodatage lisible ne doit pas être jeté.
function horodatageMs(brut) {
  if (brut === null || brut === undefined) return null;

  let secondes = null;
  if (typeof brut === "number") secondes = brut;
  else if (typeof brut === "bigint") secondes = Number(brut);
  else if (typeof brut === "string") secondes = Number(brut);
  else if (typeof brut.toNumber === "function") {
    try {
      secondes = brut.toNumber();
    } catch {
      return null;
    }
  } else if (typeof brut.low === "number") {
    secondes = brut.low + (Number(brut.high) || 0) * 4294967296;
  }

  if (secondes === null || !Number.isFinite(secondes) || secondes <= 0) return null;
  return secondes * 1000;
}

function messageTropAncien(brut, maintenant = Date.now(), tolerance = TOLERANCE_ARRIERE_MS) {
  const ms = horodatageMs(brut);
  if (ms === null) return false; // horodatage illisible : on ne jette pas.
  return maintenant - ms > tolerance;
}

module.exports = {
  extraireAdressage,
  horodatageMs,
  messageTropAncien,
  TOLERANCE_ARRIERE_MS,
};
