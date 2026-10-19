const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");
const { filtreActive } = require("./occupancy");
const {
  FENETRE_MS,
  normaliserNumero,
  memeNumero,
  choisirDemande,
  compterTentatives,
  plafondAtteint,
} = require("./demandeCode");

// Ouvre une fenêtre pour ce numéro, sur TOUS ses comptes actifs.
//
// Un client abonné à Netflix et à Disney+ qui écrit « CODE » y a droit
// partout, et chaque compte n'enverra que son propre code : lui demander de
// choisir ajouterait un aller-retour pour un gain nul dans l'immense majorité
// des cas.
//
// Une demande déjà ouverte sur la même occupation est REMPLACÉE, pas doublée :
// redemander parce qu'on n'a rien reçu ne doit pas empiler des fenêtres qui
// se disputeraient le prochain code.
async function ouvrirDemandes({ numero, canal }) {
  const normalise = normaliserNumero(numero);
  if (!normalise) return { demandes: [], occupations: [], raison: "numero-invalide" };

  const maintenant = new Date();

  // Le filtre porte sur les chiffres seuls : `occupantWhatsapp` est stocké
  // sous des formes variables, donc aucune égalité SQL ne conviendrait. On
  // charge les occupations actives et on compare en mémoire — leur nombre se
  // compte en dizaines, jamais en milliers.
  const actives = await prisma.profileOccupancy.findMany({
    where: filtreActive(maintenant),
    include: {
      profile: { select: { id: true, profile: true, accountId: true } },
    },
  });

  // `memeNumero` et non une egalite de chaines : le client saisit sa forme
  // locale, la commande porte la forme internationale. Comparees a
  // l'identique, elles ne se rejoignaient jamais.
  const siennes = actives.filter(
    (o) => memeNumero(o.occupantWhatsapp, normalise) && o.profile.accountId,
  );

  if (siennes.length === 0) {
    return { demandes: [], occupations: [], raison: "aucune-occupation-active" };
  }

  // Plafond par NUMERO, distinct du plafond par IP de la route publique.
  // Sans lui, rouvrir une fenetre en boucle resterait possible : par le web
  // depuis plusieurs adresses, et par WhatsApp ou aucune limite de debit ne
  // s'applique. La spec l'exige explicitement.
  //
  // On lit les `requestedAt` plutot que de compter les lignes : le plafond
  // porte sur les TENTATIVES, et une tentative ouvre autant de lignes que le
  // numero a d'occupations actives. Voir `compterTentatives` (demandeCode.js).
  const debutFenetreAntiAbus = new Date(maintenant.getTime() - FENETRE_MS);
  const recentes = await prisma.otpRequest.findMany({
    where: {
      requestedAt: { gte: debutFenetreAntiAbus },
      occupancy: { occupantWhatsapp: { in: siennes.map((o) => o.occupantWhatsapp) } },
    },
    select: { requestedAt: true },
  });
  if (plafondAtteint(recentes)) {
    logger.warn("Demandes de code trop frequentes pour ce numero", {
      canal,
      tentatives: compterTentatives(recentes),
      lignes: recentes.length,
    });
    return { demandes: [], occupations: siennes, raison: "trop-de-demandes" };
  }

  const expiresAt = new Date(maintenant.getTime() + FENETRE_MS);
  const demandes = [];

  for (const occupation of siennes) {
    // Clôt les fenêtres encore ouvertes de cette occupation avant d'en ouvrir
    // une neuve. `servedAt` marque « close » — ici parce que remplacée.
    await prisma.otpRequest.updateMany({
      where: { occupancyId: occupation.id, servedAt: null },
      data: { servedAt: maintenant },
    });

    demandes.push(
      await prisma.otpRequest.create({
        data: {
          accountId: occupation.profile.accountId,
          occupancyId: occupation.id,
          canal,
          requestedAt: maintenant,
          expiresAt,
        },
      }),
    );
  }

  logger.info(`Demande de code ouverte — ${demandes.length} compte(s)`, {
    canal,
    occupations: siennes.length,
  });

  return { demandes, occupations: siennes, raison: "ouvertes" };
}

// La demande valide qui fait foi sur CES comptes, ou null.
//
// Plusieurs comptes : une même boîte mail peut porter plusieurs
// `StreamingAccount`, et `occupationsActivesDuCompte` les fusionne déjà côté
// routage. Ne chercher la demande que sur le premier laisserait une demande
// ouverte sur le second invisible, et le code retomberait en « ambigu ».
//
// Trois filtres, pas un :
//   • `servedAt: null` — la demande n'a pas déjà servi ;
//   • `expiresAt > maintenant` — une demande expirée ne peut plus rien
//     décider, et sans cette borne on rechargerait à chaque code reçu, avec
//     ses jointures, tout l'historique des demandes jamais servies. Ce filtre
//     ne concerne QUE la lecture de routage : `journalDemandes` continue de
//     montrer les expirées, c'est son rôle ;
//   • l'occupation est encore active — voir juste en dessous.
async function demandeOuverteDesComptes(accountIds, maintenant = new Date()) {
  const ids = (Array.isArray(accountIds) ? accountIds : [accountIds]).filter(Boolean);
  if (ids.length === 0) return null;

  const demandes = await prisma.otpRequest.findMany({
    where: {
      accountId: { in: ids },
      servedAt: null,
      expiresAt: { gt: maintenant },
      // Quinze minutes suffisent pour qu'une place soit libérée, déplacée ou
      // arrivée à échéance. Sans cette condition, le code partirait à un
      // ex-occupant — et si la place a été revendue, au PRÉDÉCESSEUR du
      // nouvel occupant, qui n'obtiendrait rien.
      occupancy: filtreActive(maintenant),
    },
    include: {
      occupancy: {
        include: {
          order: {
            select: {
              id: true, clientName: true, clientWhatsapp: true, clientEmail: true,
              isGift: true, giftName: true, giftWhatsapp: true, expiresAt: true,
              service: { select: { name: true, slug: true, category: true } },
            },
          },
          profile: { select: { id: true, profile: true } },
        },
      },
    },
  });
  return choisirDemande(demandes, maintenant);
}

// Clôt la demande une fois le code parti, pour qu'elle ne serve pas deux fois.
async function marquerServie(demandeId, otpLogId = null) {
  await prisma.otpRequest.update({
    where: { id: demandeId },
    data: { servedAt: new Date(), otpLogId },
  });
}

async function journalDemandes(limite = 100) {
  // `take` de Prisma exige un entier strict : borner min/max sans tronquer ne
  // suffit pas, une valeur decimale (ex. ?limite=2.5 depuis une URL mal
  // tapee) survivrait au clamp et ferait echouer la validation Prisma en 500.
  // Math.trunc coupe la partie decimale AVANT le clamp, et Number.isFinite
  // ecarte les entrees non numeriques (NaN) pour retomber sur le defaut.
  const brut = Math.trunc(Number(limite));
  const bornee = Number.isFinite(brut) ? Math.min(500, Math.max(1, brut)) : 100;
  return prisma.otpRequest.findMany({
    orderBy: { requestedAt: "desc" },
    take: bornee,
    include: {
      account: { select: { email: true, service: { select: { name: true } } } },
      occupancy: {
        select: {
          occupantName: true,
          occupantWhatsapp: true,
          profile: { select: { profile: true } },
        },
      },
    },
  });
}

module.exports = {
  ouvrirDemandes,
  demandeOuverteDesComptes,
  marquerServie,
  journalDemandes,
};
