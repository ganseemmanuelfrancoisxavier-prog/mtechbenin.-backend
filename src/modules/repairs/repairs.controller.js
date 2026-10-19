const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");
const { slugifier, slugDisponible } = require("./slug");
const { calculerReparation } = require("./tarification");
const { messageClient, transitionAutorisee, libelleStatut } = require("./statuts");
const { resoudreOptions, trouverModeleActif } = require("./resolution");
const whatsapp = require("../../services/whatsapp");
const { generateRepairRef } = require("../../utils/generateRef");
const { incrementUsed } = require("../coupons/coupons.controller");
const { upsertClient } = require("../clients/clients.controller");

const ESPACES = ["ANDROID", "APPLE", "PC"];

// Le catalogue public ne montre QUE l'actif, à tous les niveaux.
//
// Désactiver un modèle doit le retirer de la boutique sans effacer les
// commandes déjà passées dessus — c'est tout l'intérêt d'avoir un drapeau
// plutôt qu'une suppression.
async function getFamilles(req, res) {
  try {
    const espace = String(req.query.espace || "").toUpperCase();
    if (!ESPACES.includes(espace)) {
      return res.status(400).json({ error: "Espace inconnu" });
    }
    const familles = await prisma.repairFamily.findMany({
      where: { space: espace, active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, slug: true },
    });
    return res.json({ familles });
  } catch (err) {
    logger.error("Erreur getFamilles", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getModelesDeFamille(req, res) {
  try {
    const famille = await prisma.repairFamily.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, name: true, slug: true, space: true, active: true },
    });
    if (!famille || !famille.active) {
      return res.status(404).json({ error: "Famille introuvable" });
    }
    const modeles = await prisma.repairModel.findMany({
      where: { familyId: famille.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, slug: true },
    });
    return res.json({ famille, modeles });
  } catch (err) {
    logger.error("Erreur getModelesDeFamille", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// La page où le client coche ses réparations : le modèle, ses réparations
// actives, et pour chacune ses qualités de pièce avec leur prix.
//
// Une réparation dont toutes les options sont désactivées est EXCLUE : sans
// prix affichable, elle n'est pas commandable, et la montrer promettrait un
// service qu'on ne peut pas rendre.
async function getModele(req, res) {
  try {
    const modele = await prisma.repairModel.findUnique({
      where: { slug: req.params.slug },
      include: {
        family: { select: { name: true, slug: true, space: true, active: true } },
        jobs: {
          where: { active: true },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          include: {
            options: {
              where: { active: true },
              orderBy: [{ sortOrder: "asc" }, { price: "asc" }],
              select: { id: true, label: true, price: true },
            },
          },
        },
      },
    });
    if (!modele || !modele.active || !modele.family.active) {
      return res.status(404).json({ error: "Modèle introuvable" });
    }

    const reparations = modele.jobs
      .filter((j) => j.options.length > 0)
      .map((j) => ({ id: j.id, name: j.name, delay: j.delay, options: j.options }));

    return res.json({
      modele: { id: modele.id, name: modele.name, slug: modele.slug },
      famille: modele.family,
      reparations,
    });
  } catch (err) {
    logger.error("Erreur getModele", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Recherche BORNÉE À L'ESPACE choisi : chercher « air » ne doit pas mélanger un
// MacBook Air et un Galaxy A-quelque-chose. Le client a déjà dit quel appareil
// il tient en main.
async function rechercherModeles(req, res) {
  try {
    const espace = String(req.query.espace || "").toUpperCase();
    if (!ESPACES.includes(espace)) {
      return res.status(400).json({ error: "Espace inconnu" });
    }
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ modeles: [] });

    const modeles = await prisma.repairModel.findMany({
      where: {
        active: true,
        family: { space: espace, active: true },
        name: { contains: q, mode: "insensitive" },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      take: 30,
      select: {
        id: true, name: true, slug: true,
        family: { select: { name: true, slug: true } },
      },
    });
    return res.json({ modeles });
  } catch (err) {
    logger.error("Erreur rechercherModeles", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Public — commande, diagnostic, devis ─────────────────────────────────────

// Frais d'enlèvement, en FCFA. Un seul réglage, trois usages : facturés pour un
// diagnostic, retenus quand un appareil est irréparable, et 0 signifie
// « gratuit » — auquel cas aucun paiement n'est demandé du tout.
async function lireFraisEnlevement() {
  const reglage = await prisma.setting.findUnique({
    where: { key: "fraisEnlevementReparation" },
  });
  const valeur = parseInt(reglage?.value, 10);
  return Number.isInteger(valeur) && valeur >= 0 ? valeur : 0;
}

async function lireTauxFrais() {
  const reglage = await prisma.setting.findUnique({ where: { key: "paymentFeePercent" } });
  const pourcent = parseFloat(reglage?.value);
  return (Number.isFinite(pourcent) ? pourcent : 0) / 100;
}

// Contrôles communs à la commande et au diagnostic : sans nom ni WhatsApp,
// personne à contacter ; sans ville, pas d'enlèvement possible.
function validerContact({ clientName, clientWhatsapp, city }) {
  if (!String(clientName || "").trim() || !String(clientWhatsapp || "").trim()) {
    return { ok: false, erreur: "Nom et WhatsApp du client requis" };
  }
  if (!String(city || "").trim()) {
    return { ok: false, erreur: "Ville requise" };
  }
  return { ok: true };
}

// La spec confie à `DeliveryZone` le rôle de dire si un endroit est desservi.
// Contrairement au panier produit (`computeDeliveryFee`, orders.controller.js)
// qui retombe silencieusement sur des frais nuls quand la ville est inconnue,
// une commande de réparation REFUSE la ville non couverte : un livreur ne
// peut pas être envoyé n'importe où, et sans cette vérification une demande
// peut naître dans une ville où personne ne viendra jamais la récupérer.
async function validerZoneCouverte(city) {
  const zone = await prisma.deliveryZone.findFirst({
    where: { active: true, name: { equals: String(city).trim(), mode: "insensitive" } },
  });
  if (!zone) {
    return { ok: false, erreur: "Cette ville n'est pas desservie par notre service de réparation" };
  }
  return { ok: true, zone };
}

// Normalise les champs d'enlèvement, identiques sur la commande et le
// diagnostic : chaînes vides ramenées à `null`, coordonnées converties
// seulement si elles sont réellement fournies. Partagée pour que les deux
// écritures Prisma restent identiques trait pour trait — un écart entre les
// deux serait invisible en revue et ne se découvrirait qu'en production, sur
// une adresse mal enregistrée.
function construireChampsEnlevement({
  neighborhood, instructions, pickupSlot, pickupLat, pickupLng, zoneName,
}) {
  return {
    neighborhood: neighborhood ? String(neighborhood).trim() : null,
    instructions: instructions ? String(instructions).trim() : null,
    pickupSlot: pickupSlot ? String(pickupSlot).trim() : null,
    pickupLat: pickupLat !== undefined && pickupLat !== null && pickupLat !== "" ? Number(pickupLat) : null,
    pickupLng: pickupLng !== undefined && pickupLng !== null && pickupLng !== "" ? Number(pickupLng) : null,
    zoneName: zoneName ? String(zoneName).trim() : null,
  };
}

// Valide l'éligibilité d'un coupon en calquant les contrôles de
// `computeValidatedCoupon` (orders.controller.js) — existant, actif, non
// expiré, `maxUses` non atteint. Le seuil `minOrder` n'est volontairement PAS
// vérifié ici : c'est `calculerReparation`, seule à calculer une remise, qui
// le fait déjà. Deux arithmétiques de remise dans le projet finiraient par
// diverger — une seule doit calculer.
//
// Différence assumée avec le panier : le panier ignore silencieusement un
// coupon invalide, ici on le refuse avec un message lisible — un client qui a
// saisi un code délibérément doit savoir pourquoi il ne s'applique pas.
async function validerCouponReparation(couponCode) {
  const coupon = await prisma.coupon.findUnique({
    where: { code: String(couponCode).toUpperCase().trim() },
  });
  const maintenant = new Date();
  const valide =
    coupon &&
    coupon.active &&
    (!coupon.expiresAt || new Date(coupon.expiresAt) >= maintenant) &&
    (!coupon.maxUses || coupon.usedCount < coupon.maxUses);
  if (!valide) return { ok: false, erreur: "Ce code promo n'est pas valide" };
  return { ok: true, coupon: { code: coupon.code, type: coupon.type, value: coupon.value, minOrder: coupon.minOrder } };
}

// Crée une commande de réparation payante, en `EN_ATTENTE` de paiement.
//
// Contrat figé : la sortie `{ reference, total, feeAmount }` est consommée
// par le lot 2 (paiement). Tout champ de montant présent dans le corps de la
// requête (ex. `total`, `price`) est ignoré en silence via la déstructuration
// ci-dessous — le refuser bruyamment apprendrait à un attaquant que le champ
// existe. Le prix naît uniquement de `resoudreOptions` + `calculerReparation`.
//
// ── Contrat de montant, à lire avant de brancher le lot 2 (voir aussi
// tarification.js) ──
// `total` ici EXCLUT les frais de service (`total = subtotal - discount`),
// contrairement à `Order.total` (parcours produit) qui les INCLUT. Le
// montant à afficher au client est donc `total + feeAmount`, jamais `total`
// seul, et c'est `total` (hors frais) qui doit partir vers FedaPay — pas
// `total - feeAmount`, qui sous-facturerait les frais une seconde fois.
async function creerCommandeReparation(req, res) {
  try {
    const {
      modelId, optionIds, clientName, clientWhatsapp, clientEmail,
      city, neighborhood, instructions, pickupSlot, pickupLat, pickupLng,
      zoneName, couponCode,
    } = req.body || {};

    const contact = validerContact({ clientName, clientWhatsapp, city });
    if (!contact.ok) return res.status(400).json({ error: contact.erreur });
    const zoneCouverte = await validerZoneCouverte(city);
    if (!zoneCouverte.ok) return res.status(400).json({ error: zoneCouverte.erreur });

    const modele = await trouverModeleActif(modelId);
    if (!modele) return res.status(400).json({ error: "Modèle introuvable" });

    const resolu = await resoudreOptions(modele.id, optionIds);
    if (!resolu.ok) return res.status(400).json({ error: resolu.erreur });

    let coupon = null;
    if (couponCode) {
      const validation = await validerCouponReparation(couponCode);
      if (!validation.ok) return res.status(400).json({ error: validation.erreur });
      coupon = validation.coupon;
    }

    const tauxFrais = await lireTauxFrais();
    const resultat = calculerReparation({ options: resolu.options, coupon, tauxFrais });
    if (!resultat.ok) return res.status(400).json({ error: resultat.erreur });

    const commande = await prisma.repairOrder.create({
      data: {
        reference: generateRepairRef(),
        kind: "REPARATION",
        clientName: String(clientName).trim(),
        clientWhatsapp: String(clientWhatsapp).trim(),
        clientEmail: clientEmail ? String(clientEmail).trim() : null,
        space: modele.family.space,
        familyName: modele.family.name,
        modelName: modele.name,
        city: String(city).trim(),
        ...construireChampsEnlevement({ neighborhood, instructions, pickupSlot, pickupLat, pickupLng, zoneName }),
        subtotal: resultat.subtotal,
        discount: resultat.discount,
        feeAmount: resultat.feeAmount,
        total: resultat.total,
        couponCode: coupon ? coupon.code : null,
        status: "EN_ATTENTE",
        items: { create: resultat.lignes },
      },
    });

    // Aucune notification à ce stade : la commande n'est pas payée.
    return res.status(201).json({
      reference: commande.reference,
      total: commande.total,
      feeAmount: commande.feeAmount,
    });
  } catch (err) {
    logger.error("Erreur creerCommandeReparation", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Crée une demande de diagnostic (pas de réparation choisie : le client ne
// sait pas encore ce qui cloche).
//
// Le réglage `fraisEnlevementReparation` peut valoir 0 (enlèvement gratuit) :
// dans ce cas il n'y a rien à payer, la demande part directement en
// « à récupérer » et les notifications partent tout de suite. Sinon, elle
// reste `EN_ATTENTE` du paiement des frais et seul le widget est renseigné —
// c'est le paiement (lot 2) qui déclenchera les notifications.
async function creerDiagnostic(req, res) {
  try {
    const {
      modelId, problemDescription, clientName, clientWhatsapp, clientEmail,
      city, neighborhood, instructions, pickupSlot, pickupLat, pickupLng, zoneName,
    } = req.body || {};

    const contact = validerContact({ clientName, clientWhatsapp, city });
    if (!contact.ok) return res.status(400).json({ error: contact.erreur });
    const zoneCouverte = await validerZoneCouverte(city);
    if (!zoneCouverte.ok) return res.status(400).json({ error: zoneCouverte.erreur });
    // Une description vide ne permet aucune analyse au technicien.
    if (String(problemDescription || "").trim().length < 10) {
      return res.status(400).json({ error: "Merci de décrire la panne (10 caractères minimum)" });
    }

    const modele = await trouverModeleActif(modelId);
    if (!modele) return res.status(400).json({ error: "Modèle introuvable" });

    const frais = await lireFraisEnlevement();
    // Frais nuls : il n'y a rien à payer, la demande part directement en
    // « à récupérer ». Le parcours doit fonctionner dans les DEUX cas — c'est la
    // conséquence directe du réglage à 0 autorisé.
    const statut = frais > 0 ? "EN_ATTENTE" : "A_RECUPERER";

    const diagnostic = await prisma.repairOrder.create({
      data: {
        reference: generateRepairRef(),
        kind: "DIAGNOSTIC",
        clientName: String(clientName).trim(),
        clientWhatsapp: String(clientWhatsapp).trim(),
        clientEmail: clientEmail ? String(clientEmail).trim() : null,
        space: modele.family.space,
        familyName: modele.family.name,
        modelName: modele.name,
        problemDescription: String(problemDescription).trim(),
        city: String(city).trim(),
        ...construireChampsEnlevement({ neighborhood, instructions, pickupSlot, pickupLat, pickupLng, zoneName }),
        pickupFee: frais,
        total: frais,
        status: statut,
      },
    });

    if (frais === 0) {
      // Rien à payer : on prévient tout de suite l'admin (panne à préparer) et
      // le client (pas besoin d'attendre un paiement pour voir son appareil
      // enlevé). Le libellé vient de `statuts.js`, seule source des messages
      // envoyés au client à chaque étape.
      await whatsapp.sendNewRepairToAdmin({
        reference: diagnostic.reference,
        kind: "DIAGNOSTIC",
        clientName: diagnostic.clientName,
        clientWhatsapp: diagnostic.clientWhatsapp,
        modelName: diagnostic.modelName,
        total: diagnostic.total,
        problemDescription: diagnostic.problemDescription,
      });
      await whatsapp.sendRepairStatusToClient({
        clientWhatsapp: diagnostic.clientWhatsapp,
        clientName: diagnostic.clientName,
        reference: diagnostic.reference,
        modelName: diagnostic.modelName,
        message: messageClient("A_RECUPERER"),
      });
    }

    return res.status(201).json({
      reference: diagnostic.reference,
      total: diagnostic.total,
      status: diagnostic.status,
    });
  } catch (err) {
    logger.error("Erreur creerDiagnostic", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Envoie un devis WhatsApp indicatif — RIEN n'est enregistré, ni commande ni
// devis. Pas de coupon ici : c'est une estimation envoyée avant toute
// commande, pas un panier qu'on solde.
async function envoyerDevisWhatsapp(req, res) {
  try {
    const { modelId, optionIds, clientName, clientWhatsapp } = req.body || {};
    if (!String(clientWhatsapp || "").trim()) {
      return res.status(400).json({ error: "WhatsApp du client requis" });
    }

    const modele = await trouverModeleActif(modelId);
    if (!modele) return res.status(400).json({ error: "Modèle introuvable" });

    const resolu = await resoudreOptions(modele.id, optionIds);
    if (!resolu.ok) return res.status(400).json({ error: resolu.erreur });

    const resultat = calculerReparation({ options: resolu.options });
    if (!resultat.ok) return res.status(400).json({ error: resultat.erreur });

    await whatsapp.sendRepairQuoteToClient({
      clientWhatsapp: String(clientWhatsapp).trim(),
      clientName: clientName ? String(clientName).trim() : "",
      modelName: modele.name,
      lignes: resultat.lignes,
      total: resultat.total,
    });

    return res.json({ message: "Devis envoyé" });
  } catch (err) {
    logger.error("Erreur envoyerDevisWhatsapp", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Suivi public par référence.
//
// La référence circule par WhatsApp et peut être lue par-dessus une épaule. On
// rend donc UNIQUEMENT ce que le client sait déjà, énuméré champ par champ.
// Rendre la ligne entière exposerait son adresse et ses coordonnées GPS — c'est
// exactement le risque qui a fait passer les références de 5 chiffres à 8
// caractères tirés au sort.
async function suivreReparation(req, res) {
  try {
    const commande = await prisma.repairOrder.findUnique({
      where: { reference: String(req.params.reference || "").toUpperCase() },
      select: {
        reference: true, kind: true, status: true, returnDate: true,
        modelName: true, familyName: true, total: true, createdAt: true,
        items: { select: { jobName: true, optionLabel: true, unitPrice: true } },
      },
    });
    if (!commande) return res.status(404).json({ error: "Référence introuvable" });
    return res.json({
      reparation: { ...commande, statutLisible: libelleStatut(commande.status) },
    });
  } catch (err) {
    logger.error("Erreur suivreReparation", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Paiement — confirmation depuis le webhook FedaPay ────────────────────────

// Appelée par `payments.controller.js` une fois le paiement confirmé (jamais
// depuis une route directement). Deux passages de statut dans le même appel :
// `PAYEE` d'abord — muet côté client (cf. `statuts.js`, il vient de payer sous
// ses propres yeux) — puis aussitôt `A_RECUPERER`, qui porte la première
// notification. L'ordre importe : la commande est marquée payée, le coupon
// consommé et la fiche client mise à jour AVANT toute notification, pour
// qu'un message ne puisse jamais annoncer un état que la base ne reflète pas
// encore.
async function confirmerReparationApresPaiement(repairOrderId) {
  const payee = await prisma.repairOrder.update({
    where: { id: repairOrderId },
    data: { status: "PAYEE" },
  });

  if (payee.couponCode) {
    await incrementUsed(payee.couponCode);
  }

  // Fiche CRM : mêmes règles que pour une commande produit (points, palier),
  // alimentées ici par le total réellement payé pour la réparation.
  await upsertClient(payee.clientWhatsapp, payee.clientName, payee.city, payee.total);

  await whatsapp.sendNewRepairToAdmin({
    reference: payee.reference,
    kind: payee.kind,
    clientName: payee.clientName,
    clientWhatsapp: payee.clientWhatsapp,
    modelName: payee.modelName,
    total: payee.total,
    problemDescription: payee.problemDescription,
  });

  const aRecuperer = await prisma.repairOrder.update({
    where: { id: repairOrderId },
    data: { status: "A_RECUPERER" },
  });

  await whatsapp.sendRepairStatusToClient({
    clientWhatsapp: aRecuperer.clientWhatsapp,
    clientName: aRecuperer.clientName,
    reference: aRecuperer.reference,
    modelName: aRecuperer.modelName,
    message: messageClient("A_RECUPERER"),
  });
}

// ── Admin — gestion du catalogue ─────────────────────────────────────────────

// Attribue un slug libre.
//
// Deux marques vendent légitimement un « A15 ». Suffixer vaut mieux que de
// laisser PostgreSQL rejeter l'écriture sur une contrainte d'unicité, dont le
// message ne dit rien à l'administrateur.
async function slugLibre(modele, nom) {
  const base = slugifier(nom);
  const pris = await modele.findMany({
    where: { slug: { startsWith: base } },
    select: { slug: true },
  });
  return slugDisponible(base, pris.map((p) => p.slug));
}

async function creerFamille(req, res) {
  try {
    const { space, name, sortOrder } = req.body || {};
    if (!ESPACES.includes(String(space))) {
      return res.status(400).json({ error: "Espace inconnu" });
    }
    if (!String(name || "").trim()) {
      return res.status(400).json({ error: "Nom requis" });
    }
    const famille = await prisma.repairFamily.create({
      data: {
        space,
        name: String(name).trim(),
        slug: await slugLibre(prisma.repairFamily, name),
        sortOrder: Number(sortOrder) || 0,
      },
    });
    return res.status(201).json({ famille });
  } catch (err) {
    logger.error("Erreur creerFamille", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function modifierFamille(req, res) {
  try {
    const data = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim();
    if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || 0;
    if (req.body.active !== undefined) data.active = !!req.body.active;
    const famille = await prisma.repairFamily.update({ where: { id: req.params.id }, data });
    return res.json({ famille });
  } catch (err) {
    logger.error("Erreur modifierFamille", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// La suppression emporte les niveaux inférieurs (cascade en base) et ne peut
// PAS casser l'historique : les lignes de commande ne pointent pas sur le
// catalogue, elles en ont recopié les libellés et les prix.
async function supprimerFamille(req, res) {
  try {
    await prisma.repairFamily.delete({ where: { id: req.params.id } });
    return res.json({ message: "Famille supprimée" });
  } catch (err) {
    logger.error("Erreur supprimerFamille", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function creerModele(req, res) {
  try {
    const { familyId, name, sortOrder } = req.body || {};
    if (!String(familyId || "").trim()) {
      return res.status(400).json({ error: "Famille requise" });
    }
    // Vérifié explicitement, comme dans `creerReparation` : sans ce contrôle,
    // un `familyId` absent ou faux ne remonterait qu'au moment de l'écriture,
    // sous forme d'erreur de clé étrangère Prisma en anglais — illisible pour
    // l'administrateur.
    const famille = await prisma.repairFamily.findUnique({ where: { id: String(familyId) } });
    if (!famille) return res.status(400).json({ error: "Famille introuvable" });
    if (!String(name || "").trim()) {
      return res.status(400).json({ error: "Nom requis" });
    }
    const modele = await prisma.repairModel.create({
      data: {
        familyId: famille.id,
        name: String(name).trim(),
        slug: await slugLibre(prisma.repairModel, name),
        sortOrder: Number(sortOrder) || 0,
      },
    });
    return res.status(201).json({ modele });
  } catch (err) {
    logger.error("Erreur creerModele", { err: err.message });
    return res.status(400).json({ error: "Impossible de créer ce modèle" });
  }
}

async function modifierModele(req, res) {
  try {
    const data = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim();
    if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || 0;
    if (req.body.active !== undefined) data.active = !!req.body.active;
    const modele = await prisma.repairModel.update({ where: { id: req.params.id }, data });
    return res.json({ modele });
  } catch (err) {
    logger.error("Erreur modifierModele", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function supprimerModele(req, res) {
  try {
    await prisma.repairModel.delete({ where: { id: req.params.id } });
    return res.json({ message: "Modèle supprimé" });
  } catch (err) {
    logger.error("Erreur supprimerModele", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// Une réparation naît TOUJOURS avec au moins une option, sinon elle n'a pas de
// prix et le catalogue public l'écarte — l'administrateur la croirait publiée.
// Le libellé « Standard » disparaît de l'écran dès qu'une seconde qualité
// existe : l'administrateur qui n'a qu'un prix ne voit jamais la notion.
async function creerReparation(req, res) {
  try {
    const { modelId, name, delay, price, sortOrder } = req.body || {};
    // Vérifié explicitement : sans ce contrôle, un `modelId` absent ou faux ne
    // remonterait qu'au moment de l'écriture, sous forme d'erreur de clé
    // étrangère Prisma en anglais — illisible pour l'administrateur.
    const modele = String(modelId || "").trim()
      && (await prisma.repairModel.findUnique({ where: { id: String(modelId) } }));
    if (!modele) return res.status(400).json({ error: "Modèle introuvable" });
    if (!String(name || "").trim()) return res.status(400).json({ error: "Nom requis" });
    const prix = Number(price);
    if (!Number.isInteger(prix) || prix < 0) {
      return res.status(400).json({ error: "Prix invalide — un entier en FCFA est attendu" });
    }
    const reparation = await prisma.repairJob.create({
      data: {
        modelId: modele.id,
        name: String(name).trim(),
        delay: delay ? String(delay).trim() : null,
        sortOrder: Number(sortOrder) || 0,
        options: { create: [{ label: "Standard", price: prix, sortOrder: 0 }] },
      },
      include: { options: true },
    });
    return res.status(201).json({ reparation });
  } catch (err) {
    logger.error("Erreur creerReparation", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// Pas de prix ici : le prix vit sur les options (`creerOption`/`modifierOption`),
// jamais sur la réparation elle-même — une réparation à deux qualités de pièce
// n'a pas de prix unique à modifier.
async function modifierReparation(req, res) {
  try {
    const data = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim();
    if (req.body.delay !== undefined) {
      data.delay = req.body.delay ? String(req.body.delay).trim() : null;
    }
    if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || 0;
    if (req.body.active !== undefined) data.active = !!req.body.active;
    const reparation = await prisma.repairJob.update({ where: { id: req.params.id }, data });
    return res.json({ reparation });
  } catch (err) {
    logger.error("Erreur modifierReparation", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function supprimerReparation(req, res) {
  try {
    await prisma.repairJob.delete({ where: { id: req.params.id } });
    return res.json({ message: "Réparation supprimée" });
  } catch (err) {
    logger.error("Erreur supprimerReparation", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// Copie une réparation et ses options vers d'autres modèles.
//
// COPIE, et non partage. L'administrateur veut un même tarif sur plusieurs
// modèles, mais aussi des libellés libres modèle par modèle. Un partage réel
// ferait qu'en changeant le prix de la batterie de l'iPhone 13 on change sans
// le voir celui de l'iPhone 14 — le genre d'écart qui ne lève aucune erreur et
// se découvre chez un client.
async function dupliquerReparation(req, res) {
  try {
    const source = await prisma.repairJob.findUnique({
      where: { id: req.params.id },
      include: { options: true },
    });
    if (!source) return res.status(404).json({ error: "Réparation introuvable" });

    const cibles = Array.isArray(req.body?.modelIds) ? req.body.modelIds : [];
    if (cibles.length === 0) return res.status(400).json({ error: "Aucun modèle cible" });

    // Dédoublonné AVANT de comparer : `findMany({ id: { in: cibles } })`
    // dédoublonne lui-même côté base (deux fois le même id ne rend qu'une
    // ligne), donc comparer sa longueur à `cibles.length` brut ferait échouer
    // à tort un `modelIds` qui contient un doublon légitime.
    const ciblesUniques = [...new Set(cibles)];
    const existants = await prisma.repairModel.findMany({
      where: { id: { in: ciblesUniques } },
      select: { id: true },
    });
    if (existants.length !== ciblesUniques.length) {
      return res.status(400).json({ error: "Un ou plusieurs modèles cibles sont introuvables" });
    }

    let copiees = 0;
    for (const modelId of ciblesUniques) {
      if (modelId === source.modelId) continue;
      await prisma.repairJob.create({
        data: {
          modelId,
          name: source.name,
          delay: source.delay,
          sortOrder: source.sortOrder,
          options: {
            create: source.options.map((o) => ({
              label: o.label, price: o.price, sortOrder: o.sortOrder, active: o.active,
            })),
          },
        },
      });
      copiees += 1;
    }
    return res.json({ message: `Réparation copiée sur ${copiees} modèle(s)`, copiees });
  } catch (err) {
    logger.error("Erreur dupliquerReparation", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function creerOption(req, res) {
  try {
    const { jobId, label, price, sortOrder } = req.body || {};
    if (!String(jobId || "").trim()) {
      return res.status(400).json({ error: "Réparation requise" });
    }
    // Même contrôle que dans `creerReparation`/`creerModele` : un `jobId` faux
    // remonterait sinon en erreur de clé étrangère Prisma brute, en anglais,
    // jusqu'à l'administrateur.
    const job = await prisma.repairJob.findUnique({ where: { id: String(jobId) } });
    if (!job) return res.status(400).json({ error: "Réparation introuvable" });
    if (!String(label || "").trim()) return res.status(400).json({ error: "Libellé requis" });
    const prix = Number(price);
    if (!Number.isInteger(prix) || prix < 0) {
      return res.status(400).json({ error: "Prix invalide — un entier en FCFA est attendu" });
    }
    const option = await prisma.repairOption.create({
      data: {
        jobId: job.id,
        label: String(label).trim(),
        price: prix,
        sortOrder: Number(sortOrder) || 0,
      },
    });
    return res.status(201).json({ option });
  } catch (err) {
    logger.error("Erreur creerOption", { err: err.message });
    return res.status(400).json({ error: "Impossible de créer cette option" });
  }
}

async function modifierOption(req, res) {
  try {
    const data = {};
    if (req.body.label !== undefined) data.label = String(req.body.label).trim();
    // Le prix n'est validé que s'il est fourni : une modification qui ne touche
    // qu'au libellé ou au tri ne doit pas exiger de renvoyer le prix.
    if (req.body.price !== undefined) {
      const prix = Number(req.body.price);
      if (!Number.isInteger(prix) || prix < 0) {
        return res.status(400).json({ error: "Prix invalide — un entier en FCFA est attendu" });
      }
      data.price = prix;
    }
    if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || 0;
    if (req.body.active !== undefined) data.active = !!req.body.active;
    const option = await prisma.repairOption.update({ where: { id: req.params.id }, data });
    return res.json({ option });
  } catch (err) {
    logger.error("Erreur modifierOption", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function supprimerOption(req, res) {
  try {
    await prisma.repairOption.delete({ where: { id: req.params.id } });
    return res.json({ message: "Option supprimée" });
  } catch (err) {
    logger.error("Erreur supprimerOption", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// L'écran de gestion doit montrer l'inactif autant que l'actif : c'est là que
// l'administrateur va le réactiver ou vérifier ce qu'il a coupé. Contrairement
// au catalogue public (`getFamilles`, `getModele`…), aucun filtre `active` ici.
async function getCatalogueAdmin(req, res) {
  try {
    const espace = String(req.query.espace || "").toUpperCase();
    if (!ESPACES.includes(espace)) {
      return res.status(400).json({ error: "Espace inconnu" });
    }
    const familles = await prisma.repairFamily.findMany({
      where: { space: espace },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        models: {
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          include: {
            jobs: {
              orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
              include: {
                options: { orderBy: [{ sortOrder: "asc" }, { price: "asc" }] },
              },
            },
          },
        },
      },
    });
    return res.json({ familles });
  } catch (err) {
    logger.error("Erreur getCatalogueAdmin", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Admin — panel des demandes ───────────────────────────────────────────────

// Liste paginée, filtrable par nature (réparation/diagnostic) et par statut.
// Mêmes conventions de pagination que `getAllOrders`
// (subscriptions.controller.js) : `page`/`limit` en query, `total` renvoyé à
// côté pour que le panel construise sa pagination sans requête séparée.
async function listerDemandes(req, res) {
  try {
    const { kind, status, page = 1, limit = 20 } = req.query;
    const where = {};
    if (kind) where.kind = String(kind);
    if (status) where.status = String(status);

    const [demandes, total] = await Promise.all([
      prisma.repairOrder.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: "desc" },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.repairOrder.count({ where }),
    ]);
    return res.json({ demandes, total });
  } catch (err) {
    logger.error("Erreur listerDemandes", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// L'administrateur fait avancer la réparation ; chaque passage prévient le
// client, sauf le paiement (`messageClient` rend `null` pour PAYEE).
async function changerStatut(req, res) {
  try {
    const commande = await prisma.repairOrder.findUnique({ where: { id: req.params.id } });
    if (!commande) return res.status(404).json({ error: "Demande introuvable" });

    const vers = String(req.body?.status || "");
    // L'annulation ne passe QUE par `annulerDemande` : elle seule enregistre
    // `cancelledRetained` (le montant retenu sur le remboursement). Si cette
    // route générique laissait passer `ANNULEE`, il existerait deux chemins
    // vers le même état final et l'un des deux perdrait silencieusement cette
    // trace — l'écart ne se verrait que le jour où un client conteste le
    // remboursement. `transitionAutorisee` continue d'autoriser `ANNULEE`
    // depuis n'importe quel état (c'est la règle du cycle de vie, portée par
    // elle et réutilisée par `annulerDemande`) : c'est cette route générique
    // qui se ferme ici, pas la règle elle-même.
    if (vers === "ANNULEE") {
      return res.status(400).json({
        error: "Pour annuler, utilisez la route d'annulation dédiée — elle seule enregistre le montant retenu",
      });
    }
    // Même raisonnement pour PAYEE : `EN_ATTENTE → PAYEE` ne vient QUE du
    // webhook FedaPay (`confirmerReparationApresPaiement`), qui seul consomme
    // le coupon, alimente `ClientTracker` et envoie l'alerte admin. Laisser
    // cette route générique l'accepter permettrait de marquer une demande
    // payée sans qu'un franc soit entré — et de compter ce montant au chiffre
    // d'affaires (`STATUTS_REPARATION_PAYEES` inclut PAYEE).
    if (vers === "PAYEE") {
      return res.status(400).json({
        error: "Le passage à \"Payée\" est déclenché par le paiement (webhook FedaPay), pas par cette route",
      });
    }
    const verdict = transitionAutorisee(commande.status, vers);
    if (!verdict.ok) return res.status(409).json({ error: verdict.erreur });

    const maj = await prisma.repairOrder.update({
      where: { id: commande.id },
      data: { status: vers },
    });

    const texte = messageClient(vers);
    if (texte) {
      await whatsapp.sendRepairStatusToClient({
        clientWhatsapp: maj.clientWhatsapp,
        clientName: maj.clientName,
        reference: maj.reference,
        modelName: maj.modelName,
        message: texte,
        returnDate: maj.returnDate,
      });
    }
    return res.json({ commande: maj });
  } catch (err) {
    logger.error("Erreur changerStatut", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// Une commande `RENDUE` ou `ANNULEE` est une affaire close : ni sa date de
// retour ni ses lignes ne doivent plus bouger après coup. Extraite ici pour
// servir identiquement à `definirDateRetour` ET `ajouterLigneHorsCatalogue`
// — le même refus, au même message, plutôt que deux copies qui pourraient
// diverger silencieusement à la prochaine modification de l'une des deux.
function messageSiCommandeClose(statut) {
  if (statut === "RENDUE" || statut === "ANNULEE") {
    return `Une réparation ${libelleStatut(statut).toLowerCase()} est close`;
  }
  return null;
}

// La date de retour est purement informative : ni notification, ni recalcul
// de montant. Elle n'est utilisée qu'en affichage, dans le prochain message
// que `changerStatut` enverra au client (`sendRepairStatusToClient` l'inclut
// déjà si elle est renseignée). `null` efface une date saisie par erreur.
async function definirDateRetour(req, res) {
  try {
    const commande = await prisma.repairOrder.findUnique({ where: { id: req.params.id } });
    if (!commande) return res.status(404).json({ error: "Demande introuvable" });
    const erreurClose = messageSiCommandeClose(commande.status);
    if (erreurClose) return res.status(409).json({ error: erreurClose });

    const brute = req.body?.returnDate;
    let returnDate = null;
    if (brute !== null && brute !== undefined && brute !== "") {
      const date = new Date(brute);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ error: "Date de retour invalide" });
      }
      returnDate = date;
    }

    const maj = await prisma.repairOrder.update({
      where: { id: commande.id },
      data: { returnDate },
    });
    return res.json({ commande: maj });
  } catch (err) {
    logger.error("Erreur definirDateRetour", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// L'administrateur ajoute une prestation qui ne figure pas au catalogue
// (pièce imprévue, panne annexe découverte en atelier). Comme sur le
// catalogue (`creerOption`), le prix est un entier FCFA saisi à la main —
// mais ici sans validation de coupon ni d'option : il n'y a rien à retrouver
// en base, juste un montant à enregistrer.
//
// `subtotal`, `total` ET `feeAmount` bougent TOUS LES TROIS ensemble : les
// frais de service sont un pourcentage du total (même formule que dans
// `calculerReparation`), donc toute ligne ajoutée après coup qui change le
// total doit aussi faire évoluer les frais — sinon ce qu'on retient au
// client diverge silencieusement de ce qu'on lui facture réellement.
// `discount` n'est volontairement pas retouché : la remise a été fixée à la
// création de la commande, une ligne ajoutée après coup ne doit ni l'annuler
// ni la faire grossir. `pickupFee`, en revanche, DOIT être réintégré : sur un
// diagnostic, il porte les frais d'enlèvement déjà encaissés
// (`creerDiagnostic`) — l'omettre les efface de la commande, du suivi public
// et des statistiques dès qu'une ligne est ajoutée.
//
// Refusée dès que la commande n'est plus `EN_ATTENTE` — et pas seulement sur
// `RENDUE`/`ANNULEE` : au-delà, la commande a déjà été payée
// (`STATUTS_REPARATION_PAYEES` couvre tout le reste du cycle), et
// `Payment.amount` a été figé sur ce total. Le seul usage légitime — chiffrer
// une réparation issue d'un diagnostic — se fait toujours en `EN_ATTENTE`.
async function ajouterLigneHorsCatalogue(req, res) {
  try {
    const commande = await prisma.repairOrder.findUnique({ where: { id: req.params.id } });
    if (!commande) return res.status(404).json({ error: "Demande introuvable" });
    if (commande.status !== "EN_ATTENTE") {
      return res.status(409).json({
        error: "Impossible d'ajouter une ligne : cette commande a déjà été payée (ou est close), son total ne peut plus bouger",
      });
    }

    const { jobName, optionLabel, price, delay } = req.body || {};
    if (!String(jobName || "").trim()) {
      return res.status(400).json({ error: "Nom de la réparation requis" });
    }
    if (!String(optionLabel || "").trim()) {
      return res.status(400).json({ error: "Libellé requis" });
    }
    const prix = Number(price);
    if (!Number.isInteger(prix) || prix < 0) {
      return res.status(400).json({ error: "Prix invalide — un entier en FCFA est attendu" });
    }
    // Même arrondi, au même endroit, que `calculerReparation` — l'arrondir
    // ailleurs ferait diverger d'un franc le montant retenu et celui affiché.
    const tauxFrais = await lireTauxFrais();

    // Création de la ligne et recalcul du total dans UNE SEULE transaction :
    // deux ajouts simultanés sur la même commande lisaient auparavant
    // `commande.items` avant d'écrire, chacun depuis un instantané pris avant
    // l'écriture de l'autre — le second total écrasait le premier et une des
    // deux lignes ajoutées disparaissait du total (bien qu'elle reste en
    // base). Recalculer depuis un agrégat lu APRÈS la création, à l'intérieur
    // de la transaction, ferme cette fenêtre : chaque ajout repart de ce
    // qu'il vient lui-même d'écrire.
    const maj = await prisma.$transaction(async (tx) => {
      await tx.repairOrderItem.create({
        data: {
          orderId: commande.id,
          jobName: String(jobName).trim(),
          optionLabel: String(optionLabel).trim(),
          unitPrice: prix,
          delay: delay ? String(delay).trim() : null,
          horsCatalogue: true,
        },
      });

      const agrege = await tx.repairOrderItem.aggregate({
        where: { orderId: commande.id },
        _sum: { unitPrice: true },
      });
      const subtotal = agrege._sum.unitPrice || 0;
      const total = subtotal - commande.discount + commande.pickupFee;
      const feeAmount = Math.round(total * tauxFrais);

      return tx.repairOrder.update({
        where: { id: commande.id },
        data: { subtotal, total, feeAmount },
        include: { items: true },
      });
    });

    return res.status(201).json({ commande: maj });
  } catch (err) {
    logger.error("Erreur ajouterLigneHorsCatalogue", { err: err.message });
    return res.status(400).json({ error: "Impossible d'ajouter cette ligne" });
  }
}

// Le diagnostic n'a payé que l'enlèvement. La réparation chiffrée est une
// NOUVELLE commande, rattachée par `parentId`.
//
// Deux commandes plutôt qu'un second paiement sur la même ligne : `Payment`
// impose un paiement par commande, contrainte partagée par tout le site.
// L'appareil étant déjà chez nous, aucun frais et aucune adresse ne sont
// redemandés — ils sont recopiés du diagnostic.
async function ouvrirReparationDepuisDiagnostic(req, res) {
  try {
    const source = await prisma.repairOrder.findUnique({ where: { id: req.params.id } });
    if (!source) return res.status(404).json({ error: "Demande introuvable" });
    if (source.kind !== "DIAGNOSTIC") {
      return res.status(400).json({ error: "Seul un diagnostic peut ouvrir une réparation" });
    }

    // Un diagnostic ne peut donner qu'UNE réparation : une seconde ouverture
    // dupliquerait la prise en charge du même appareil.
    const dejaOuverte = await prisma.repairOrder.findFirst({
      where: { parentId: source.id, kind: "REPARATION" },
      select: { id: true },
    });
    if (dejaOuverte) {
      return res.status(409).json({ error: "Ce diagnostic a déjà donné lieu à une réparation" });
    }

    const reparation = await prisma.repairOrder.create({
      data: {
        reference: generateRepairRef(),
        kind: "REPARATION",
        parentId: source.id,
        // Client, appareil et adresse recopiés tels quels : ce sont des
        // instantanés (même logique que sur `creerCommandeReparation`), pas
        // des références vivantes vers le diagnostic.
        clientName: source.clientName,
        clientWhatsapp: source.clientWhatsapp,
        clientEmail: source.clientEmail,
        space: source.space,
        familyName: source.familyName,
        modelName: source.modelName,
        city: source.city,
        neighborhood: source.neighborhood,
        instructions: source.instructions,
        pickupSlot: source.pickupSlot,
        pickupLat: source.pickupLat,
        pickupLng: source.pickupLng,
        zoneName: source.zoneName,
        // Aucun frais, aucune ligne : l'appareil est déjà chez nous et
        // l'administrateur chiffrera la réparation à la main via
        // `ajouterLigneHorsCatalogue` (ou en dupliquant depuis le catalogue).
        subtotal: 0,
        discount: 0,
        pickupFee: 0,
        feeAmount: 0,
        total: 0,
        status: "EN_ATTENTE",
      },
    });

    return res.status(201).json({ commande: reparation });
  } catch (err) {
    logger.error("Erreur ouvrirReparationDepuisDiagnostic", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// Un appareil se révèle irréparable, ou le client renonce : la demande se
// clôt sans traverser les étapes suivantes. `cancelledRetained` documente ce
// qui reste dû malgré l'annulation (typiquement le déplacement déjà engagé) ;
// il est pré-rempli depuis le réglage `fraisEnlevementReparation` mais reste
// surchageable au cas par cas (déplacement plus coûteux, geste commercial…).
//
// Le remboursement lui-même — quand il y a lieu — reste MANUEL dans le
// tableau de bord FedaPay : l'automatiser est un chantier à part entière
// (choix du moyen, délais, échecs partiels à gérer), et le faire à moitié
// ici serait pire que de ne pas le faire du tout.
async function annulerDemande(req, res) {
  try {
    const commande = await prisma.repairOrder.findUnique({ where: { id: req.params.id } });
    if (!commande) return res.status(404).json({ error: "Demande introuvable" });

    const verdict = transitionAutorisee(commande.status, "ANNULEE");
    if (!verdict.ok) return res.status(409).json({ error: verdict.erreur });

    const brut = req.body?.cancelledRetained;
    const retenu =
      brut !== undefined && brut !== null && brut !== "" ? Number(brut) : await lireFraisEnlevement();
    if (!Number.isInteger(retenu) || retenu < 0) {
      return res.status(400).json({ error: "Montant retenu invalide — un entier en FCFA est attendu" });
    }

    const maj = await prisma.repairOrder.update({
      where: { id: commande.id },
      data: { status: "ANNULEE", cancelledRetained: retenu },
    });

    await whatsapp.sendRepairStatusToClient({
      clientWhatsapp: maj.clientWhatsapp,
      clientName: maj.clientName,
      reference: maj.reference,
      modelName: maj.modelName,
      message: messageClient("ANNULEE"),
      returnDate: maj.returnDate,
    });

    return res.json({ commande: maj });
  } catch (err) {
    logger.error("Erreur annulerDemande", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

module.exports = {
  ESPACES,
  getFamilles,
  getModelesDeFamille,
  getModele,
  rechercherModeles,
  creerCommandeReparation,
  creerDiagnostic,
  envoyerDevisWhatsapp,
  suivreReparation,
  confirmerReparationApresPaiement,
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
};
