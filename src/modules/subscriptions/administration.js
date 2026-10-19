const { DECALAGE_BENIN_H } = require("../../../workers/subscriptionExpiry");

// Gardes de l'administration manuelle : placer un client dans un profil, et
// supprimer une ligne qui a peut-être de l'histoire derrière elle.
//
// Fonctions pures, sans base ni Prisma : l'appelant compte, elles décident.
// C'est ce qui les rend testables — et ce qui permet de les appeler DEPUIS une
// transaction, avec des compteurs relus sous verrou, sans qu'elles aient à
// connaître la transaction.

// Un nombre exploitable pour une comparaison de plafond.
//
// `NaN >= x` vaut toujours faux : une valeur illisible traverserait donc
// silencieusement toutes les gardes ci-dessous, et le profil dépasserait sa
// capacité sans que rien ne le signale. Le même défaut a déjà été corrigé
// dans `modifierProfil` — on le refuse ici plutôt que de le subir.
function estNombre(valeur) {
  return typeof valeur === "number" && Number.isFinite(valeur);
}

// Ce placement tient-il dans les DEUX plafonds : la capacité du profil et le
// nombre de flux simultanés du compte ?
//
// Les deux comptent, et pour des raisons différentes : la capacité est notre
// règle commerciale (combien de clients on accepte de mettre sur un profil),
// le plafond de flux est celle du fournisseur (au-delà, les clients se
// coupent mutuellement la lecture). Dépasser le premier se rattrape ; dépasser
// le second se voit chez le client.
// `fluxMax: null` signifie « aucun plafond de flux » — le cas d'un profil
// hérité qui n'est rattaché à aucun compte streaming, et pour lequel il n'y a
// donc rien à plafonner. C'est une absence DÉCLARÉE, distincte d'une valeur
// illisible : `undefined`, `NaN` ou une chaîne restent refusés.
function verifierPlacement({ capacite, occupantsActifs, fluxMax, fluxActifs }) {
  const sansPlafondFlux = fluxMax === null;

  if (
    !estNombre(capacite) ||
    !estNombre(occupantsActifs) ||
    (!sansPlafondFlux && !estNombre(fluxMax)) ||
    !estNombre(fluxActifs)
  ) {
    return {
      ok: false,
      refus: "donnees-illisibles",
      message: "Capacité ou plafond de flux illisible — placement refusé.",
    };
  }

  // Le profil d'abord : c'est le seul des deux plafonds que l'admin peut
  // contourner immédiatement, en choisissant un autre profil du même compte.
  if (occupantsActifs >= capacite) {
    return {
      ok: false,
      refus: "profil-plein",
      message: `Ce profil est complet (${occupantsActifs}/${capacite} places occupées).`,
    };
  }

  if (!sansPlafondFlux && fluxActifs >= fluxMax) {
    return {
      ok: false,
      refus: "plafond-flux",
      message:
        `Ce compte atteint son plafond de ${fluxMax} flux simultanés ` +
        `(${fluxActifs} places déjà occupées, tous profils confondus).`,
    };
  }

  return { ok: true };
}

// Cette ligne peut-elle être supprimée, au vu de ce qui la référence ?
//
// `obstacles` : `[{ nombre, singulier, pluriel }]`. Ceux à zéro sont ignorés.
//
// Le message nomme TOUT ce qui bloque, pas seulement le premier obstacle :
// sinon l'admin corrige, réessaie, découvre le suivant, et recommence autant
// de fois qu'il y a de tables pointant sur la ligne.
function verifierSuppression(obstacles) {
  const bloquants = (obstacles || []).filter((o) => o && o.nombre > 0);
  if (bloquants.length === 0) return { ok: true };

  const parties = bloquants.map(
    (o) => `${o.nombre} ${o.nombre === 1 ? o.singulier : o.pluriel}`,
  );

  return {
    ok: false,
    message:
      `Suppression impossible : ${parties.join(", ")} en dépendent. ` +
      `L'historique des clients est conservé.`,
  };
}

// Normalise la date de fin d'une occupation.
//
// Le panel n'offre qu'un `<input type="date">`, qui rend « AAAA-MM-JJ ». Passé
// tel quel à `new Date()`, ce jour devient MINUIT UTC — soit 1 h du matin à
// Cotonou. Une occupation réglée « jusqu'au 30 septembre » s'éteignait donc au
// tout début du 30, et le client perdait sa dernière journée.
//
// Pire pour une occupation née d'un paiement : `dateExpiration` y inscrit
// l'heure de l'achat. Rouvrir le formulaire et enregistrer sans rien changer
// aurait ramené cette heure à minuit — amputant l'accès sans que personne ne
// touche à la date.
//
// Un jour seul signifie donc « toute cette journée, heure du Bénin ». Un
// horodatage complet, lui, vient d'un appel API et passe intact.
const FIN_DE_JOURNEE_UTC_MS =
  (24 - DECALAGE_BENIN_H) * 3600 * 1000 - 1;

function normaliserDateFin(valeur) {
  if (valeur === null || valeur === undefined || valeur === "") {
    return { ok: true, date: null };
  }

  if (typeof valeur === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valeur)) {
    const minuitUTC = new Date(`${valeur}T00:00:00.000Z`);
    if (Number.isNaN(minuitUTC.getTime())) return { ok: false };
    return { ok: true, date: new Date(minuitUTC.getTime() + FIN_DE_JOURNEE_UTC_MS) };
  }

  const date = valeur instanceof Date ? valeur : new Date(valeur);
  // `new Date({})` donne une Invalid Date que Prisma accepte parfois
  // d'écrire — le client verrait alors « Invalid Date », ou une occupation
  // qui n'expire jamais.
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, date };
}

// L'administrateur demande-t-il une suppression FORCÉE ?
//
// `verifierSuppression` protège contre l'oubli — supprimer une formule sans
// voir qu'un client était derrière. Elle ne doit pas protéger contre la
// volonté : une formule créée par erreur puis vendue une seule fois restait
// indéboulonnable, et le panel n'offrait aucun autre chemin que la base.
// Le forçage est donc un second geste, explicite, jamais le comportement par
// défaut : sans ce drapeau, le refus tient.
//
// Lu dans la query (`?force=1`) ET dans le corps : un DELETE porte rarement un
// corps, mais les deux clients existent et l'oubli d'un des deux se traduirait
// par un bouton « Supprimer quand même » silencieusement sans effet.
function forceDemandee(req) {
  const valeur = req?.query?.force ?? req?.body?.force;
  return valeur === true || valeur === "1" || valeur === "true";
}

// Ce qu'une suppression forcée a emporté, en une incise à coller au message.
//
// `bilan` : `{ cle: nombre }` ; `libelles` : `{ cle: [singulier, pluriel] }`.
// Les zéros sont tus — annoncer « 0 occupation » à un admin qui vient d'effacer
// une formule vide ne l'informe de rien et fait douter du reste.
// Rend `""` quand rien n'a été emporté : l'appelant concatène sans condition.
//
// Une forcée détruit de l'historique client. Le compte rendu est donc la seule
// trace que l'admin en garde à l'écran, et il doit être exact : c'est lui qui
// lui dit combien de personnes viennent de perdre leur accès.
function resumeSuppression(bilan, libelles) {
  const parties = Object.entries(libelles)
    .filter(([cle]) => (bilan?.[cle] || 0) > 0)
    .map(([cle, [singulier, pluriel]]) => {
      const n = bilan[cle];
      return `${n} ${n === 1 ? singulier : pluriel}`;
    });

  if (parties.length === 0) return "";
  return ` (emporté : ${parties.join(", ")})`;
}

// ── Client hors site ─────────────────────────────────────────────────────────
//
// Refonte OTP du 13/10/2026. Des clients detenaient les identifiants du compte
// Netflix B sans avoir jamais commande sur le site : invisibles pour le bot,
// qui envoyait donc tous les codes de ce compte au seul client enregistre. Le
// panel les enregistre desormais sur leur profil ; la saisie est validee ici.
//
// Le numero WhatsApp est le champ critique : c'est lui qui decide a qui part
// le code. Un numero illisible enverrait les codes dans le vide.
function validerClientHorsSite(saisie = {}, { aVie = false, maintenant = new Date() } = {}) {
  const nom = String(saisie.nom ?? "").trim().replace(/\s+/g, " ");
  if (nom.length < 2 || nom.length > 80) {
    return { ok: false, message: "Nom du client requis (2 à 80 caractères)." };
  }

  const brut = String(saisie.whatsapp ?? "").trim();
  const chiffres = brut.replace(/[\s().-]/g, "");
  if (!/^\+?\d{8,15}$/.test(chiffres)) {
    return { ok: false, message: "Numéro WhatsApp illisible : 8 à 15 chiffres, indicatif compris." };
  }

  const emailBrut = String(saisie.email ?? "").trim().toLowerCase();
  if (emailBrut && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailBrut)) {
    return { ok: false, message: "Adresse e-mail mal formée." };
  }

  let montant = 0;
  if (saisie.montant !== undefined && saisie.montant !== null && saisie.montant !== "") {
    montant = Number(saisie.montant);
    if (!Number.isInteger(montant) || montant < 0) {
      return { ok: false, message: "Montant : un entier positif en FCFA." };
    }
  }

  let finLe = null;
  if (!aVie) {
    const fin = normaliserDateFin(saisie.finLe);
    if (!fin.ok || !fin.date) {
      return { ok: false, message: "Date de fin d'abonnement requise." };
    }
    if (fin.date.getTime() <= maintenant.getTime()) {
      return { ok: false, message: "La date de fin doit être dans le futur." };
    }
    finLe = fin.date;
  }

  return { ok: true, valeurs: { nom, whatsapp: chiffres, email: emailBrut || null, montant, finLe } };
}

module.exports = {
  validerClientHorsSite,
  verifierPlacement,
  verifierSuppression,
  normaliserDateFin,
  forceDemandee,
  resumeSuppression,
};
