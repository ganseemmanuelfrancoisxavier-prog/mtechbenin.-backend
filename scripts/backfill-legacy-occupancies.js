// Répare uniquement les occupations encore représentées par l'ancien champ
// FamilyAccount.currentOrderId. Ce rattrapage ne crée pas de comptes et ne
// déplace jamais un profil déjà lié.
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

  const stats = {
    examinees: profils.length,
    creees: 0,
    rattaches: 0,
    ignorees: {},
  };
  const ignorer = (raison) => {
    stats.ignorees[raison] = (stats.ignorees[raison] || 0) + 1;
  };

  for (const profil of profils) {
    const commande = await prisma.subscriptionOrder.findUnique({
      where: { id: profil.currentOrderId },
      include: { plan: { select: { aVie: true } } },
    });

    if (!commande) {
      ignorer("commande_introuvable");
      continue;
    }
    if (commande.status !== "CONFIRMED") {
      ignorer("commande_non_confirmee");
      continue;
    }
    if (!profil.plan?.serviceId || profil.plan.serviceId !== commande.serviceId) {
      ignorer("service_different");
      continue;
    }
    if (profil.planId !== commande.planId) {
      ignorer("formule_differente");
      continue;
    }
    if (!commande.plan?.aVie && (!commande.expiresAt || commande.expiresAt <= maintenant)) {
      ignorer("abonnement_expire_ou_sans_echeance");
      continue;
    }

    let compte = profil.account;
    if (compte) {
      if (
        compte.serviceId !== commande.serviceId ||
        normaliserEmail(compte.email) !== normaliserEmail(profil.email)
      ) {
        ignorer("compte_existant_incoherent");
        continue;
      }
    } else {
      const comptes = await prisma.streamingAccount.findMany({
        where: { serviceId: commande.serviceId },
        select: { id: true, email: true, serviceId: true },
      });
      const correspondants = comptes.filter(
        (c) => normaliserEmail(c.email) === normaliserEmail(profil.email),
      );
      if (correspondants.length === 0) {
        ignorer("aucun_compte_email_correspondant");
        continue;
      }
      if (correspondants.length !== 1) {
        ignorer("plusieurs_comptes_email_correspondants");
        continue;
      }
      compte = correspondants[0];
      await prisma.familyAccount.update({
        where: { id: profil.id },
        data: { accountId: compte.id },
      });
      stats.rattaches += 1;
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
      stats.creees += 1;
    } catch (err) {
      ignorer("conflit_creation");
      logger.warn("Reprise d'occupation ignorée", { err: err.message });
    }
  }

  logger.info("Reprise ciblée des occupations terminée", stats);
}

main()
  .catch((err) => {
    logger.error("Reprise ciblée des occupations échouée", { err: err.message });
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
