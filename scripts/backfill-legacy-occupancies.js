// Répare uniquement les occupations encore représentées par l'ancien champ
// FamilyAccount.currentOrderId. Contrairement à la migration historique, ce
// rattrapage ne crée pas de comptes et ne déplace jamais un profil déjà lié.
// Il s'exécute au démarrage après les migrations de schéma.
const prisma = require("../src/services/prisma");
const logger = require("../src/utils/logger");

function normaliserEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function main() {
  const maintenant = new Date();
  const profils = await prisma.familyAccount.findMany({
    where: { currentOrderId: { not: null }, status: "envoyé" },
    include: {
      plan: { select: { serviceId: true } },
      account: { select: { id: true, email: true, serviceId: true } },
    },
  });

  let creees = 0;
  let rattaches = 0;
  let ignorees = 0;

  for (const profil of profils) {
    const commande = await prisma.subscriptionOrder.findUnique({
      where: { id: profil.currentOrderId },
      include: { plan: { select: { aVie: true } } },
    });

    // La fiche historique doit pointer vers un achat confirmé, sur le même
    // service et la même formule. Une formule sans échéance est active à vie;
    // pour les autres, seule une date d'expiration future peut être restaurée.
    if (
      !commande ||
      commande.status !== "CONFIRMED" ||
      !profil.plan?.serviceId ||
      profil.plan.serviceId !== commande.serviceId ||
      profil.planId !== commande.planId ||
      (!commande.plan?.aVie && (!commande.expiresAt || commande.expiresAt <= maintenant))
    ) {
      ignorees += 1;
      continue;
    }

    let compte = profil.account;
    if (compte) {
      // Un profil déjà lié à un autre compte n'est jamais déplacé par ce
      // rattrapage. Son adresse doit aussi désigner le compte qui l'alimente.
      if (
        compte.serviceId !== commande.serviceId ||
        normaliserEmail(compte.email) !== normaliserEmail(profil.email)
      ) {
        ignorees += 1;
        continue;
      }
    } else {
      // Pour les anciennes fiches non encore migrées, ne rattacher que si une
      // adresse correspond à un seul compte existant du service.
      const comptes = await prisma.streamingAccount.findMany({
        where: { serviceId: commande.serviceId },
        select: { id: true, email: true, serviceId: true },
      });
      const correspondants = comptes.filter(
        (c) => normaliserEmail(c.email) === normaliserEmail(profil.email),
      );
      if (correspondants.length !== 1) {
        ignorees += 1;
        continue;
      }
      compte = correspondants[0];
      await prisma.familyAccount.update({
        where: { id: profil.id },
        data: { accountId: compte.id },
      });
      rattaches += 1;
    }

    const existante = await prisma.profileOccupancy.findFirst({
      where: { orderId: commande.id },
      select: { id: true },
    });
    if (existante) continue;

    const cadeau = Boolean(commande.isGift && commande.giftWhatsapp);
    try {
      await prisma.profileOccupancy.create({
        data: {
          profileId: profil.id,
          orderId: commande.id,
          occupantName: cadeau ? commande.giftName || commande.clientName : commande.clientName,
          occupantWhatsapp: cadeau ? commande.giftWhatsapp : commande.clientWhatsapp,
          startedAt: commande.createdAt,
          endsAt: commande.expiresAt,
        },
      });
      creees += 1;
    } catch (err) {
      // Un démarrage concurrent peut avoir inséré la même occupation entre
      // findFirst et create; la contrainte de la base empêche le doublon.
      logger.warn("Reprise d'occupation ignorée", { err: err.message });
    }
  }

  logger.info("Reprise ciblée des occupations terminée", { creees, rattaches, ignorees });
}

main()
  .catch((err) => {
    // La reprise ne doit pas empêcher le backend de démarrer. L'erreur reste
    // visible dans le journal Render pour diagnostic.
    logger.error("Reprise ciblée des occupations échouée", { err: err.message });
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
