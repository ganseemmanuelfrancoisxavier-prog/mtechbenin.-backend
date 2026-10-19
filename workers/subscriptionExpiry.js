// Expiration des abonnements : calculs de date, puis vérification périodique.
//
// La première moitié du fichier (jusqu'à `expireDemain`) est faite de
// fonctions pures, sans accès base : c'est ce qui permet de les tester et
// d'éviter que la règle « la veille » ne dépende du moment où le serveur
// redémarre.
//
// La seconde moitié (`envoyerRappelsDus`, `demarrerRappels`) touche la base et
// le service d'e-mails. Ses dépendances sont volontairement requises à
// l'intérieur des fonctions, et non en tête de fichier : c'est ce qui permet
// aux tests de charger le module et d'exercer les fonctions pures sans base de
// données ni clé Resend.

// Le Bénin est à UTC+1 toute l'année, sans changement d'heure. Un décalage
// fixe suffit donc, et évite de dépendre du fuseau du serveur — Render tourne
// en UTC.
const DECALAGE_BENIN_H = 1;
// Fenêtre d'envoi : entre 7 h locale incluse et 21 h locale EXCLUE.
// À 21 h 00 pile, on ne considère plus qu'on est « dans » la fenêtre — c'est
// la fin de journée, pas un dernier créneau.
const HEURE_MIN = 7;
const HEURE_MAX = 21;

// Convertit n'importe quelle entrée en Date sans jamais lever d'exception.
// Une entrée illisible (chaîne invalide, undefined, objet quelconque) donne
// une Invalid Date, jamais un throw — c'est ce qui permet aux fonctions
// publiques de rester insensibles à une donnée corrompue en base.
function versDate(valeur) {
  return valeur instanceof Date ? valeur : new Date(valeur);
}

function dateValide(valeur) {
  // null/undefined coderaient en date epoch (1970-01-01) via `new Date(...)`
  // et passeraient donc pour « valides » — on les exclut explicitement.
  if (valeur === null || valeur === undefined) return false;
  const d = versDate(valeur);
  return !Number.isNaN(d.getTime());
}

function maintenantBenin(now = new Date()) {
  const base = versDate(now);
  return new Date(base.getTime() + DECALAGE_BENIN_H * 3600 * 1000);
}

// Nombre de mois réellement achetés.
//
// On ne part pas du montant total de la commande : il inclut la quantité et
// d'éventuels frais, ce qui rend la durée indéterminable. On part du prix
// unitaire, dont le serveur a déjà vérifié qu'il vaut exactement le prix du
// plan multiplié par un entier.
function moisAchetes({ unitPrice, planPrice, planDuration }) {
  const prix = Number(planPrice);
  const paye = Number(unitPrice);
  // Absente, la durée vaut 1 mois par défaut. Fournie, elle doit être un
  // entier strictement positif : une durée négative ou nulle produirait une
  // date d'expiration antérieure à l'achat (jamais « demain », donc jamais
  // de rappel envoyé — un silence qu'on préfère refuser explicitement).
  const duree = planDuration === undefined || planDuration === null ? 1 : Number(planDuration);

  if (!Number.isFinite(prix) || prix <= 0) {
    return { ok: false, raison: "Prix du plan inconnu" };
  }
  if (!Number.isFinite(paye) || paye <= 0) {
    return { ok: false, raison: "Montant payé inconnu" };
  }
  if (!Number.isInteger(duree) || duree <= 0) {
    return { ok: false, raison: "Durée de plan invalide" };
  }

  const multiplicateur = paye / prix;
  if (!Number.isInteger(multiplicateur) || multiplicateur < 1 || multiplicateur > 12) {
    return { ok: false, raison: "Le montant ne correspond pas à un nombre entier de périodes" };
  }
  return { ok: true, mois: duree * multiplicateur };
}

// Ajoute des mois sans déborder sur le mois suivant : le 31 janvier plus un
// mois donne le 28 février, pas le 3 mars.
function dateExpiration({ debut, mois }) {
  const d = new Date(debut);
  const jour = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + mois);
  const dernierJour = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(jour, dernierJour));
  return d;
}

// Politique commune aux deux fonctions ci-dessous : une entrée illisible
// (chaîne invalide, Date invalide, valeur absente) donne un refus propre —
// jamais une exception. Une seule ligne corrompue en base ne doit jamais
// interrompre la boucle qui parcourt tous les abonnements : ce jour-là,
// aucun client ne recevrait son rappel, pas seulement celui dont la donnée
// est mauvaise.
function estDansLaFenetreDEnvoi(now = new Date()) {
  if (!dateValide(now)) return false;
  const h = maintenantBenin(now).getUTCHours();
  return h >= HEURE_MIN && h < HEURE_MAX;
}

// « Expire demain » se juge sur la date du calendrier local, pas sur un écart
// en heures : un abonnement qui expire demain à 2 h du matin doit être annoncé
// aujourd'hui, même s'il ne reste que seize heures.
function expireDemain(expiresAt, now = new Date()) {
  if (!dateValide(expiresAt) || !dateValide(now)) return false;
  const jour = (d) => maintenantBenin(versDate(d)).toISOString().slice(0, 10);
  const demain = new Date(maintenantBenin(now).getTime() + 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  return jour(expiresAt) === demain;
}

const INTERVALLE_MS = 6 * 3600 * 1000;

// Sélectionne les abonnements à prévenir et envoie le rappel.
//
// Les quatre conditions sont cumulatives, et l'horodatage final rend
// l'opération rejouable : un redémarrage en pleine exécution ne produit aucun
// doublon, et la fonction peut être appelée aussi souvent qu'on veut.
async function envoyerRappelsDus(now = new Date()) {
  const prisma = require("../src/services/prisma");
  const logger = require("../src/utils/logger");
  const { sendSubscriptionExpiryReminder } = require("../src/services/email");

  if (!estDansLaFenetreDEnvoi(now)) {
    return { examines: 0, envoyes: 0, ignores: 0, horsFenetre: true };
  }

  // La fenêtre large en base est volontairement grossière ; c'est
  // `expireDemain` qui tranche sur la date locale.
  const debut = new Date(now.getTime() - 24 * 3600 * 1000);
  const fin = new Date(now.getTime() + 72 * 3600 * 1000);

  const candidats = await prisma.subscriptionOrder.findMany({
    where: {
      status: "CONFIRMED",
      reminderSentAt: null,
      clientEmail: { not: null },
      expiresAt: { not: null, gte: debut, lte: fin },
    },
    include: { service: true, plan: true },
  });

  let envoyes = 0;
  let ignores = 0;

  for (const o of candidats) {
    // Une ligne corrompue (date illisible, relation manquante...) ne doit
    // jamais interrompre la boucle : les clients suivants doivent quand même
    // recevoir leur rappel.
    try {
      if (!expireDemain(o.expiresAt, now)) {
        ignores++;
        continue;
      }

      // On revendique la ligne AVANT d'envoyer, au lieu d'horodater après.
      // Avant ce correctif : envoi puis écriture. Si l'écriture échouait (le
      // pooler Supabase du plan gratuit rend régulièrement « Timed out
      // fetching a new connection from the connection pool ») ou si le
      // process redémarrait entre les deux, la ligne restait candidate et le
      // passage suivant (6 h plus tard) renvoyait le même e-mail. On passe
      // donc d'un « au moins une fois » (risque de doublon) à un « au plus
      // une fois » (risque de rappel manqué, mais tracé dans le journal).
      // Pour un message commercial, l'ennui d'un doublon est pire que celui
      // d'un rappel manqué signalé dans le journal.
      const revendication = await prisma.subscriptionOrder.updateMany({
        where: { id: o.id, reminderSentAt: null },
        data: { reminderSentAt: new Date() },
      });
      if (revendication.count !== 1) {
        // Déjà pris en charge ailleurs (autre passage, autre instance) : rien
        // à faire ici.
        continue;
      }

      const ok = await sendSubscriptionExpiryReminder({
        clientEmail: o.clientEmail,
        clientName: o.clientName,
        serviceName: o.service?.name || "votre service",
        planLabel: o.plan?.label || "",
        expiresAt: o.expiresAt,
        serviceSlug: o.service?.slug,
      });
      if (!ok) {
        // L'envoi a échoué : on relâche la revendication pour que le prochain
        // passage réessaie, tant que la date reste dans la fenêtre.
        try {
          await prisma.subscriptionOrder.update({
            where: { id: o.id },
            data: { reminderSentAt: null },
          });
          logger.warn("Rappel d'expiration non envoyé — revendication relâchée, sera retenté", {
            subOrderId: o.id,
          });
        } catch (errLibere) {
          // La remise à zéro elle-même a échoué : la ligne reste marquée
          // comme « rappel envoyé » sans qu'aucun e-mail soit parti. C'est le
          // moindre mal (un rappel manqué plutôt qu'un doublon), mais ça doit
          // rester visible dans le journal pour qu'un admin puisse rattraper
          // la situation manuellement.
          logger.error("Échec de la libération de la revendication après un envoi raté — ligne bloquée sans rappel envoyé", {
            subOrderId: o.id,
            err: errLibere.message,
          });
        }
        continue;
      }
      envoyes++;
    } catch (err) {
      logger.error("Erreur traitement rappel d'expiration — passage au suivant", {
        subOrderId: o.id,
        err: err.message,
      });
    }
  }

  if (envoyes > 0 || candidats.length > 0) {
    logger.info(`Rappels d'expiration : ${envoyes} envoyé(s) sur ${candidats.length} candidat(s)`);
  }
  return { examines: candidats.length, envoyes, ignores };
}

function demarrerRappels() {
  const logger = require("../src/utils/logger");
  const passer = () =>
    envoyerRappelsDus().catch((err) =>
      logger.error("Vérification des rappels d'expiration échouée", { err: err.message }),
    );
  passer();
  setInterval(passer, INTERVALLE_MS);
  logger.info("⏰ Rappels d'expiration actifs — vérification toutes les 6 h, envoi entre 7 h et 21 h");
}

module.exports = {
  moisAchetes,
  dateExpiration,
  maintenantBenin,
  estDansLaFenetreDEnvoi,
  expireDemain,
  DECALAGE_BENIN_H,
  HEURE_MIN,
  HEURE_MAX,
  envoyerRappelsDus,
  demarrerRappels,
};
