// Expiration des abonnements : calculs de date, puis vérification périodique.
//
// La première moitié du fichier (jusqu'à `expireDemain`) est faite de
// fonctions pures, sans accès base : c'est ce qui permet de les tester et
// d'éviter que la règle « la veille » ne dépende du moment où le serveur
// redémarre.
//
// La seconde moitié (`envoyerRappelsDus`, `demarrerRappels`) touche la base et
// les services d'e-mail et WhatsApp. Ses dépendances sont volontairement requises à
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
const INTERVALLE_NETTOYAGE_HISTORIQUE_MS = 15 * 60 * 1000;

// Supprime les lignes de réserve attribuées aux abonnements arrivés à échéance.
// La commande et la ligne client restent intactes : seule l'entrée de l'historique
// du lien est retirée. Les liens à vie ou sans date n'entrent pas dans ce filtre.
async function nettoyerHistoriqueLiensExpires(now = new Date()) {
  const prisma = require("../src/services/prisma");
  const commandesExpirees = await prisma.subscriptionOrder.findMany({
    where: {
      status: "CONFIRMED",
      expiresAt: { not: null, lte: now },
    },
    select: { id: true },
  });
  const ids = commandesExpirees.map((commande) => commande.id);
  if (ids.length === 0) return { commandes: 0, clientsSupprimes: 0, liensSupprimes: 0 };

  // Une commande possède une fiche dans « Clients ayant payé ». La supprimer
  // à son échéance retire aussi ses coordonnées du panneau. Les commandes et
  // paiements restent conservés pour l'historique comptable.
  const clients = await prisma.linkAccessClient.deleteMany({
    where: { subscriptionOrderId: { in: ids } },
  });
  // Les liens rangés sous un compte restent en place : ils redeviennent
  // disponibles pour un prochain abonné quand la période payée se termine.
  const liensReliberes = await prisma.linkAccessLink.updateMany({
    where: {
      accountId: { not: null },
      status: "envoyé",
      currentOrderId: { in: ids },
    },
    data: { status: "disponible", currentOrderId: null, claimedAt: null },
  });
  // Les anciennes lignes sans compte restent des liens à usage unique et leur
  // historique est effacé à l'expiration comme avant.
  const liensSupprimes = await prisma.linkAccessLink.deleteMany({
    where: {
      accountId: null,
      status: "envoyé",
      currentOrderId: { in: ids },
    },
  });
  return {
    commandes: ids.length,
    clientsSupprimes: clients.count,
    liensSupprimes: liensSupprimes.count,
    liensReliberes: liensReliberes.count,
  };
}

// Sélectionne les abonnements à prévenir et envoie le rappel.
//
// Les quatre conditions sont cumulatives, et l'horodatage final rend
// l'opération rejouable : un redémarrage en pleine exécution ne produit aucun
// doublon, et la fonction peut être appelée aussi souvent qu'on veut.
async function envoyerRappelsDus(now = new Date()) {
  const prisma = require("../src/services/prisma");
  const logger = require("../src/utils/logger");
  const { sendSubscriptionExpiryReminder } = require("../src/services/email");
  const whatsapp = require("../src/services/whatsapp");

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
      OR: [
        { reminderSentAt: null, clientEmail: { not: null } },
        {
          reminderWhatsappSentAt: null,
          clientWhatsapp: { not: null },
        },
      ],
      expiresAt: { not: null, gte: debut, lte: fin },
    },
    include: { service: true, plan: true },
  });

  let envoyes = 0;
  let emailsEnvoyes = 0;
  let whatsappEnvoyes = 0;
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

      const rappel = {
        clientName: o.clientName,
        serviceName: o.service?.name || "votre service",
        planLabel: o.plan?.label || "",
        expiresAt: o.expiresAt,
        serviceSlug: o.service?.slug,
      };

      // Chaque canal a son propre horodatage : un échec WhatsApp peut être
      // retenté sans renvoyer l'e-mail déjà livré, et inversement.
      const envoyerCanal = async (champ, envoyer) => {
        const revendication = await prisma.subscriptionOrder.updateMany({
          where: { id: o.id, [champ]: null },
          data: { [champ]: new Date() },
        });
        if (revendication.count !== 1) return false;

        let ok = false;
        try {
          ok = await envoyer();
        } catch (errEnvoi) {
          logger.error(`Échec du rappel d'expiration (${champ})`, {
            subOrderId: o.id,
            err: errEnvoi.message,
          });
        }
        if (ok) return true;

        // Libère uniquement le canal qui a échoué pour réessayer au prochain
        // passage, sans toucher à l'autre canal.
        try {
          await prisma.subscriptionOrder.update({
            where: { id: o.id },
            data: { [champ]: null },
          });
          logger.warn(`Rappel d'expiration non envoyé (${champ}) — sera retenté`, {
            subOrderId: o.id,
          });
        } catch (errLibere) {
          logger.error(`Échec de libération du rappel (${champ})`, {
            subOrderId: o.id,
            err: errLibere.message,
          });
        }
        return false;
      };

      let rappelEnvoye = false;
      if (o.clientEmail && !o.reminderSentAt) {
        const ok = await envoyerCanal("reminderSentAt", () =>
          sendSubscriptionExpiryReminder({
            clientEmail: o.clientEmail,
            ...rappel,
          }),
        );
        if (ok) {
          emailsEnvoyes++;
          rappelEnvoye = true;
        }
      }

      if (o.clientWhatsapp && !o.reminderWhatsappSentAt) {
        const ok = await envoyerCanal("reminderWhatsappSentAt", () =>
          whatsapp.sendSubscriptionExpiryReminderWhatsapp({
            clientWhatsapp: o.clientWhatsapp,
            ...rappel,
          }),
        );
        if (ok) {
          whatsappEnvoyes++;
          rappelEnvoye = true;
        }
      }

      if (rappelEnvoye) envoyes++;
      else ignores++;
    } catch (err) {
      logger.error("Erreur traitement rappel d'expiration — passage au suivant", {
        subOrderId: o.id,
        err: err.message,
      });
    }
  }

  if (envoyes > 0 || candidats.length > 0) {
    logger.info(
      `Rappels d'expiration : ${emailsEnvoyes} e-mail(s), ${whatsappEnvoyes} WhatsApp sur ${candidats.length} candidat(s)`,
    );
  }
  return {
    examines: candidats.length,
    envoyes,
    emailsEnvoyes,
    whatsappEnvoyes,
    ignores,
  };
}

function demarrerRappels() {
  const logger = require("../src/utils/logger");
  const passer = () =>
    envoyerRappelsDus().catch((err) =>
      logger.error("Vérification des rappels d'expiration échouée", { err: err.message }),
    );
  const nettoyer = () =>
    nettoyerHistoriqueLiensExpires()
      .then(({ clientsSupprimes, liensSupprimes }) => {
        if (clientsSupprimes > 0 || liensSupprimes > 0) {
          logger.info(
            `Abonnements expirés nettoyés : ${clientsSupprimes} fiche(s) client et ${liensSupprimes} lien(s) d'historique supprimé(s)`,
          );
        }
      })
      .catch((err) =>
        logger.error("Nettoyage de l'historique des liens expirés échoué", { err: err.message }),
      );
  passer();
  nettoyer();
  setInterval(passer, INTERVALLE_MS);
  setInterval(nettoyer, INTERVALLE_NETTOYAGE_HISTORIQUE_MS);
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
  nettoyerHistoriqueLiensExpires,
  demarrerRappels,
};
