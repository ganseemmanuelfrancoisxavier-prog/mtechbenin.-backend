const prisma = require("../../services/prisma");

// ═══════════════════════════════════════════════════════════════════════════
//  Agrégats du panneau d'administration
//
//  Ce module existe pour une raison mesurée, pas par goût de la symétrie.
//
//  Le tableau de bord rapatriait 500 produits et 250 commandes TOUTES LES
//  30 SECONDES — 141 Ko par cycle — pour n'afficher que des totaux, six
//  produits en rupture et six commandes récentes. Les badges de la barre
//  latérale rapatriaient 250 commandes toutes les deux minutes, sur CHAQUE
//  page admin, pour afficher trois nombres.
//
//  Un seul onglet admin laissé ouvert consommait ainsi 13 Go par mois, contre
//  un quota Supabase gratuit de 5 Go. Même limité aux heures de bureau, il en
//  consommait 4,4 Go — la quasi-totalité, pour des chiffres tenant sur une
//  ligne.
//
//  Compter dans Postgres plutôt que transférer pour compter dans le navigateur
//  ramène ces deux appels à quelques centaines d'octets.
// ═══════════════════════════════════════════════════════════════════════════

// Ce qui constitue du chiffre d'affaires réalisé. PENDING en est exclu : la
// commande n'est pas payée. CANCELLED aussi, évidemment.
const STATUTS_FACTURES = ["CONFIRMED", "PREPARING", "SHIPPED", "DELIVERED"];

// Ce qui demande encore une action de l'exploitant — le badge « commandes ».
const STATUTS_ACTIFS = ["PENDING", "CONFIRMED", "PREPARING", "SHIPPED"];

// Le seuil d'alerte de stock, tel que l'affichait déjà le tableau de bord.
const SEUIL_STOCK_FAIBLE = 3;

// Même logique que `STATUTS_FACTURES`, transposée aux réparations : tout sauf
// EN_ATTENTE (le paiement n'est pas encore passé) et ANNULEE (jamais facturée)
// compte comme du chiffre d'affaires réalisé.
const STATUTS_REPARATION_PAYEES = [
  "PAYEE", "A_RECUPERER", "RECUPEREE", "EN_ATELIER", "REPAREE", "A_RENDRE", "RENDUE",
];

// Diagnostics pas encore examinés par un technicien : tout ce qui précède
// EN_ATELIER, l'étape où l'appareil passe réellement entre les mains de
// l'atelier. Au-delà, il est en cours de traitement (ou déjà traité) — ce
// n'est plus une attente.
//
// EN_ATTENTE est volontairement exclu : un diagnostic non payé n'attend pas
// l'administrateur, il attend que le CLIENT règle les frais d'enlèvement. Le
// compter ici gonflerait la liste de travail de l'atelier avec des demandes
// qui ne dépendent pas de lui.
const STATUTS_DIAGNOSTIC_EN_ATTENTE = ["PAYEE", "A_RECUPERER", "RECUPEREE"];

async function tableauDeBord(req, res, next) {
  try {
    // ── Séquentiel, et non `Promise.all` ────────────────────────────────────
    //
    // Ces sept requêtes partaient en parallèle. Chacune réclame sa propre
    // connexion : une seule requête HTTP en mobilisait donc SEPT. Le pool
    // Prisma en compte neuf par défaut (processeurs × 2 + 1), et ce tableau de
    // bord est interrogé toutes les 30 secondes — deux chargements concurrents
    // en demandaient quatorze.
    //
    // Le résultat, observé en production : « Timed out fetching a new
    // connection from the connection pool », le panel renvoyant des 503 et 500
    // sans que rien ne soit tombé. Le parallélisme À L'INTÉRIEUR d'une requête
    // se paie sur une ressource PARTAGÉE entre toutes les requêtes.
    //
    // En série, chaque requête HTTP ne tient qu'une connexion. Ce sont des
    // comptages indexés à ~35 ms : l'appel passe d'environ 280 ms à 250 ms.
    // On n'a rien perdu, et on a cessé de prendre le pool en otage.
    const commandesTotal = await prisma.order.count();

    // `aggregate` fait la somme dans Postgres. L'ancien calcul additionnait les
    // commandes côté navigateur, donc SEULEMENT les 250 rapatriées : au-delà,
    // le chiffre d'affaires affiché devenait faux, sans que rien ne le signale.
    const revenus = await prisma.order.aggregate({
      _sum: { total: true },
      where: { status: { in: STATUTS_FACTURES } },
    });

    const produitsActifs = await prisma.product.count({ where: { active: true } });
    const stockFaibleTotal = await prisma.product.count({
      where: { active: true, stock: { lte: SEUIL_STOCK_FAIBLE } },
    });

    const stockFaible = await prisma.product.findMany({
      where: { active: true, stock: { lte: SEUIL_STOCK_FAIBLE } },
      orderBy: { stock: "asc" },
      take: 6,
      select: { id: true, name: true, stock: true },
    });

    const meilleuresVentes = await prisma.product.findMany({
      where: { active: true },
      orderBy: { salesCount: "desc" },
      take: 5,
      select: { id: true, name: true, price: true, salesCount: true },
    });

    const commandesRecentes = await prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      // Énumérées une à une : un `select` absent ferait revenir la commande
      // entière, adresse et instructions comprises, pour afficher un nom et un
      // montant.
      select: {
        id: true,
        reference: true,
        status: true,
        total: true,
        guestName: true,
        createdAt: true,
      },
    });

    // Réparations : mêmes règles de sérialisation que ci-dessus. Trois
    // requêtes de plus sur le même pool à neuf connexions — les ajouter en
    // `Promise.all` reproduirait exactement l'épuisement du commit `166e9e6`.
    const reparationsTotal = await prisma.repairOrder.count({
      where: { kind: "REPARATION", status: { in: STATUTS_REPARATION_PAYEES } },
    });
    const revenusReparation = await prisma.repairOrder.aggregate({
      _sum: { total: true },
      where: { kind: "REPARATION", status: { in: STATUTS_REPARATION_PAYEES } },
    });
    const diagnosticsEnAttente = await prisma.repairOrder.count({
      where: { kind: "DIAGNOSTIC", status: { in: STATUTS_DIAGNOSTIC_EN_ATTENTE } },
    });

    return res.json({
      commandes: { total: commandesTotal, chiffreAffaires: revenus._sum.total || 0 },
      produits: { actifs: produitsActifs, stockFaible: stockFaibleTotal },
      stockFaible,
      meilleuresVentes: meilleuresVentes.map((p) => ({
        id: p.id,
        name: p.name,
        sales: p.salesCount,
        revenue: p.price * p.salesCount,
      })),
      commandesRecentes,
      reparations: {
        total: reparationsTotal,
        chiffreAffaires: revenusReparation._sum.total || 0,
        diagnosticsEnAttente,
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function badges(req, res, next) {
  try {
    // Séquentiel pour la même raison que le tableau de bord : cette barre
    // latérale est montée sur CHAQUE page d'administration, et trois connexions
    // par appel s'additionnent vite sur un pool de neuf.
    const commandesActives = await prisma.order.count({
      where: { status: { in: STATUTS_ACTIFS } },
    });
    const avisEnAttente = await prisma.review.count({ where: { approved: false } });
    const contactsNouveaux = await prisma.contactMessage.count({
      where: { status: "new" },
    });

    return res.json({ commandesActives, avisEnAttente, contactsNouveaux });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  tableauDeBord,
  badges,
  STATUTS_FACTURES,
  STATUTS_ACTIFS,
  SEUIL_STOCK_FAIBLE,
  STATUTS_REPARATION_PAYEES,
  STATUTS_DIAGNOSTIC_EN_ATTENTE,
};
