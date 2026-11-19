const prisma = require("../src/services/prisma");
const logger = require("../src/utils/logger");

const DELAI_PREPARATION_MS = 5 * 60 * 1000;
const INTERVALLE_VERIFICATION_MS = 15 * 1000;
let intervalle = null;

async function avancerCommandesEnLivraison(maintenant = new Date()) {
  const avant = new Date(maintenant.getTime() - DELAI_PREPARATION_MS);
  const resultat = await prisma.order.updateMany({
    where: {
      status: "PREPARING",
      updatedAt: { lte: avant },
    },
    data: { status: "SHIPPED" },
  });

  if (resultat.count > 0) {
    logger.info("Commandes passées automatiquement en livraison", { count: resultat.count });
  }
  return resultat.count;
}

function demarrerProgressionCommandes() {
  if (intervalle) return intervalle;

  const verifier = () => {
    avancerCommandesEnLivraison().catch((err) =>
      logger.error("Erreur progression automatique des commandes", { err: err.message }),
    );
  };

  verifier();
  intervalle = setInterval(verifier, INTERVALLE_VERIFICATION_MS);
  intervalle.unref?.();
  logger.info("Progression automatique active — livraison après 5 minutes de préparation");
  return intervalle;
}

module.exports = {
  DELAI_PREPARATION_MS,
  avancerCommandesEnLivraison,
  demarrerProgressionCommandes,
};
