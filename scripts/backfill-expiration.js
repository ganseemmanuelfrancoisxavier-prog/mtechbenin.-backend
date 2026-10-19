// Renseigne la date d'expiration des abonnements confirmés qui n'en ont pas.
//
// Ne touche jamais une date déjà présente : l'administrateur peut avoir saisi
// à la main une date que ce calcul ne saurait pas retrouver.
// Rejouable sans effet de bord.
//
// Le prix unitaire ne vient pas de `o.amount` : ce champ contient le TOTAL de
// la ligne (prix unitaire × quantité), ce qui fausserait silencieusement le
// nombre de mois pour toute commande de plusieurs abonnements. La bonne
// source est la ligne de la commande d'origine (`Order.items`), retrouvée via
// `sourceOrderRef` puis filtrée sur `productSlug === "abonnement-" + planId`
// — la même convention que `subscriptions.controller.js` utilise déjà pour
// construire l'e-mail de confirmation. `o.amount` ne sert plus que de repli
// quand cette ligne est introuvable.

const prisma = require("../src/services/prisma");
const { moisAchetes, dateExpiration } = require("../workers/subscriptionExpiry");

const APPLIQUER = process.argv.includes("--appliquer");

// Retrouve le prix unitaire ET la date de départ à utiliser pour un
// abonnement donné, et indique d'où ils viennent — trace nécessaire pour un
// rattrapage qui écrit en production : on doit pouvoir relire après coup la
// provenance de chaque date calculée.
//
// La date de départ est celle de la commande d'origine, pas celle de la ligne
// d'abonnement. Les deux diffèrent : `SubscriptionOrder.createdAt` vaut
// l'instant de la confirmation du paiement, tandis que `Order.createdAt` est
// le moment de l'achat. C'est cette dernière que retiennent désormais
// `assignSubscriptionFromOrderItem` et `workers/orderReconciler.js` ; ce
// script doit s'aligner, sans quoi deux clients ayant acheté la même formule
// obtiendraient des dates différentes selon le chemin qui les a traités.
async function sourceDuCalcul(o) {
  if (o.sourceOrderRef) {
    const commande = await prisma.order.findUnique({
      where: { reference: o.sourceOrderRef },
      include: { items: true },
    });
    const ligne = commande?.items?.find((i) => i.productSlug === `abonnement-${o.planId}`);
    if (ligne) {
      return {
        unitPrice: ligne.unitPrice,
        debut: commande.createdAt,
        source: "ligne de commande",
      };
    }
  }
  return { unitPrice: o.amount, debut: o.createdAt, source: "amount (repli)" };
}

(async () => {
  const orders = await prisma.subscriptionOrder.findMany({
    where: {
      status: "CONFIRMED",
      expiresAt: null,
      // Une formule a vie n'a PAS de date, et c'est voulu. Sans cette
      // exclusion, ce script prendrait ces commandes pour des oublis et leur
      // poserait une echeance calculee sur `plan.duration` — soit un mois par
      // defaut — mettant fin en silence a des acces vendus comme definitifs.
      // Le script s'appelle « backfill » : il sera relance, et ce jour-la
      // personne ne relira cette requete.
      plan: { is: { aVie: false } },
    },
    include: { plan: true, service: true },
    orderBy: { createdAt: "asc" },
  });

  let remplis = 0;
  const laisses = [];
  const calcules = [];

  for (const o of orders) {
    const { unitPrice, debut, source } = await sourceDuCalcul(o);
    const duree = moisAchetes({
      unitPrice,
      planPrice: o.plan?.price,
      planDuration: o.plan?.duration,
    });
    if (!duree.ok) {
      laisses.push({ id: o.id, service: o.service?.name, client: o.clientName, montant: unitPrice, prixPlan: o.plan?.price, raison: duree.raison });
      continue;
    }
    const date = dateExpiration({ debut, mois: duree.mois });
    if (APPLIQUER) {
      await prisma.subscriptionOrder.update({ where: { id: o.id }, data: { expiresAt: date } });
    }
    calcules.push({ id: o.id, service: o.service?.name, client: o.clientName, source, unitPrice, mois: duree.mois, date });
    remplis++;
  }

  console.log(APPLIQUER ? "— APPLIQUÉ —" : "— SIMULATION (ajouter --appliquer pour écrire) —");
  console.log("abonnements sans date  :", orders.length);
  console.log("dates calculées        :", remplis);
  console.log("laissés à l'admin      :", laisses.length);
  console.log();
  console.log("Détail des dates calculées (source du prix utilisé) :");
  calcules.forEach((c) =>
    console.log(
      "   ",
      (c.service || "?").padEnd(14),
      (c.client || "?").slice(0, 18).padEnd(18),
      "prix unitaire", String(c.unitPrice).padStart(7),
      "| mois", String(c.mois).padStart(2),
      "| source:", c.source.padEnd(18),
      "| expire le", c.date.toISOString().slice(0, 10),
    ),
  );
  console.log();
  console.log("Laissés à l'administrateur :");
  laisses.forEach((l) =>
    console.log("   ", (l.service || "?").padEnd(14), (l.client || "?").slice(0, 18).padEnd(18), "montant", String(l.montant).padStart(7), "| plan", String(l.prixPlan).padStart(6), "|", l.raison),
  );

  await prisma.$disconnect();
})();
