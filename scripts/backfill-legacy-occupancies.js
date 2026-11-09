// Répare uniquement les occupations encore représentées par l'ancien champ
// FamilyAccount.currentOrderId. Aucun compte n'est créé : un profil est
// rattaché au compte existant unique dont les identifiants correspondent.
const prisma = require("../src/services/prisma");
const logger = require("../src/utils/logger");

function normaliserEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at === -1) return email;
  let local = email.slice(0, at);
  const domaine = email.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  if (domaine === "gmail.com" || domaine === "googlemail.com") {
    local = local.replace(/\\./g, "");
    return `${local}@gmail.com`;
  }
  return `${local}@${domaine}`;
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
    occupationsCreees: 0,
    rattachementsCorriges: 0,
    demandesRattachees: 0,
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

    const compteCorrect = correspondants[0];
    const occupation = await prisma.profileOccupancy.findFirst({
      where: { orderId: commande.id, releasedAt: null },
      select: { id: true, profileId: true },
    });
    if (occupation && occupation.profileId !== profil.id) {
      ignorer("occupation_sur_un_autre_profil");
      continue;
    }

    if (profil.accountId !== compteCorrect.id) {
      await prisma.familyAccount.update({
        where: { id: profil.id },
        data: { accountId: compteCorrect.id },
      });
      stats.rattachementsCorriges += 1;
    }

    const cadeau = Boolean(commande.isGift && commande.giftWhatsapp);
    const donneesOccupation = {
      occupantName: cadeau ? commande.giftName || commande.clientName : commande.clientName,
      occupantWhatsapp: cadeau ? commande.giftWhatsapp : commande.clientWhatsapp,
      startedAt: commande.createdAt,
      endsAt: commande.expiresAt,
    };

    if (occupation) {
      await prisma.profileOccupancy.update({
        where: { id: occupation.id },
        data: donneesOccupation,
      });
    } else {
      occupation = await prisma.profileOccupancy.create({
        data: {
          profileId: profil.id,
          orderId: commande.id,
          ...donneesOccupation,
        },
        select: { id: true, profileId: true },
      });
      stats.occupationsCreees += 1;
    }

    const demandes = await prisma.otpRequest.updateMany({
      where: {
        occupancyId: occupation.id,
        servedAt: null,
        expiresAt: { gt: maintenant },
        accountId: { not: compteCorrect.id },
      },
      data: { accountId: compteCorrect.id },
    });
    stats.demandesRattachees += demandes.count;
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
