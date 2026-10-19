// Résolution des identifiants envoyés par le navigateur en entités du
// catalogue — la seule source du prix d'une réparation.
//
// Module séparé du contrôleur, dans le même esprit que `workers/otpRouting.js` :
// il touche la base, donc `repairs.controller.js` ne peut pas être testé sans
// PostgreSQL, mais LUI le peut — via un `prisma` bouchonné injecté dans le
// cache de modules (voir `resolution.test.js`). C'est le chemin de l'argent :
// il doit rester testable sans base.
const prisma = require("../../services/prisma");

// Relit en base les options choisies, et refuse tout ce qui ne colle pas.
//
// Le navigateur n'envoie que des identifiants : c'est ICI que le prix naît.
// Les quatre refus ferment chacun un trou distinct — une option d'un autre
// modèle mélangerait deux appareils, une option désactivée vendrait un service
// retiré, deux options d'une même réparation factureraient deux écrans, et un
// modèle (ou sa famille) désactivé resterait commandable tant que la
// réparation et l'option le restent — alors que c'est tout le sens du
// drapeau `active` : le catalogue public (`getModele`) le cache déjà, la
// vente doit s'arrêter partout, pas seulement à l'affichage.
async function resoudreOptions(modelId, optionIds) {
  const ids = [...new Set((optionIds || []).map(String))];
  if (ids.length === 0) return { ok: false, erreur: "Aucune réparation sélectionnée" };

  const options = await prisma.repairOption.findMany({
    where: {
      id: { in: ids },
      active: true,
      job: { active: true, modelId, model: { active: true, family: { active: true } } },
    },
    include: { job: { select: { id: true, name: true, delay: true } } },
  });

  if (options.length !== ids.length) {
    return { ok: false, erreur: "Une réparation choisie n'est plus disponible" };
  }
  const parReparation = new Set(options.map((o) => o.job.id));
  if (parReparation.size !== options.length) {
    return { ok: false, erreur: "Deux qualités choisies pour la même réparation" };
  }

  return {
    ok: true,
    options: options.map((o) => ({
      id: o.id, label: o.label, price: o.price,
      jobId: o.job.id, jobName: o.job.name, delay: o.job.delay,
    })),
  };
}

// Charge un modèle commandable : actif, famille active comprise, avec les
// instantanés (`space`/`familyName`/`modelName`) dont les créations de
// commande et de diagnostic ont besoin.
//
// Partagée par les trois points d'entrée qui commandent depuis un `modelId`
// (commande, diagnostic, devis WhatsApp) : désactiver un modèle doit arrêter
// la vente PARTOUT, pas seulement sur le catalogue public qui le cache déjà
// (`getModele`) — sans ce garde-fou ici, un modèle désactivé restait
// commandable tant que sa réparation et son option l'étaient encore.
async function trouverModeleActif(modelId) {
  const modele = await prisma.repairModel.findUnique({
    where: { id: String(modelId || "") },
    include: { family: { select: { name: true, space: true, active: true } } },
  });
  if (!modele || !modele.active || !modele.family.active) return null;
  return modele;
}

module.exports = { resoudreOptions, trouverModeleActif };
