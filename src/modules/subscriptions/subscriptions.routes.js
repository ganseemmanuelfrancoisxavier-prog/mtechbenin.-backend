const express = require("express");
const router = express.Router();
const {
  getServices,
  getServiceBySlug,
  createOrder,
  getAllOrders,
  deleteOrder,
  getAdminDashboard,
  updateCategoryOrder,
  createService,
  updateService,
  deleteService,
  createPlan,
  updatePlan,
  deletePlan,
  getFamilyAccounts,
  addFamilyAccount,
  updateFamilyAccount,
  deleteFamilyAccount,
  getPoolLinks,
  addPoolLink,
  deletePoolLink,
  getLinkClients,
  addLinkClient,
  deleteLinkClient,
  sendLinkToClient,
  setOrderExpiry,
  setFamilyAccountClient,
  listerComptes,
  creerCompte,
  modifierCompte,
  ajouterProfil,
  modifierProfil,
  listerOccupations,
  libererOccupation,
  deplacerOccupation,
  listerCommandesLibres,
  placerCommande,
  enregistrerClientHorsSite,
  listerJournalCodes,
  modifierOccupation,
  supprimerProfil,
  supprimerCompte,
  envoyerIdentifiants,
  demanderCode,
  listerDemandes,
} = require("./subscriptions.controller");
const { isAdmin } = require("../../middleware/auth");
const { strictLimiter } = require("../../middleware/rateLimiter");

// ── Admin — AVANT les routes publiques pour éviter le conflit /:slug ──────────
router.get("/admin/dashboard", isAdmin, getAdminDashboard);
router.get("/admin/orders", isAdmin, getAllOrders);
router.delete("/admin/orders/:id", isAdmin, deleteOrder);
router.patch("/admin/orders/:id/expiry", isAdmin, setOrderExpiry);
router.patch("/admin/category-order", isAdmin, updateCategoryOrder);

// Services
router.post("/admin/services", isAdmin, createService);
router.patch("/admin/services/:id", isAdmin, updateService);
router.delete("/admin/services/:id", isAdmin, deleteService);

// Plans
router.post("/admin/services/:serviceId/plans", isAdmin, createPlan);
router.patch("/admin/plans/:id", isAdmin, updatePlan);
router.delete("/admin/plans/:id", isAdmin, deletePlan);

// Comptes famille
router.get("/admin/plans/:planId/accounts", isAdmin, getFamilyAccounts);
router.post("/admin/plans/:planId/accounts", isAdmin, addFamilyAccount);
router.patch("/admin/accounts/:id", isAdmin, updateFamilyAccount);
// Rattachement manuel d'un profil à son acheteur — route distincte de la mise
// à jour générale, qui n'accepte plus ce champ.
router.patch("/admin/accounts/:id/client", isAdmin, setFamilyAccountClient);
router.delete("/admin/accounts/:id", isAdmin, deleteFamilyAccount);

// ── Comptes streaming et occupations ────────────────────────────────────────
router.get("/admin/services/:serviceId/comptes", isAdmin, listerComptes);
router.post("/admin/services/:serviceId/comptes", isAdmin, creerCompte);
router.patch("/admin/comptes/:id", isAdmin, modifierCompte);
router.post("/admin/comptes/:id/profils", isAdmin, ajouterProfil);
router.patch("/admin/profils/:id", isAdmin, modifierProfil);
router.get("/admin/profils/:id/occupations", isAdmin, listerOccupations);
router.post("/admin/occupations/:id/liberer", isAdmin, libererOccupation);
router.post("/admin/occupations/:id/deplacer", isAdmin, deplacerOccupation);
router.patch("/admin/occupations/:id", isAdmin, modifierOccupation);
router.post("/admin/occupations/:id/envoyer-identifiants", isAdmin, envoyerIdentifiants);
router.delete("/admin/comptes/:id", isAdmin, supprimerCompte);
router.delete("/admin/profils/:id", isAdmin, supprimerProfil);
router.post("/admin/profils/:id/occupations", isAdmin, placerCommande);
// Refonte OTP du 13/10/2026 : un client qui a recu ses identifiants hors du
// site doit etre connu du bot, sinon ses codes partent chez un autre.
router.post("/admin/profils/:id/clients-hors-site", isAdmin, enregistrerClientHorsSite);
router.get("/admin/otp/journal", isAdmin, listerJournalCodes);
router.get("/admin/services/:serviceId/commandes-libres", isAdmin, listerCommandesLibres);

// Journal des demandes de code
router.get("/admin/demandes", isAdmin, listerDemandes);

// Link access
router.get("/admin/plans/:planId/link-clients", isAdmin, getLinkClients);
router.post("/admin/plans/:planId/link-clients", isAdmin, addLinkClient);
router.delete("/admin/link-clients/:id", isAdmin, deleteLinkClient);
router.post("/admin/link-clients/:id/send", isAdmin, sendLinkToClient);

// Réserve de liens (calque des routes accounts pour les formules famille)
router.get("/admin/plans/:planId/pool-links", isAdmin, getPoolLinks);
router.post("/admin/plans/:planId/pool-links", isAdmin, addPoolLink);
router.delete("/admin/pool-links/:id", isAdmin, deletePoolLink);

// ── Public — APRÈS les routes admin ──────────────────────────────────────────
router.get("/", getServices);
router.get("/:slug", getServiceBySlug);
router.post("/order", createOrder);
// Route publique : 10 tentatives par quart d'heure et par IP. Sans ce frein,
// on pourrait ouvrir des fenêtres en boucle pour tenter de capter les codes
// d'un compte partagé.
router.post("/demande-code", strictLimiter, demanderCode);

module.exports = router;
