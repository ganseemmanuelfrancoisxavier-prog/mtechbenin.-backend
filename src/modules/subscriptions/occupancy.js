const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");
const { choisirProfil } = require("./placement");

// Une occupation est active tant qu'elle n'a pas été libérée et que sa date de
// fin n'est pas franchie. Une occupation sans date de fin (commande dont
// l'expiration n'a jamais pu être déterminée) reste active : on ne coupe pas un
// client sur une date qu'on n'a pas.
function estActive(occupation, maintenant = new Date()) {
  if (occupation.releasedAt) return false;
  if (!occupation.endsAt) return true;
  return new Date(occupation.endsAt) > maintenant;
}

// Filtre SQL équivalent à `estActive`, pour ne pas rapatrier tout l'historique.
function filtreActive(maintenant = new Date()) {
  return {
    releasedAt: null,
    OR: [{ endsAt: null }, { endsAt: { gt: maintenant } }],
  };
}

// Remet a jour les colonnes heritees d'un profil depuis ses occupations.
//
// `currentOrderId` et `status` datent du modele « un profil = un client ». Le
// partage de profils les a remplacees par `ProfileOccupancy`, mais l'ancienne
// section du panel les lit encore — et un exploitant qui ouvre la base les lit
// aussi. Laissees en place sans etre ecrites, elles affichaient « disponible,
// aucun client » sur un profil pourtant occupe : deux sections du meme panel
// se contredisaient.
//
// Le calcul va TOUJOURS dans ce sens : l'occupation est la verite, ces deux
// colonnes n'en sont qu'un reflet. Jamais l'inverse.
async function synchroniserMiroirProfil(db, profileId, maintenant = new Date()) {
  const actives = await db.profileOccupancy.findMany({
    where: { profileId, ...filtreActive(maintenant) },
    orderBy: { startedAt: "desc" },
    select: { orderId: true },
  });
  await db.familyAccount.update({
    where: { id: profileId },
    data: {
      currentOrderId: actives[0]?.orderId ?? null,
      status: actives.length > 0 ? "envoyé" : "disponible",
    },
  });
}

async function occupationsActivesDuCompte(accountId, maintenant = new Date()) {
  return prisma.profileOccupancy.findMany({
    where: { profile: { accountId }, ...filtreActive(maintenant) },
    include: {
      // `email` sert l'invariant du routage OTP : un profil dont le mail
      // propre differe de celui de son compte donne a son occupant des
      // identifiants qu'aucune boite surveillee n'alimente. Sans ce champ,
      // `detientIdentifiantsDeLaBoite` ne peut rien verifier et laisse tout
      // passer (voir workers/otpRouting.js).
      profile: { select: { id: true, profile: true, capacite: true, email: true } },
      order: {
        select: {
          id: true, clientName: true, clientWhatsapp: true, clientEmail: true,
          isGift: true, giftName: true, giftWhatsapp: true, expiresAt: true,
          // Sert à désigner le dernier acheteur quand un compte partagé n'a
          // aucune demande ouverte (`dernierAcheteur`, workers/otpRouting.js).
          createdAt: true,
          service: { select: { name: true, slug: true, category: true } },
        },
      },
    },
    orderBy: { startedAt: "desc" },
  });
}

// Compose les candidats attendus par `choisirProfil` : profils du service, avec
// leur nombre d'occupants actifs et celui de leur compte.
// Les profils ou l'on peut placer un acheteur de CETTE formule.
//
// Le filtre portait sur le seul service, jamais sur la formule. Un acheteur
// Standard prenait donc la premiere place libre venue — y compris un profil
// Premium — et reciproquement. Avec quatre profils Premium pour deux Standard,
// un acheteur Standard atterrissait en Premium deux fois sur trois : il
// recevait mieux que ce qu'il avait paye, et le commercant perdait la
// difference sans jamais le voir.
//
// `planId` est donc obligatoire ici. Un profil sans formule (`planId: null`)
// ne correspond a aucune vente et reste volontairement hors du choix : il
// serait sinon le seul a pouvoir accueillir n'importe qui, ce qui reintroduit
// le melange qu'on ferme.
async function candidatsDuService(serviceId, maintenant = new Date(), planId = null) {
  const profils = await prisma.familyAccount.findMany({
    where: { account: { serviceId }, planId },
    select: {
      id: true, capacite: true, createdAt: true,
      account: { select: { id: true, maxFluxSimultanes: true } },
    },
  });
  if (profils.length === 0) return [];

  const compteurs = await prisma.profileOccupancy.groupBy({
    by: ["profileId"],
    where: { profileId: { in: profils.map((p) => p.id) }, ...filtreActive(maintenant) },
    _count: { _all: true },
  });
  const parProfil = new Map(compteurs.map((c) => [c.profileId, c._count._all]));

  const parCompte = new Map();
  for (const p of profils) {
    const n = parProfil.get(p.id) || 0;
    parCompte.set(p.account.id, (parCompte.get(p.account.id) || 0) + n);
  }

  return profils.map((p) => ({
    id: p.id,
    capacite: p.capacite,
    occupantsActifs: parProfil.get(p.id) || 0,
    createdAt: p.createdAt,
    compte: {
      id: p.account.id,
      maxFluxSimultanes: p.account.maxFluxSimultanes,
      occupantsActifs: parCompte.get(p.account.id) || 0,
    },
  }));
}

// Prend une place pour cette commande.
//
// Le comptage rend inopérante l'astuce employée jusqu'ici (un `updateMany`
// conditionné sur un statut) : la condition n'est plus « ce profil est-il
// libre ? » mais « combien sont déjà là ? ». On verrouille donc les lignes
// concernées le temps de recompter et d'écrire, et on réessaie sur le
// candidat suivant si la place a disparu entre-temps.
async function revendiquerPlace({
  serviceId,
  planId,
  order,
  occupantName,
  occupantWhatsapp,
  endsAt,
}) {
  const maintenant = new Date();
  // La formule vient de la commande quand l'appelant ne la precise pas : une
  // place se choisit toujours dans la formule achetee.
  const formule = planId ?? order?.planId ?? null;
  const candidats = await candidatsDuService(serviceId, maintenant, formule);

  // Aucun candidat : la boucle ci-dessous ne s'exécuterait jamais et retomberait
  // sur "profils-pleins" par défaut, un motif faux ici. On passe explicitement
  // par `choisirProfil` pour obtenir le motif "aucun-profil" qu'elle calcule
  // déjà — cas distinct traité par les appelants (voir subscriptions.controller.js).
  if (candidats.length === 0) {
    return { occupation: null, raison: choisirProfil(candidats).raison };
  }

  const dejaVus = new Set();
  // Motif du dernier refus rencontre dans la boucle, remonte si tous les
  // candidats echouent au recomptage sous verrou.
  let dernierRefus = "profils-pleins";

  for (let essai = 0; essai < candidats.length; essai += 1) {
    const restants = candidats.filter((c) => !dejaVus.has(c.id));
    const { profil, raison } = choisirProfil(restants);
    if (!profil) return { occupation: null, raison };

    dejaVus.add(profil.id);

    const resultat = await prisma.$transaction(async (tx) => {
      // DEUX verrous, toujours dans cet ordre : le compte, puis le profil.
      //
      // Le verrou sur le profil seul ne suffit pas, et c'est contre-intuitif.
      // Il protège la capacité du profil : deux acheteurs visant LE MÊME
      // profil se sérialisent sur cette ligne. Mais il ne protège pas le
      // plafond de flux du compte, qui est une somme sur TOUS les profils du
      // compte. Deux acheteurs visant deux profils DIFFÉRENTS d'un même compte
      // ne partageraient aucune ligne verrouillée : tous deux liraient « il
      // reste un flux », tous deux inséreraient, et le compte dépasserait son
      // plafond — soit exactement ce que ce plafond existe pour empêcher, des
      // clients qui se coupent la vidéo entre eux.
      //
      // Verrouiller d'abord la ligne du compte donne à ces deux acheteurs le
      // point de rendez-vous qui leur manquait. Ne pas « simplifier » en
      // retirant l'un des deux verrous : chacun ferme une fenêtre que l'autre
      // laisse ouverte.
      //
      // L'ordre compte → profil est invariable, et c'est ce qui écarte
      // l'interblocage : tous les chemins prennent les verrous dans le même
      // sens, aucun cycle d'attente n'est donc formable.
      //
      // Les deux `SELECT ... FOR UPDATE` ramènent directement les plafonds,
      // et non plus seulement `id` : `candidatsDuService` les a lus HORS
      // verrou, avant la transaction, donc `profil.capacite` et
      // `profil.compte.maxFluxSimultanes` peuvent être périmés au moment où on
      // les compare. Si un admin réduit l'un des deux (`modifierProfil`,
      // `modifierCompte`) pendant que cet achat est en vol, comparer les
      // compteurs frais à un plafond périmé laisserait passer un occupant de
      // trop — la ligne est verrouillée, mais la valeur qui décide ne l'était
      // pas. On relit donc les plafonds depuis les lignes qu'on vient de
      // verrouiller, et on compare compteurs frais à plafonds frais.
      const [compteVerrouille] = await tx.$queryRaw`
        SELECT "maxFluxSimultanes" FROM "StreamingAccount" WHERE id = ${profil.compte.id} FOR UPDATE
      `;
      const [profilVerrouille] = await tx.$queryRaw`
        SELECT capacite FROM "FamilyAccount" WHERE id = ${profil.id} FOR UPDATE
      `;

      const capaciteFraiche = profilVerrouille.capacite;
      const maxFluxFrais = compteVerrouille.maxFluxSimultanes;

      const occupantsProfil = await tx.profileOccupancy.count({
        where: { profileId: profil.id, ...filtreActive(maintenant) },
      });
      // On rend le MOTIF du refus, pas un simple `null` : les deux causes
      // appellent deux gestes différents de l'administrateur — ajouter un
      // profil, ou acheter un compte. Les confondre lui fait chercher au
      // mauvais endroit.
      if (occupantsProfil >= capaciteFraiche) return { refus: "profils-pleins" };

      const occupantsCompte = await tx.profileOccupancy.count({
        where: { profile: { accountId: profil.compte.id }, ...filtreActive(maintenant) },
      });
      if (occupantsCompte >= maxFluxFrais) return { refus: "plafond-flux" };

      const occupation = await tx.profileOccupancy.create({
        data: {
          profileId: profil.id,
          orderId: order.id,
          occupantName,
          occupantWhatsapp,
          startedAt: order.createdAt || maintenant,
          endsAt: endsAt || null,
        },
      });

      // Le reflet herite suit la creation, dans la MEME transaction : sorti de
      // la, une panne entre les deux laisserait un profil occupe affiche comme
      // libre.
      await synchroniserMiroirProfil(tx, profil.id, maintenant);

      // Les compteurs remontent avec l'occupation : le journal doit annoncer
      // l'occupation REELLE du profil, pas l'instantane pris avant le verrou,
      // qui peut avoir vieilli entre-temps.
      return { occupation, occupantsApres: occupantsProfil + 1, capacite: capaciteFraiche };
    });

    if (resultat.occupation) {
      const profilComplet = await prisma.familyAccount.findUnique({
        where: { id: profil.id },
        include: { account: true },
      });
      logger.info(
        `Place attribuée — profil ${profilComplet.profile} ` +
          `(${resultat.occupantsApres}/${resultat.capacite})`,
        { orderId: order.id, occupantWhatsapp },
      );
      return {
        occupation: resultat.occupation,
        profil: profilComplet,
        compte: profilComplet.account,
      };
    }

    dernierRefus = resultat.refus;
  }

  // Tous les candidats ont ete refusés au recomptage. On remonte la cause du
  // DERNIER refus plutot qu'un "profils-pleins" ecrit en dur : quand tous les
  // refus venaient du plafond de flux, conseiller « ajouter un profil » envoie
  // l'administrateur ajouter une place qui ne servira a rien.
  return { occupation: null, raison: dernierRefus };
}

module.exports = {
  synchroniserMiroirProfil,
  estActive,
  filtreActive,
  occupationsActivesDuCompte,
  candidatsDuService,
  revendiquerPlace,
};
