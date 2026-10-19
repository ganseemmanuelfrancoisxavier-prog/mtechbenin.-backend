// Durée d'une formule : est-elle à vie, et comment la nomme-t-on ?
//
// Deux fonctions pures, sans base ni Prisma, pour la même raison que
// `administration.js` : elles sont appelées depuis le contrôleur, depuis le
// réconciliateur et depuis le routage OTP, et chacun d'eux doit répondre la
// MÊME chose. Une formule à vie qu'un seul de ces trois endroits ne
// reconnaîtrait pas finirait par couper l'accès d'un client qui a payé pour
// ne jamais l'être.

// Cette formule est-elle sans échéance ?
//
// La question est posée sur un objet qui n'est pas toujours une formule
// complète : le réconciliateur et le routage OTP travaillent sur des `select`
// partiels, et une commande ancienne peut n'avoir aucune formule rattachée.
// Une absence n'est donc PAS « à vie » — c'est le cas par défaut, celui d'une
// formule mensuelle, et se tromper dans ce sens-là ne donne rien à personne
// gratuitement.
function estAVie(plan) {
  return plan?.aVie === true;
}

// Comment nommer cette durée à l'écran, ou dans un message WhatsApp.
//
// Écrit une fois ici parce que la formulation était recopiée à quatre endroits
// (`${plan.label} — ${plan.duration} mois`). Ajouter « à vie » à chacun d'eux
// séparément garantissait d'en oublier un, et l'oubli aurait annoncé « 1 mois »
// à un client qui vient d'acheter un accès définitif.
//
// Une durée illisible (absente, nulle, non numérique) donne « durée inconnue »
// plutôt que « null mois » ou « NaN mois » : ces commandes existent — voir
// `moisAchetes`, qui refuse justement ces valeurs — et le message part quand
// même.
function libelleDuree(plan) {
  if (estAVie(plan)) return "À vie";

  const mois = Number(plan?.duration);
  if (!Number.isInteger(mois) || mois <= 0) return "durée inconnue";
  return `${mois} mois`;
}

// Combien de périodes le client peut-il acheter d'un coup ?
//
// Une formule à vie n'est achetable qu'en un seul exemplaire : « deux fois à
// vie » ne veut rien dire, et laisser passer un multiplicateur ferait payer
// double pour exactement le même accès. Le plafond de douze est celui qui
// existait déjà pour les formules mensuelles.
const PERIODES_MAX = 12;

function periodesAutorisees(plan) {
  return estAVie(plan) ? 1 : PERIODES_MAX;
}

// Normalise le couple (aVie, duration) venu du formulaire de formule.
//
// `undefined` signifie « le panel n'a pas envoye ce champ » — meme convention
// que `normaliserDescription` : on ne touche alors a rien. C'est ce qui permet
// au PATCH qui ne regle que la capacite de ne pas basculer une formule a vie
// en mensuelle au passage.
//
// Deux regles, et elles se lisent dans cet ordre :
//   1. `aVie` vrai impose `duration = 1`. La colonne est obligatoire, elle est
//      ignoree sur une formule a vie, et une valeur absurde y ferait afficher
//      « 0 mois » quelque part un jour — chez un client, pas ici.
//   2. sinon, une duree fournie doit etre un entier strictement positif. Rien
//      ne le verifiait : le panel envoyait `Number("")`, soit 0, et la formule
//      s'enregistrait. L'erreur ne se voyait qu'a l'ACHAT, ou `moisAchetes`
//      refusait la duree et la commande partait sans date d'expiration — donc
//      sans rappel, et sans que personne ne sache pourquoi.
function normaliserDuree({ aVie, duration }) {
  const champs = {};

  if (aVie !== undefined) {
    if (aVie === true || aVie === "true") champs.aVie = true;
    else if (aVie === false || aVie === "false") champs.aVie = false;
    else return { ok: false, erreur: "Champ « à vie » invalide" };
  }

  if (champs.aVie === true) {
    champs.duration = 1;
    return { ok: true, champs };
  }

  if (duration !== undefined) {
    const mois = Number(duration);
    if (!Number.isInteger(mois) || mois <= 0) {
      return { ok: false, erreur: "Durée invalide — indiquez un nombre de mois, ou cochez « à vie »" };
    }
    champs.duration = mois;
  }

  return { ok: true, champs };
}

module.exports = {
  estAVie,
  libelleDuree,
  periodesAutorisees,
  normaliserDuree,
  PERIODES_MAX,
};
