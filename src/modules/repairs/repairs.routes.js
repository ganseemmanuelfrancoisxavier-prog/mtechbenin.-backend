const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { isAdmin } = require("../../middleware/auth");
const { strictLimiter } = require("../../middleware/rateLimiter");
const {
  getFamilles,
  getModelesDeFamille,
  getModele,
  rechercherModeles,
  creerCommandeReparation,
  creerDiagnostic,
  envoyerDevisWhatsapp,
  suivreReparation,
  getCatalogueAdmin,
  creerFamille,
  modifierFamille,
  supprimerFamille,
  creerModele,
  modifierModele,
  supprimerModele,
  creerReparation,
  modifierReparation,
  supprimerReparation,
  dupliquerReparation,
  creerOption,
  modifierOption,
  supprimerOption,
  listerDemandes,
  changerStatut,
  definirDateRetour,
  ajouterLigneHorsCatalogue,
  ouvrirReparationDepuisDiagnostic,
  annulerDemande,
} = require("./repairs.controller");

// ── Public — lecture du catalogue ────────────────────────────────────────────
// `/recherche` AVANT `/modeles/:slug` n'est pas nécessaire ici (préfixes
// distincts), mais `/familles/:slug/modeles` doit rester après `/familles`.
router.get("/familles", getFamilles);
router.get("/familles/:slug/modeles", getModelesDeFamille);
router.get("/modeles/:slug", getModele);
router.get("/recherche", rechercherModeles);

// ── Public — commande, diagnostic, devis ─────────────────────────────────────

// `POST /devis/whatsapp` fait partir un message DEPUIS NOTRE SESSION WhatsApp
// vers un numéro fourni par l'appelant. Sans plafond, c'est un distributeur de
// spam à notre nom — et WhatsApp suspend les sessions pour cela.
router.post("/devis/whatsapp", strictLimiter, envoyerDevisWhatsapp);

// Création de commandes : publiques et non authentifiées, donc plafonnées.
// Le `strictLimiter` (10 / 15 min) est trop serré — un client peut se tromper
// d'adresse, revenir, recommencer. Même raisonnement que le limiteur de photos
// des avis.
const creationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Trop de demandes — réessayez dans quelques minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/commandes", creationLimiter, creerCommandeReparation);
router.post("/diagnostics", creationLimiter, creerDiagnostic);

// Suivi public par référence — liste blanche de champs, jamais la ligne
// entière (voir le commentaire de `suivreReparation`).
router.get("/suivi/:reference", suivreReparation);

// ── Admin — gestion du catalogue ─────────────────────────────────────────────
// `/admin/*` avant tout, protégé par `isAdmin` comme le reste du projet.
router.get("/admin/catalogue", isAdmin, getCatalogueAdmin);

router.post("/admin/familles", isAdmin, creerFamille);
router.patch("/admin/familles/:id", isAdmin, modifierFamille);
router.delete("/admin/familles/:id", isAdmin, supprimerFamille);

router.post("/admin/modeles", isAdmin, creerModele);
router.patch("/admin/modeles/:id", isAdmin, modifierModele);
router.delete("/admin/modeles/:id", isAdmin, supprimerModele);

router.post("/admin/reparations", isAdmin, creerReparation);
router.patch("/admin/reparations/:id", isAdmin, modifierReparation);
router.delete("/admin/reparations/:id", isAdmin, supprimerReparation);
router.post("/admin/reparations/:id/dupliquer", isAdmin, dupliquerReparation);

router.post("/admin/options", isAdmin, creerOption);
router.patch("/admin/options/:id", isAdmin, modifierOption);
router.delete("/admin/options/:id", isAdmin, supprimerOption);

// ── Admin — panel des demandes ───────────────────────────────────────────────
router.get("/admin/commandes", isAdmin, listerDemandes);
router.patch("/admin/commandes/:id/statut", isAdmin, changerStatut);
router.patch("/admin/commandes/:id/date-retour", isAdmin, definirDateRetour);
router.post("/admin/commandes/:id/lignes", isAdmin, ajouterLigneHorsCatalogue);
router.post("/admin/commandes/:id/reparation", isAdmin, ouvrirReparationDepuisDiagnostic);
router.post("/admin/commandes/:id/annuler", isAdmin, annulerDemande);

module.exports = router;
