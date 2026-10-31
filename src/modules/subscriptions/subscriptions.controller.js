const crypto = require("crypto");
const prisma = require("../../services/prisma");
const whatsapp = require("../../services/whatsapp");
const emailSvc = require("../../services/email");
const logger = require("../../utils/logger");
const { encrypt, decrypt } = require("../../utils/crypto");
const { moisAchetes, dateExpiration } = require("../../../workers/subscriptionExpiry");
const { lienValide, statutApresEnvoi } = require("./linkPool");
const {
  revendiquerPlace,
  filtreActive,
  estActive,
  synchroniserMiroirProfil,
} = require("./occupancy");
const { ouvrirDemandes, journalDemandes } = require("./demandeCodeStore");
const {
  estAVie,
  libelleDuree,
  periodesAutorisees,
  normaliserDuree,
} = require("./duree");
const {
  verifierPlacement,
  verifierSuppression,
  normaliserDateFin,
  forceDemandee,
  resumeSuppression,
  validerClientHorsSite,
} = require("./administration");

// ── PUBLIC ────────────────────────────────────────────────────────────────────

async function getServices(req, res) {
  try {
    const [services, ordreEnregistre] = await Promise.all([
      prisma.subscriptionService.findMany({
        where: { available: true },
        include: { plans: { orderBy: { price: "asc" } } },
        orderBy: { name: "asc" },
      }),
      prisma.setting.findUnique({ where: { key: "subscriptionCategoryOrder" } }),
    ]);
    return res.json({ services, categoryOrder: lireOrdreCategories(ordreEnregistre?.value) });
  } catch (err) {
    logger.error("Erreur getServices", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

const ORDRE_CATEGORIES_PAR_DEFAUT = ["family", "link_access"];
function lireOrdreCategories(value) {
  try {
    const ordre = JSON.parse(value);
    if (
      Array.isArray(ordre) &&
      ordre.length === 2 &&
      new Set(ordre).size === 2 &&
      ordre.every((c) => ORDRE_CATEGORIES_PAR_DEFAUT.includes(c))
    ) return ordre;
  } catch {
    // Utilise l'ordre par défaut avant la première configuration.
  }
  return ORDRE_CATEGORIES_PAR_DEFAUT;
}

async function updateCategoryOrder(req, res) {
  const { categoryOrder } = req.body || {};
  if (
    !Array.isArray(categoryOrder) ||
    categoryOrder.length !== 2 ||
    new Set(categoryOrder).size !== 2 ||
    !categoryOrder.every((c) => ORDRE_CATEGORIES_PAR_DEFAUT.includes(c))
  ) {
    return res.status(400).json({ error: "Ordre des catégories invalide" });
  }
  try {
    const value = JSON.stringify(categoryOrder);
    await prisma.setting.upsert({
      where: { key: "subscriptionCategoryOrder" },
      create: { key: "subscriptionCategoryOrder", value },
      update: { value },
    });
    return res.json({ categoryOrder });
  } catch (err) {
    logger.error("Erreur updateCategoryOrder", { err: err.message });
    return res.status(500).json({ error: "Impossible d'enregistrer l'ordre des catégories" });
  }
}

async function getServiceBySlug(req, res) {
  try {
    const service = await prisma.subscriptionService.findUnique({
      where: { slug: req.params.slug },
      include: { plans: { orderBy: { price: "asc" } } },
    });
    if (!service) return res.status(404).json({ error: "Service introuvable" });
    return res.json({ service });
  } catch (err) {
    logger.error("Erreur getServiceBySlug", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Créer une commande abonnement (avant paiement) ────────────────────────────
// Route publique, sans authentification : le montant ne doit JAMAIS venir du
// client (c'était la faille — des commandes à 100/150 F ont été enregistrées
// en base alors que les formules valent plusieurs milliers). Le client ne
// déclare que le nombre de périodes achetées ; le serveur calcule le prix à
// partir du plan.
async function createOrder(req, res) {
  try {
    const {
      serviceId,
      planId,
      clientName,
      clientWhatsapp,
      clientEmail,
      isGift,
      giftName,
      giftWhatsapp,
    } = req.body;
    if (!serviceId || !planId || !clientName || !clientWhatsapp) {
      return res.status(400).json({ error: "Données manquantes" });
    }
    if (isGift && !giftWhatsapp) {
      return res.status(400).json({ error: "giftWhatsapp requis pour un cadeau" });
    }

    const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) return res.status(400).json({ error: "Formule introuvable" });

    // Même principe que pour le montant : le service est celui auquel la
    // formule appartient réellement, pas celui que le client annonce. Sans ce
    // contrôle, un appel pouvait rattacher une commande au service d'un autre
    // (formule Netflix enregistrée sous Spotify), ce qui fausse le panel, les
    // rappels et le routage des codes OTP.
    if (serviceId !== plan.serviceId) {
      return res.status(400).json({ error: "La formule n'appartient pas à ce service" });
    }

    // Le montant vient du serveur, jamais du client : `months` indique combien
    // de périodes sont achetées, le prix en découle.
    //
    // Une formule à vie n'en autorise qu'UNE. « Deux fois à vie » ne veut rien
    // dire, et sans ce plafond le client paierait double pour exactement le
    // même accès — le panel n'affiche pas le sélecteur, mais l'API est
    // atteignable sans lui.
    const periodes = Number(req.body.months ?? 1);
    if (!Number.isInteger(periodes) || periodes < 1 || periodes > periodesAutorisees(plan)) {
      return res.status(400).json({
        error: estAVie(plan)
          ? "Une formule à vie ne s'achète qu'une fois"
          : "Durée invalide",
      });
    }
    const montant = plan.price * periodes;

    // Date d'expiration déduite du prix payé pour cette commande — jamais
    // inventée. `montant` vaut ici exactement `plan.price * periodes`, donc
    // `moisAchetes` retombera toujours juste ; on la réutilise telle quelle
    // (tâche 3) plutôt que de redévelopper ce contrôle.
    //
    // Une formule à vie n'a PAS de date, et c'est voulu — à ne pas confondre
    // avec le `null` du cas d'échec ci-dessous, qui signale une durée qu'on
    // n'a pas su calculer. Les deux se ressemblent en base ; ce qui les
    // sépare est la formule, que `isOrderActive` consulte pour trancher.
    let expiresAt = null;
    if (!estAVie(plan)) {
      const duree = moisAchetes({
        unitPrice: montant,
        planPrice: plan.price,
        planDuration: plan.duration,
      });
      if (duree.ok) {
        expiresAt = dateExpiration({ debut: new Date(), mois: duree.mois });
      } else {
        // Comme dans assignSubscriptionFromOrderItem : sans durée fiable, on ne
        // pose aucune date plutôt que d'en inventer une — l'abonnement ne
        // recevra simplement pas de rappel.
        logger.warn("Durée d'abonnement indéterminable — expiration non enregistrée", {
          planId,
          montant,
          planPrice: plan.price,
          raison: duree.raison,
        });
      }
    }

    const order = await prisma.subscriptionOrder.create({
      data: {
        serviceId,
        planId,
        clientName,
        clientWhatsapp,
        clientEmail: clientEmail || null,
        amount: montant,
        status: "PENDING",
        isGift: !!isGift,
        giftName: isGift ? (giftName || null) : null,
        giftWhatsapp: isGift ? giftWhatsapp : null,
        expiresAt,
      },
    });
    return res.status(201).json({ order });
  } catch (err) {
    logger.error("Erreur création commande abonnement", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Réserve un lien de la réserve d'une formule.
//
// La garde `status: "disponible"` DANS le `where` de l'updateMany est ce qui
// rend l'opération sûre : deux paiements simultanés lisent la même liste de
// candidats, mais seule la première écriture rend `count === 1`. La seconde
// passe au candidat suivant. Ne pas retirer cette garde.
async function claimLinkAccessLink(planId, currentOrderId = null) {
  const candidates = await prisma.linkAccessLink.findMany({
    where: { planId, status: "disponible" },
    orderBy: { createdAt: "asc" },
  });
  for (const candidate of candidates) {
    const result = await prisma.linkAccessLink.updateMany({
      where: { id: candidate.id, status: "disponible" },
      data: {
        status: "envoyé",
        claimedAt: new Date(),
        ...(currentOrderId ? { currentOrderId } : {}),
      },
    });
    if (result.count === 1) return candidate;
  }
  return null;
}

// ── Déchiffrement des identifiants d'un compte famille ───────────────────────
// Le motif répété partout dans ce fichier était :
//
//   let password = account.passwordEncrypted;
//   try { password = decrypt(account.passwordEncrypted); } catch {}
//
// Autrement dit : si le déchiffrement échoue — clé AES changée, valeur
// corrompue — on envoyait au client le TEXTE CHIFFRÉ en guise de mot de passe
// (« a3f2…:9b8c… »), et les journaux annonçaient un envoi réussi. Un échec de
// déchiffrement est un incident, pas une valeur de repli : on le signale et on
// laisse le mot de passe à null pour que l'appelant le voie.
// Depuis la tâche 6, un profil créé par le nouvel endpoint (`ajouterProfil`)
// ne porte plus d'identifiants propres : `email` et `passwordEncrypted` y
// valent `""` (colonnes héritées, toujours obligatoires), et le vrai secret
// vit sur `StreamingAccount`, via `accountId`. On retombe donc sur le compte
// quand le profil n'en a pas — c'est le même repli pour les deux colonnes,
// il n'y a qu'une seule logique de déchiffrement à ne pas dupliquer.
// Les appelants doivent charger la relation `account` (au moins
// `email`/`passwordEncrypted`) pour que ce repli fonctionne ; sans elle, un
// profil hérité continue de fonctionner tel quel.
function dechiffrerIdentifiants(account) {
  let password = null;
  let erreur = null;
  const email = account.email || account.account?.email || null;
  const secretChiffre = account.passwordEncrypted || account.account?.passwordEncrypted;
  try {
    password = decrypt(secretChiffre);
  } catch (err) {
    erreur = err.message;
    logger.error(
      "Déchiffrement du mot de passe impossible — vérifier AES_SECRET_KEY",
      { compte: email, profil: account.profile, err: err.message },
    );
  }
  return {
    email,
    password,
    profile: account.profile || null,
    profilePassword: account.profilePassword || null,
    erreurDechiffrement: erreur,
  };
}

// ── Attribution automatique après paiement ────────────────────────────────────
async function assignSubscriptionAfterPayment(subOrderId) {
  const subOrder = await prisma.subscriptionOrder.findUnique({
    where: { id: subOrderId },
    include: { service: true },
  });
  if (!subOrder) {
    logger.warn("Commande abonnement introuvable", { subOrderId });
    return;
  }

  const plan = await prisma.subscriptionPlan.findUnique({
    where: { id: subOrder.planId },
  });
  if (!plan) {
    logger.warn("Plan abonnement introuvable", { planId: subOrder.planId });
    return;
  }

  const serviceCategory = subOrder.service.category;

  if (serviceCategory === "family") {
    const { occupation, profil, compte, raison } = await revendiquerPlace({
      serviceId: subOrder.serviceId,
      planId: subOrder.planId,
      order: subOrder,
      occupantName: subOrder.isGift && subOrder.giftName ? subOrder.giftName : subOrder.clientName,
      occupantWhatsapp:
        subOrder.isGift && subOrder.giftWhatsapp ? subOrder.giftWhatsapp : subOrder.clientWhatsapp,
      endsAt: subOrder.expiresAt,
    });

    if (!occupation) {
      // Trois causes distinctes, trois remèdes distincts : ajouter un profil,
      // acheter un compte, ou — cas le plus grave, souvent confondu avec
      // « stock épuisé » — aucun profil candidat n'existe du tout parce
      // qu'aucun compte n'est configuré ou que la reprise de données n'a pas
      // tourné. L'alerte doit nommer la bonne cause, sinon l'admin cherche des
      // places à ajouter alors que rien n'est branché.
      logger.warn("Aucune place disponible", { planId: subOrder.planId, raison });
      if (raison === "aucun-profil") {
        await whatsapp.sendConfigurationAbonnementManquanteAlert({
          serviceName: subOrder.service.name,
          clientName: subOrder.clientName,
          clientWhatsapp: subOrder.clientWhatsapp,
        });
        return;
      }
      await whatsapp.sendStockEpuiseAlert({
        serviceName: subOrder.service.name,
        clientName: subOrder.clientName,
        clientWhatsapp: subOrder.clientWhatsapp,
        raison:
          raison === "plafond-flux"
            ? "Le compte a atteint son plafond de flux simultanés — ajouter un compte."
            : "Tous les profils sont pleins — ajouter un profil ou augmenter une capacité.",
      });
      return;
    }

    const account = { ...profil, email: compte.email, passwordEncrypted: compte.passwordEncrypted };

    // La place vient d'être prise : l'occupation est enregistrée, sa
    // transaction commitée. On acte la commande DANS LA FOULÉE, avant tout
    // envoi.
    //
    // L'ordre inverse — envoyer puis confirmer — laissait un état mixte à la
    // moindre erreur d'envoi : compte brûlé, paiement encaissé, commande
    // toujours PENDING, client sans rien et personne d'averti, puisque
    // l'exception était avalée par le try/catch du webhook. Même principe que
    // `workers/subscriptionExpiry.js` : on revendique avant d'envoyer.
    await prisma.subscriptionOrder.update({
      where: { id: subOrderId },
      data: { status: "CONFIRMED" },
    });

    const credentials = dechiffrerIdentifiants(account);

    const isGift = !!(subOrder.isGift && subOrder.giftWhatsapp);
    const recipientWhatsapp = isGift ? subOrder.giftWhatsapp : subOrder.clientWhatsapp;
    const recipientName = isGift && subOrder.giftName ? subOrder.giftName : subOrder.clientName;

    const credSent = await whatsapp.sendSubscriptionCredentials({
      clientWhatsapp: recipientWhatsapp,
      clientName: recipientName,
      serviceName: subOrder.service.name,
      credentials,
    });

    // Fallback cadeau : destinataire injoignable → acheteur
    if (isGift && !credSent) {
      logger.warn("Credentials cadeau — destinataire injoignable, fallback acheteur", {
        recipientWhatsapp,
        buyerWhatsapp: subOrder.clientWhatsapp,
      });
      await whatsapp.sendSubscriptionCredentialsFallback({
        clientWhatsapp: subOrder.clientWhatsapp,
        clientName: subOrder.clientName,
        recipientName,
        serviceName: subOrder.service.name,
        credentials,
      });
    }

    await emailSvc.sendSubscriptionCredentials({
      clientEmail: subOrder.clientEmail,
      clientName: subOrder.clientName,
      serviceName: subOrder.service.name,
      serviceSlug: subOrder.service.slug,
      credentials,
    });

    const planDescription = `${plan.label} — ${libelleDuree(plan)}`;

    await whatsapp.sendSubscriptionNotifToAdmin({
      clientName: subOrder.clientName,
      clientWhatsapp: subOrder.clientWhatsapp,
      serviceName: subOrder.service.name,
      planDescription,
      amount: subOrder.amount,
      isGift,
      giftName: isGift ? recipientName : null,
      giftWhatsapp: isGift ? recipientWhatsapp : null,
    });

    logger.info(
      `✅ Abonnement ${subOrder.service.name} attribué à ${subOrder.clientWhatsapp}`,
    );
  } else if (serviceCategory === "link_access") {
    await prisma.linkAccessClient.create({
      data: {
        planId: subOrder.planId,
        name: subOrder.clientName,
        whatsapp: subOrder.clientWhatsapp,
        email: subOrder.clientEmail || null,
        status: "en_attente",
      },
    });

    await prisma.subscriptionOrder.update({
      where: { id: subOrderId },
      data: { status: "CONFIRMED" },
    });

    await whatsapp.sendLinkAccessNotifToAdmin({
      serviceName: subOrder.service.name,
      planDescription: `${plan.label} — ${libelleDuree(plan)}`,
      clientName: subOrder.clientName,
      clientWhatsapp: subOrder.clientWhatsapp,
      amount: subOrder.amount,
    });

    logger.info(`✅ Commande link_access créée — en attente d'action admin`);
  }
}

// ── Attribution depuis un item de commande panier (avec gestion cadeau) ────────
async function assignSubscriptionFromOrderItem({ planId, order }) {
  const plan = await prisma.subscriptionPlan.findUnique({
    where: { id: planId },
    include: { service: true },
  });
  if (!plan) {
    logger.warn("Plan abonnement introuvable pour item panier", { planId });
    return;
  }

  const isGift = !!(order.isGift && order.giftWhatsapp);
  const recipientWhatsapp = isGift ? order.giftWhatsapp : order.guestWhatsapp;
  const recipientName = isGift && order.giftName ? order.giftName : order.guestName;

  const matchingItem = order.items?.find((i) => i.productSlug === `abonnement-${planId}`);
  const planDescription =
    matchingItem?.productName || `${plan.label} — ${libelleDuree(plan)}`;

  // Date d'expiration calculée à partir du prix unitaire de la ligne de
  // commande — que `buildValidatedItems` a déjà vérifié comme étant un multiple
  // exact du prix du plan. Le montant total, lui, inclut la quantité et les
  // frais : il ne permet pas de retrouver la durée.
  //
  // Le point de départ est `order.createdAt` (date de création de la
  // commande), pas `new Date()` (instant de la confirmation) : deux clients
  // ayant acheté la même formule doivent obtenir la même date d'expiration,
  // qu'ils aient été confirmés en direct ou rattrapés plus tard par
  // `scripts/backfill-expiration.js` ou par le réconciliateur
  // (`workers/orderReconciler.js`) — les deux partent déjà de la date de la
  // commande d'origine. `new Date()` rendait la date sensible au délai de
  // confirmation du paiement (webhook retardé, relance manuelle...), ce qui
  // désynchronisait les clients entre eux pour un même achat.
  //
  // Une formule à vie court-circuite tout ce calcul : aucune date, et c'est
  // voulu. Voir `createOrder` pour ce qui distingue ce `null` de celui d'un
  // échec.
  let expiresAt = null;
  if (matchingItem && !estAVie(plan)) {
    const duree = moisAchetes({
      unitPrice: matchingItem.unitPrice,
      planPrice: plan.price,
      planDuration: plan.duration,
    });
    if (duree.ok) {
      expiresAt = dateExpiration({ debut: order.createdAt, mois: duree.mois });
    } else {
      // Sans date, aucun rappel ne partira et le bot OTP gardera son ancien
      // comportement pour cette commande — c'est volontaire : mieux vaut ne
      // rien promettre que promettre une date fausse.
      logger.warn("Durée d'abonnement indéterminable — expiration non enregistrée", {
        planId,
        unitPrice: matchingItem.unitPrice,
        planPrice: plan.price,
        raison: duree.raison,
      });
    }
  }

  // ── Trace de l'abonnement, quelle que soit la catégorie ────────────────────
  // Le bot OTP ne connaît que la table SubscriptionOrder : sans cette ligne, un
  // abonnement acheté par le panier lui est totalement invisible et ses codes
  // finissent orphelins (c'était le cas de tous les link_access).
  // upsert sur (sourceOrderRef, planId) : idempotent, et sans conflit si le
  // réconciliateur a déjà reconstruit cette commande de son côté.
  const subOrderData = {
    serviceId: plan.serviceId,
    planId,
    clientName: order.guestName,
    clientWhatsapp: order.guestWhatsapp,
    clientEmail: order.guestEmail || null,
    amount: matchingItem ? matchingItem.totalPrice : order.total,
    status: "CONFIRMED",
    isGift,
    giftName: isGift ? recipientName : null,
    giftWhatsapp: isGift ? recipientWhatsapp : null,
    sourceOrderRef: order.reference || null,
    expiresAt,
  };

  let subOrder;
  if (order.reference) {
    // L'upsert ne gère plus que la création et le statut : `expiresAt` n'y
    // apparaît pas dans la branche `update`, pour ne jamais écraser une date
    // déjà posée par un rejeu précédent ou par une correction admin.
    subOrder = await prisma.subscriptionOrder
      .upsert({
        where: { sourceOrderRef_planId: { sourceOrderRef: order.reference, planId } },
        create: subOrderData,
        update: { status: "CONFIRMED" },
      })
      .catch((err) => {
        logger.warn("Impossible d'enregistrer la SubscriptionOrder du panier", {
          ref: order.reference,
          err: err.message,
        });
        return null;
      });
  } else {
    subOrder = await prisma.subscriptionOrder.create({ data: subOrderData }).catch(() => null);
  }

  // Une confirmation rejouée (webhook redélivré, réconciliateur relancé) ne
  // doit ni effacer une date déjà enregistrée, ni écraser une correction
  // manuelle faite par un admin en base. `updateMany` avec `expiresAt: null`
  // dans le `where` fait tenir la condition et l'écriture dans la même
  // instruction Postgres : aucune fenêtre entre une lecture et une écriture
  // séparées où une correction admin pourrait se glisser et être écrasée.
  // Une ligne déjà datée n'est simplement pas touchée (`count: 0`, pas
  // d'exception). Pour une commande neuve, `subOrderData.expiresAt` a déjà
  // posé la date via la branche `create` de l'upsert ci-dessus — ce
  // `updateMany` ne fait que rattraper le cas d'une ligne existante encore
  // sans date.
  if (subOrder && expiresAt) {
    await prisma.subscriptionOrder
      .updateMany({
        where: { id: subOrder.id, expiresAt: null },
        data: { expiresAt },
      })
      .catch((err) => {
        logger.warn("Impossible de renseigner expiresAt sur la SubscriptionOrder", {
          id: subOrder.id,
          err: err.message,
        });
      });
  }

  if (plan.service.category === "family") {
    // La place est prise APRÈS la création de la commande : c'est l'identifiant
    // de cette commande que porte l'occupation (`ProfileOccupancy.orderId`), ce
    // dont le bot OTP a besoin pour départager plusieurs clients sur une même
    // boîte mail partagée.
    //
    // D'où la garde qui suit : `orderId` est une clé étrangère obligatoire, et
    // l'upsert ci-dessus peut avoir renvoyé null (son `.catch(() => null)`).
    // Sans commande, aucune occupation n'est représentable. On renonce donc ici
    // plutôt que de laisser `revendiquerPlace` échouer sur un `order.id`
    // illisible, et on n'attribue rien « au cas où » : une place consommée sans
    // commande à laquelle la rattacher serait perdue pour tout le monde, sans
    // trace de son destinataire.
    if (!subOrder) {
      logger.error("Commande abonnement absente — attribution de place abandonnée", {
        planId,
        ref: order.reference || null,
        clientWhatsapp: order.guestWhatsapp,
      });
      return;
    }

    const { occupation, profil, compte, raison } = await revendiquerPlace({
      serviceId: plan.serviceId,
      // Explicite plutot que deduit de la commande : `planId` est le parametre
      // de cette fonction, on sait qu'il est la. Un `subOrder` charge avec un
      // `select` partiel rendrait `planId` absent, et le filtre tomberait
      // silencieusement sur les profils sans formule.
      planId,
      order: subOrder,
      occupantName: recipientName,
      occupantWhatsapp: recipientWhatsapp,
      endsAt: expiresAt,
    });

    if (!occupation) {
      logger.warn("Aucune place disponible pour cet item panier", { planId, raison });
      if (raison === "aucun-profil") {
        // Aucun profil candidat pour ce service : pas « plein », rien de
        // configuré (aucun compte, ou reprise de données pas exécutée). Voir
        // le même branchement dans `assignSubscriptionAfterPayment` ci-dessus.
        await whatsapp.sendConfigurationAbonnementManquanteAlert({
          serviceName: plan.service.name,
          clientName: order.guestName,
          clientWhatsapp: order.guestWhatsapp,
        });
        return;
      }
      await whatsapp.sendStockEpuiseAlert({
        serviceName: plan.service.name,
        clientName: order.guestName,
        clientWhatsapp: order.guestWhatsapp,
        raison:
          raison === "plafond-flux"
            ? "Le compte a atteint son plafond de flux simultanés — ajouter un compte."
            : "Tous les profils sont pleins — ajouter un profil ou augmenter une capacité.",
      });
      return;
    }

    const account = { ...profil, email: compte.email, passwordEncrypted: compte.passwordEncrypted };

    const credentials = dechiffrerIdentifiants(account);

    // Envoi au destinataire (cadeau ou acheteur)
    const sent = await whatsapp.sendSubscriptionCredentials({
      clientWhatsapp: recipientWhatsapp,
      clientName: recipientName,
      serviceName: plan.service.name,
      credentials,
    });

    // Fallback : si cadeau et destinataire injoignable → envoie à l'acheteur
    if (isGift && !sent) {
      logger.warn("Envoi cadeau échoué — fallback acheteur", {
        recipientWhatsapp,
        buyerWhatsapp: order.guestWhatsapp,
      });
      await whatsapp.sendSubscriptionCredentialsFallback({
        clientWhatsapp: order.guestWhatsapp,
        clientName: order.guestName,
        recipientName,
        serviceName: plan.service.name,
        credentials,
      });
    }

    await emailSvc.sendSubscriptionCredentials({
      clientEmail: order.guestEmail,
      clientName: order.guestName,
      serviceName: plan.service.name,
      serviceSlug: plan.service.slug,
      credentials,
    }).catch(() => {});

    await whatsapp.sendSubscriptionNotifToAdmin({
      clientName: order.guestName,
      clientWhatsapp: order.guestWhatsapp,
      serviceName: plan.service.name,
      planDescription,
      amount: order.total,
    });

    logger.info(
      `✅ Abonnement ${plan.service.name} attribué — destinataire: ${recipientWhatsapp}` +
        (subOrder ? ` (commande ${subOrder.id} ↔ compte ${account.email}/${account.profile})` : ""),
    );

  } else if (plan.service.category === "link_access") {
    // Réserve garnie : un lien est attribué et envoyé tout seul. Réserve vide :
    // on retombe sur le mode manuel, strictement inchangé.
    //
    // ORDRE PROTECTEUR — ne pas intervertir ces trois étapes :
    //   1. créer la ligne cliente vide (`link: null`, « en_attente ») ;
    //   2. réserver le lien ;
    //   3. reporter le lien et le statut d'envoi sur la ligne créée.
    //
    // L'étape 1 vient en premier parce que c'est EXACTEMENT ce que faisait le
    // code d'avant la réserve : si elle échoue, rien n'a encore été consommé et
    // le système se retrouve dans son état d'avant (commande payée, aucune
    // ligne, l'exception remonte au webhook qui la journalise). Réserver
    // d'abord, comme le faisait la première version de ce chantier, exposait au
    // contraire au pire scénario : le `UPDATE` de réservation est commité côté
    // Postgres, la réponse ne revient pas, l'exception remonte — le lien est
    // marqué consommé POUR TOUJOURS (rien ne le remet en réserve, par
    // conception), et il n'existe aucune ligne cliente pour dire à qui il était
    // destiné. Avec l'ordre ci-dessous, un échec à n'importe quel point laisse
    // toujours une ligne visible dans l'écran de rattrapage.
    const ligneClient = await prisma.linkAccessClient.create({
      data: {
        planId,
        name: recipientName,
        whatsapp: recipientWhatsapp,
        // Sur une commande cadeau : AUCUNE adresse enregistrée. La base ne
        // stocke pas d'adresse pour le destinataire d'un cadeau — la seule
        // disponible est celle de l'ACHETEUR. L'y déposer ferait fuiter
        // l'accès par le rattrapage : `sendLinkToClient` relit ce champ et
        // enverrait le lien du destinataire dans la boîte de l'acheteur, sous
        // un en-tête au nom du destinataire. Le destinataire reçoit son lien
        // par WhatsApp ; si cet envoi échoue, la ligne reste « en_attente » et
        // l'administrateur la traite à la main.
        email: isGift ? null : order.guestEmail || null,
        link: null,
        status: "en_attente",
      },
    });

    let lienReserve = null;
    let statut = "en_attente";
    // Vrai dès qu'un lien a été consommé sans que sa trace ait pu être écrite :
    // l'incident remplace alors la notification de vente normale, pour qu'une
    // seule notification admin parte par vente et qu'elle dise la vérité.
    let incidentSignale = false;

    try {
      lienReserve = await claimLinkAccessLink(planId, subOrder?.id || null);

      if (lienReserve) {
        // Les deux envois sont tentés indépendamment : une session WhatsApp
        // tombée ne doit pas empêcher l'e-mail de partir, et l'inverse.
        const whatsappOk = await whatsapp
          .sendLinkAccess({
            clientWhatsapp: recipientWhatsapp,
            clientName: recipientName,
            serviceName: plan.service.name,
            link: lienReserve.link,
          })
          .catch(() => false);

        // Même règle que ci-dessus : sur un cadeau, aucun e-mail ne part.
        const emailOk =
          order.guestEmail && !isGift
            ? await emailSvc
                .sendLinkAccess({
                  clientEmail: order.guestEmail,
                  clientName: recipientName,
                  serviceName: plan.service.name,
                  link: lienReserve.link,
                })
                .catch(() => false)
            : false;

        statut = statutApresEnvoi({ whatsappOk, emailOk });

        // La ligne cliente garde le lien même quand les deux envois échouent :
        // elle réapparaît alors dans l'écran de saisie manuelle, champ
        // pré-rempli, et l'administrateur réessaie en un clic. Le lien n'est
        // jamais remis en réserve — il est nominativement attribué, le
        // recycler risquerait de l'envoyer à deux personnes.
        await prisma.linkAccessClient.update({
          where: { id: ligneClient.id },
          data: {
            link: lienReserve.link,
            status: statut,
            sentAt: statut === "envoyé" ? new Date() : null,
          },
        });

        if (statut !== "envoyé") {
          logger.error("Lien attribué mais aucun envoi n'a abouti — à renvoyer depuis le panel", {
            planId,
            client: recipientName,
          });
        }
      }
    } catch (err) {
      if (lienReserve) {
        // Le lien est sorti de la réserve mais sa trace n'a pas pu être
        // écrite : le journal ci-dessous porte l'URL, seule copie restante.
        // Un journal ne se lit pas à temps — on alerte donc l'administrateur,
        // et si WhatsApp est justement le canal en panne, on bascule sur
        // l'e-mail (l'alerte ne doit pas emprunter le canal défaillant).
        logger.error("Lien consommé sans trace sur la ligne cliente", {
          planId,
          client: recipientName,
          whatsapp: recipientWhatsapp,
          lien: lienReserve.link,
          err: err.message,
        });

        const alerteWhatsappOk = await whatsapp
          .sendLinkAccessNotifToAdmin({
            serviceName: plan.service.name,
            planDescription:
              `⚠️ ENREGISTREMENT ÉCHOUÉ — lien consommé sans trace en base. ` +
              `À renvoyer à la main : ${lienReserve.link}`,
            clientName: order.guestName,
            clientWhatsapp: order.guestWhatsapp,
            amount: order.total,
            isGift,
            giftName: isGift ? recipientName : null,
            giftWhatsapp: isGift ? recipientWhatsapp : null,
          })
          .catch(() => false);

        if (!alerteWhatsappOk) {
          await emailSvc
            .sendAdminLinkIncident({
              serviceName: plan.service.name,
              clientName: recipientName,
              clientWhatsapp: recipientWhatsapp,
              link: lienReserve.link,
            })
            .catch(() => false);
        }

        incidentSignale = true;
      } else {
        // La réservation elle-même a échoué : aucun lien n'est sorti de la
        // réserve. La ligne cliente existe déjà, vide et « en_attente » — le
        // rattrapage manuel prend le relais et la notification de vente
        // normale, qui réclame justement une action, part juste en dessous.
        logger.error("Réservation d'un lien impossible — la ligne reste en attente", {
          planId,
          client: recipientName,
          err: err.message,
        });
      }
    }

    // Une seule notification admin par vente. Son libellé suit ce qui s'est
    // réellement passé : lien parti tout seul → simple information ; lien non
    // attribué ou non délivré → action requise dans le panel.
    if (!incidentSignale) {
      await whatsapp.sendLinkAccessNotifToAdmin({
        serviceName: plan.service.name,
        planDescription,
        clientName: order.guestName,
        clientWhatsapp: order.guestWhatsapp,
        amount: order.total,
        isGift,
        giftName: isGift ? recipientName : null,
        giftWhatsapp: isGift ? recipientWhatsapp : null,
        lienDejaEnvoye: statut === "envoyé",
      });
    }

    logger.info(
      `✅ Commande link_access (cadeau: ${isGift}) — ` +
        (lienReserve
          ? `lien attribué automatiquement, statut ${statut}`
          : "réserve vide, en attente d'action admin"),
    );
  }
}

// ── ADMIN — Commandes ─────────────────────────────────────────────────────────

async function getAllOrders(req, res) {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const where = status ? { status } : {};
    const [orders, total] = await Promise.all([
      prisma.subscriptionOrder.findMany({
        where,
        include: { service: true, plan: true },
        orderBy: { createdAt: "desc" },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.subscriptionOrder.count({ where }),
    ]);
    return res.json({ orders, total });
  } catch (err) {
    logger.error("Erreur getAllOrders", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function deleteOrder(req, res) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.subscriptionOrder.findUnique({
        where: { id: req.params.id },
        select: { id: true, clientName: true },
      });
      if (!order) return null;

      const occupations = await tx.profileOccupancy.findMany({
        where: { orderId: order.id },
        select: { id: true, profileId: true },
      });
      const occupationIds = occupations.map((item) => item.id);
      const profileIds = [...new Set(occupations.map((item) => item.profileId))];

      if (occupationIds.length) {
        await tx.otpRequest.deleteMany({
          where: { occupancyId: { in: occupationIds } },
        });
        await tx.profileOccupancy.deleteMany({
          where: { id: { in: occupationIds } },
        });
      }
      await tx.oTPLog.deleteMany({ where: { orderId: order.id } });
      // Conserve la trace comptable, mais retire son lien vers l'abonnement supprimé.
      await tx.payment.updateMany({
        where: { subOrderId: order.id },
        data: { subOrderId: null },
      });
      await tx.familyAccount.updateMany({
        where: { currentOrderId: order.id },
        data: { currentOrderId: null, status: "disponible" },
      });
      for (const profileId of profileIds) await synchroniserMiroirProfil(tx, profileId);
      await tx.linkAccessLink.updateMany({
        where: { currentOrderId: order.id },
        data: { currentOrderId: null },
      });
      await tx.subscriptionOrder.delete({ where: { id: order.id } });
      return order;
    });

    if (!result) return res.status(404).json({ error: "Commande introuvable" });
    logger.warn("Commande d'abonnement supprimée par l'administrateur", { orderId: result.id });
    return res.json({ message: `Commande de ${result.clientName} supprimée` });
  } catch (err) {
    logger.error("Erreur deleteOrder abonnement", { err: err.message });
    return res.status(500).json({ error: "Impossible de supprimer cette commande" });
  }
}

async function getAdminDashboard(req, res) {
  try {
    const services = await prisma.subscriptionService.findMany({
      include: {
        plans: {
          include: {
            accounts: {
              orderBy: { createdAt: "asc" },
              // `currentOrderId` est indispensable : c'est le seul lien entre
              // un profil et son acheteur. Il était absent de cette sélection,
              // si bien que le panel ne pouvait pas afficher qui occupe quoi.
              // `accountId` + `account` : repli de `dechiffrerIdentifiants`
              // pour les profils de la tâche 6, dont `passwordEncrypted`
              // hérité est vide.
              select: {
                id: true, planId: true, email: true, passwordEncrypted: true, profile: true,
                profilePassword: true, status: true, currentOrderId: true, createdAt: true,
                accountId: true,
                account: { select: { email: true, passwordEncrypted: true } },
              },
            },
            linkClients: {
              orderBy: { paidAt: "desc" },
              take: 50,
            },
            poolLinks: {
              orderBy: { createdAt: "asc" },
            },
          },
          orderBy: { price: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    // Résout les acheteurs de TOUS les profils en une seule requête, plutôt
    // qu'une par formule : le tableau de bord charge tous les services d'un
    // coup, et une requête par formule multiplierait les allers-retours.
    const tousLesProfils = services.flatMap((svc) =>
      svc.plans.flatMap((plan) => plan.accounts),
    );
    const profilsAvecClient = await attacherClients(tousLesProfils);
    const clientParProfil = new Map(
      profilsAvecClient.map((a) => [a.id, a.client]),
    );

    // Décrypte les mots de passe pour l'affichage admin
    const servicesWithDecrypted = services.map((svc) => ({
      ...svc,
      plans: svc.plans.map((plan) => ({
        ...plan,
        accounts: plan.accounts.map((a) => {
          const { email, password, erreurDechiffrement } = dechiffrerIdentifiants(a);
          // Reconstruction explicite, jamais un spread de `a` : `a` porte
          // `passwordEncrypted` (le chiffré du profil hérité) et `account`
          // (le chiffré du compte, chargé uniquement pour le repli de
          // `dechiffrerIdentifiants`) — deux champs qu'un spread ferait
          // fuiter dans la réponse. Lister les champs à la main garantit
          // qu'aucun des deux ne peut plus jamais y apparaître, même si le
          // `select` ci-dessus gagne un champ supplémentaire un jour.
          return {
            id: a.id,
            planId: a.planId,
            accountId: a.accountId,
            email,
            password,
            profile: a.profile,
            profilePassword: a.profilePassword,
            status: a.status,
            currentOrderId: a.currentOrderId,
            createdAt: a.createdAt,
            erreurDechiffrement,
            client: clientParProfil.get(a.id) || null,
          };
        }),
      })),
    }));

    const [totalOrders, pendingOrders, confirmedOrders] = await Promise.all([
      prisma.subscriptionOrder.count(),
      prisma.subscriptionOrder.count({ where: { status: "PENDING" } }),
      prisma.subscriptionOrder.count({ where: { status: "CONFIRMED" } }),
    ]);

    return res.json({
      services: servicesWithDecrypted,
      categoryOrder: lireOrdreCategories(
        (await prisma.setting.findUnique({
          where: { key: "subscriptionCategoryOrder" },
        }))?.value,
      ),
      stats: {
        totalOrders,
        pendingOrders,
        confirmedOrders,
        totalServices: services.length,
      },
    });
  } catch (err) {
    logger.error("Erreur getAdminDashboard", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── ADMIN — Services CRUD ─────────────────────────────────────────────────────

async function createService(req, res) {
  try {
    const service = await prisma.subscriptionService.create({ data: req.body });
    return res.status(201).json({ service });
  } catch (err) {
    logger.error("Erreur createService", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function updateService(req, res) {
  try {
    const data = { ...req.body };

    // `transfertOtp` commande si les codes de verification partent chez les
    // clients de ce service. Un interrupteur de securite ne doit pas dependre
    // de la facon dont le corps a ete serialise : la chaine "false" est vraie
    // en JavaScript, et laisser passer une valeur non booleenne rallumerait le
    // transfert en silence.
    if (data.transfertOtp !== undefined) {
      const v = data.transfertOtp;
      if (v === true || v === "true") data.transfertOtp = true;
      else if (v === false || v === "false") data.transfertOtp = false;
      else {
        return res.status(400).json({ error: "Champ « transfert des codes » invalide" });
      }
    }

    const service = await prisma.subscriptionService.update({
      where: { id: req.params.id },
      data,
    });

    // Le routage OTP garde les services en cache cinq minutes. Sans cette
    // ligne, couper le transfert laisserait les codes partir pendant tout ce
    // temps — l'administrateur croirait la fuite arretee alors qu'elle dure.
    require("../../../workers/otpRouting").viderCacheServices();

    return res.json({ service });
  } catch (err) {
    logger.error("Erreur updateService", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteService(req, res) {
  try {
    const resultat = await prisma.$transaction(async (tx) => {
      const service = await tx.subscriptionService.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true },
      });
      if (!service) return { introuvable: true };

      const plans = await tx.subscriptionPlan.findMany({
        where: { serviceId: service.id },
        select: { id: true },
      });
      const planIds = plans.map((plan) => plan.id);
      const accounts = await tx.streamingAccount.findMany({
        where: { serviceId: service.id },
        select: { id: true },
      });
      const accountIds = accounts.map((account) => account.id);
      const profiles = await tx.familyAccount.findMany({
        where: {
          OR: [
            ...(planIds.length ? [{ planId: { in: planIds } }] : []),
            ...(accountIds.length ? [{ accountId: { in: accountIds } }] : []),
          ],
        },
        select: { id: true },
      });
      const profileIds = profiles.map((profile) => profile.id);
      const orders = await tx.subscriptionOrder.findMany({
        where: {
          OR: [
            { serviceId: service.id },
            ...(planIds.length ? [{ planId: { in: planIds } }] : []),
          ],
        },
        select: { id: true },
      });
      const orderIds = orders.map((order) => order.id);

      const occupations = await tx.profileOccupancy.findMany({
        where: {
          OR: [
            ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
            ...(profileIds.length ? [{ profileId: { in: profileIds } }] : []),
          ],
        },
        select: { id: true, profileId: true, orderId: true },
      });
      const orderIdsSet = new Set(orderIds);
      const commandeIdsAutresServices = [
        ...new Set(occupations.map((occupation) => occupation.orderId)),
      ].filter((orderId) => !orderIdsSet.has(orderId));
      if (commandeIdsAutresServices.length) {
        const commandesAutresServices = await tx.subscriptionOrder.count({
          where: { id: { in: commandeIdsAutresServices } },
        });
        if (commandesAutresServices) return { conflit: commandesAutresServices };
      }

      const occupationIds = occupations.map((occupation) => occupation.id);
      const profilIdsTouches = [...new Set(occupations.map((occupation) => occupation.profileId))];
      if (occupationIds.length) {
        await tx.otpRequest.deleteMany({ where: { occupancyId: { in: occupationIds } } });
        await tx.profileOccupancy.deleteMany({ where: { id: { in: occupationIds } } });
      }
      if (accountIds.length) {
        await tx.otpRequest.deleteMany({ where: { accountId: { in: accountIds } } });
      }
      if (orderIds.length) {
        await tx.oTPLog.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.payment.updateMany({
          where: { subOrderId: { in: orderIds } },
          data: { subOrderId: null },
        });
        await tx.linkAccessLink.updateMany({
          where: { currentOrderId: { in: orderIds } },
          data: { currentOrderId: null },
        });
        await tx.subscriptionOrder.deleteMany({ where: { id: { in: orderIds } } });
      }
      for (const profileId of profilIdsTouches) {
        // Les profils du service seront supprimés plus bas. Ce recalcul n'est
        // utile que si un profil partagé appartient encore à une autre formule.
        if (!profileIds.includes(profileId)) await synchroniserMiroirProfil(tx, profileId);
      }
      if (planIds.length) {
        await tx.linkAccessClient.deleteMany({ where: { planId: { in: planIds } } });
        await tx.linkAccessLink.deleteMany({ where: { planId: { in: planIds } } });
      }
      if (profileIds.length) {
        await tx.familyAccount.deleteMany({ where: { id: { in: profileIds } } });
      }
      if (accountIds.length) {
        await tx.streamingAccount.deleteMany({ where: { id: { in: accountIds } } });
      }
      if (planIds.length) {
        await tx.subscriptionPlan.deleteMany({ where: { id: { in: planIds } } });
      }
      await tx.subscriptionService.delete({ where: { id: service.id } });
      return { service, commandes: orderIds.length };
    }, { timeout: 30000, maxWait: 10000 });

    if (resultat.introuvable) {
      return res.status(404).json({ error: "Service introuvable" });
    }
    if (resultat.conflit) {
      return res.status(409).json({
        error: "Ce service possède des profils utilisés par une commande d'un autre service. Supprimez ou déplacez d'abord ces occupations.",
      });
    }
    require("../../../workers/otpRouting").viderCacheServices();
    logger.warn("Service d'abonnement supprimé définitivement", {
      serviceId: resultat.service.id,
      commandes: resultat.commandes,
    });
    return res.json({ message: `Service « ${resultat.service.name} » supprimé définitivement` });
  } catch (err) {
    logger.error("Erreur deleteService", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// ── ADMIN — Plans CRUD ────────────────────────────────────────────────────────

// Bornes de la description d'une formule. Elles ne protègent pas la base — la
// colonne est un tableau de texte libre — mais la mise en page : la fiche du
// service aligne les formules côte à côte, et une ligne à rallonge ou une
// liste interminable ferait sauter cet alignement chez le client.
const MAX_LIGNES_DESCRIPTION = 8;
const MAX_LONGUEUR_LIGNE = 120;

// `description` arrive du panel sous forme de tableau, une entrée par puce.
// On tolère aussi une chaîne (collage d'un texte multiligne) en la découpant
// sur les retours à la ligne : c'est le geste naturel d'un admin pressé, et
// le refuser n'apporterait rien.
//
// Renvoie `{ ok: true, valeur }` ou `{ ok: false, erreur }` — jamais une
// exception, pour que l'appelant réponde en français plutôt qu'avec le
// message technique de Prisma.
function normaliserDescription(brut) {
  if (brut === undefined) return { ok: true, valeur: undefined };
  if (brut === null) return { ok: true, valeur: [] };

  const lignes = Array.isArray(brut) ? brut : typeof brut === "string" ? brut.split(/\r?\n/) : null;
  if (!lignes) {
    return { ok: false, erreur: "Description invalide" };
  }
  if (lignes.some((l) => typeof l !== "string")) {
    return { ok: false, erreur: "Chaque ligne de description doit être du texte" };
  }

  // Les lignes vides sont retirées silencieusement : le panel en laisse une
  // en attente dès qu'on clique sur « + », et l'admin ne doit pas avoir à la
  // supprimer avant d'enregistrer.
  const propres = lignes.map((l) => l.trim()).filter(Boolean);

  if (propres.length > MAX_LIGNES_DESCRIPTION) {
    return { ok: false, erreur: `${MAX_LIGNES_DESCRIPTION} lignes de description au maximum` };
  }
  if (propres.some((l) => l.length > MAX_LONGUEUR_LIGNE)) {
    return { ok: false, erreur: `Chaque ligne fait ${MAX_LONGUEUR_LIGNE} caractères au maximum` };
  }
  return { ok: true, valeur: propres };
}

async function createPlan(req, res) {
  try {
    const desc = normaliserDescription(req.body.description);
    if (!desc.ok) return res.status(400).json({ error: desc.erreur });

    // `duration` est obligatoire en base et n'a pas de valeur par defaut : sans
    // ce controle, une formule sans duree remontait l'erreur brute de Prisma,
    // en anglais, dans une 400 — la meme facon d'echouer que corrigeait deja
    // `deletePlan`.
    const dur = normaliserDuree(req.body);
    if (!dur.ok) return res.status(400).json({ error: dur.erreur });
    if (dur.champs.duration === undefined) {
      return res.status(400).json({
        error: "Durée manquante — indiquez un nombre de mois, ou cochez « à vie »",
      });
    }

    const plan = await prisma.subscriptionPlan.create({
      data: {
        ...req.body,
        // Apres l'etalement : les valeurs normalisees doivent primer sur celles
        // du corps, sinon le `aVie` brut du panel les remettrait telles quelles.
        ...dur.champs,
        serviceId: req.params.serviceId,
        description: desc.valeur ?? [],
      },
    });
    return res.status(201).json({ plan });
  } catch (err) {
    logger.error("Erreur createPlan", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function updatePlan(req, res) {
  try {
    const desc = normaliserDescription(req.body.description);
    if (!desc.ok) return res.status(400).json({ error: desc.erreur });

    const data = { ...req.body };
    // `undefined` signifie « le panel n'a pas envoyé ce champ » : on laisse
    // alors la description en place. Un tableau vide, lui, est une demande
    // explicite d'effacement.
    if (desc.valeur === undefined) delete data.description;
    else data.description = desc.valeur;

    // Meme convention pour la duree : ce que le panel n'envoie pas reste en
    // place. Le PATCH qui ne regle que la capacite ne doit pas basculer une
    // formule a vie en mensuelle au passage.
    const dur = normaliserDuree(req.body);
    if (!dur.ok) return res.status(400).json({ error: dur.erreur });
    Object.assign(data, dur.champs);

    // ── Propagation de la capacite aux profils de la formule ────────────────
    //
    // Sans elle, changer la capacite d'une formule ne changerait rien : les
    // profils garderaient celle heritee a leur creation, et l'ecran
    // annoncerait une valeur que le placement n'applique pas. C'est exactement
    // le genre d'ecart qui ne leve aucune erreur et se decouvre chez un client.
    let profilsMisAJour = 0;
    if (data.capaciteProfil !== undefined) {
      const voulue = Number(data.capaciteProfil);
      if (!Number.isFinite(voulue) || voulue < 1) {
        return res.status(400).json({ error: "Capacité par profil invalide" });
      }
      data.capaciteProfil = Math.floor(voulue);

      // Refuser AVANT d'ecrire quoi que ce soit : reduire la capacite sous le
      // nombre d'occupants deja places produirait des profils en surcharge que
      // rien ne sait resoudre automatiquement.
      const profils = await prisma.familyAccount.findMany({
        where: { planId: req.params.id },
        select: { id: true, profile: true },
      });
      const surcharges = [];
      for (const profil of profils) {
        const actifs = await prisma.profileOccupancy.count({
          where: { profileId: profil.id, ...filtreActive() },
        });
        if (actifs > data.capaciteProfil) {
          surcharges.push(`${profil.profile || "(sans nom)"} : ${actifs} occupant(s)`);
        }
      }
      if (surcharges.length > 0) {
        return res.status(409).json({
          error:
            `Impossible de descendre à ${data.capaciteProfil} place(s) par profil — ` +
            `certains profils sont plus remplis que cela : ${surcharges.join(", ")}. ` +
            `Libérez des places d'abord.`,
        });
      }
    }

    const plan = await prisma.subscriptionPlan.update({
      where: { id: req.params.id },
      data,
    });

    if (data.capaciteProfil !== undefined) {
      const maj = await prisma.familyAccount.updateMany({
        where: { planId: plan.id },
        data: { capacite: data.capaciteProfil },
      });
      profilsMisAJour = maj.count;
    }

    return res.json({ plan, profilsMisAJour });
  } catch (err) {
    logger.error("Erreur updatePlan", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// Supprime une formule.
//
// Le `delete` nu que faisait cette fonction ne pouvait PAS aboutir dès qu'une
// formule avait été vendue : trois tables la référencent par une clé
// obligatoire — commandes, clients de liens, liens en réserve. PostgreSQL
// refusait, et l'admin recevait le message interne de Prisma, en anglais, dans
// une 400. Le bouton « Supprimer » ne marchait donc jamais sur une formule
// réelle, et rien ne disait pourquoi.
//
// La règle est celle des profils : on refuse si un CLIENT est derrière
// (commande payée, lien attribué), et on supprime sinon — en emportant
// l'inventaire pur, c'est-à-dire les liens jamais distribués, et en détachant
// les profils hérités, dont le rattachement à une formule ne veut plus rien
// dire depuis que les identifiants vivent sur le compte streaming.
//
// `?force=1` lève ce refus. Il protégeait un oubli, mais il enfermait aussi
// l'administrateur : une formule créée par erreur puis vendue une seule fois
// n'avait plus AUCUN chemin de sortie depuis le panel. Le forçage reste un
// second geste, jamais le défaut — voir `supprimerFormuleDeForce` pour ce
// qu'il emporte, et `forceDemandee` pour pourquoi il est explicite.

// Efface une formule et tout ce qui pend à elle.
//
// L'ordre suit les clés étrangères de la feuille vers la racine : demandes de
// code, occupations, journaux OTP, puis commandes, puis la formule. Un ordre
// approximatif ne « marche presque » pas — PostgreSQL rejette la transaction
// entière et l'admin retrouve sa formule intacte.
//
// DEUX lignes échappent à la destruction, pour des raisons opposées :
//   • `Payment` est une trace comptable, vraie indépendamment de la formule
//     qui l'a motivée : elle est DÉTACHÉE (`subOrderId: null`), pas détruite.
//   • `FamilyAccount.currentOrderId` n'est pas une clé étrangère : rien ne
//     l'aurait remis à zéro, et le profil serait resté marqué « envoyé » à une
//     commande disparue — donc invisible au placement, à jamais. Le miroir des
//     profils touchés est donc RECALCULÉ, et non simplement vidé : un profil
//     partagé peut garder une occupation active née d'une autre formule, et
//     l'annoncer « disponible » le remettrait en circulation avec un client
//     encore dedans.
async function supprimerFormuleDeForce(planId) {
  return prisma.$transaction(async (tx) => {
    const commandes = await tx.subscriptionOrder.findMany({
      where: { planId },
      select: { id: true },
    });
    const commandeIds = commandes.map((c) => c.id);
    let occupations = 0;

    if (commandeIds.length) {
      const occ = await tx.profileOccupancy.findMany({
        where: { orderId: { in: commandeIds } },
        select: { id: true, profileId: true },
      });
      const occIds = occ.map((o) => o.id);
      const profilsTouches = [...new Set(occ.map((o) => o.profileId))];
      occupations = occIds.length;

      if (occIds.length) {
        await tx.otpRequest.deleteMany({ where: { occupancyId: { in: occIds } } });
        await tx.profileOccupancy.deleteMany({ where: { id: { in: occIds } } });
      }
      await tx.oTPLog.deleteMany({ where: { orderId: { in: commandeIds } } });
      await tx.payment.updateMany({
        where: { subOrderId: { in: commandeIds } },
        data: { subOrderId: null },
      });
      // Les profils marqués « envoyé » sans occupation (ancien modèle) : eux
      // n'ont pas de miroir à recalculer, seulement une référence morte.
      await tx.familyAccount.updateMany({
        where: { currentOrderId: { in: commandeIds } },
        data: { currentOrderId: null, status: "disponible" },
      });
      for (const profileId of profilsTouches) {
        await synchroniserMiroirProfil(tx, profileId);
      }
      await tx.subscriptionOrder.deleteMany({ where: { id: { in: commandeIds } } });
    }

    const clients = await tx.linkAccessClient.deleteMany({ where: { planId } });
    const liens = await tx.linkAccessLink.deleteMany({ where: { planId } });
    // Les profils survivent : ils portent des identifiants encore valables, et
    // leur rattachement à une formule ne dit plus rien depuis que ceux-ci
    // vivent sur le compte streaming. Détachés, ils restent réattribuables.
    const profils = await tx.familyAccount.updateMany({
      where: { planId },
      data: { planId: null },
    });
    await tx.subscriptionPlan.delete({ where: { id: planId } });

    return {
      commandes: commandeIds.length,
      occupations,
      clientsLiens: clients.count,
      liens: liens.count,
      profilsDetaches: profils.count,
    };
  },
  // Une formule vendue depuis des mois emporte des centaines de lignes, et le
  // recalcul des miroirs est une écriture par profil touché. Les 5 s par défaut
  // d'une transaction interactive Prisma suffisent au cas courant et pas à
  // celui-là — et un dépassement annule TOUT, en laissant l'admin devant un
  // « Erreur serveur » qu'aucun nouvel essai ne résoudrait.
  //
  // `maxWait` relevé aussi : les 2 s par défaut sont le temps d'ACQUÉRIR une
  // connexion, et ce pool en compte dix, partagées avec tout le trafic (voir
  // 166e9e6, où il s'était épuisé en production). Une suppression lancée
  // pendant un pic échouerait sinon avant même d'avoir commencé.
  { timeout: 30000, maxWait: 10000 });
}

const LIBELLES_FORMULE = {
  commandes: ["commande", "commandes"],
  occupations: ["client placé", "clients placés"],
  clientsLiens: ["client de lien", "clients de liens"],
  liens: ["lien en réserve", "liens en réserve"],
};

async function deletePlan(req, res) {
  try {
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: req.params.id },
      select: { id: true, label: true },
    });
    if (!plan) return res.status(404).json({ error: "Formule introuvable" });

    if (forceDemandee(req)) {
      const bilan = await supprimerFormuleDeForce(plan.id);
      // Journalisé en `warn` : c'est la seule trace durable d'une destruction
      // d'historique client, et elle doit rester lisible dans les logs le jour
      // où quelqu'un demande où est passée sa commande.
      logger.warn("Formule supprimée de force", { planId: plan.id, ...bilan });
      return res.json({
        message: `Formule « ${plan.label} » supprimée${resumeSuppression(bilan, LIBELLES_FORMULE)}`,
        ...bilan,
      });
    }

    const [commandes, clientsLiens] = await Promise.all([
      prisma.subscriptionOrder.count({ where: { planId: plan.id } }),
      prisma.linkAccessClient.count({ where: { planId: plan.id } }),
    ]);

    const verdict = verifierSuppression([
      { nombre: commandes, singulier: "commande", pluriel: "commandes" },
      { nombre: clientsLiens, singulier: "client de lien", pluriel: "clients de liens" },
    ]);
    if (!verdict.ok) return res.status(409).json({ error: verdict.message });

    await prisma.$transaction([
      // Aucun client de lien n'existe (garde ci-dessus), donc aucun de ces
      // liens n'a jamais été attribué : c'est du stock, pas de l'historique.
      prisma.linkAccessLink.deleteMany({ where: { planId: plan.id } }),
      prisma.familyAccount.updateMany({
        where: { planId: plan.id },
        data: { planId: null },
      }),
      prisma.subscriptionPlan.delete({ where: { id: plan.id } }),
    ]);

    return res.json({ message: `Formule « ${plan.label} » supprimée` });
  } catch (err) {
    logger.error("Erreur deletePlan", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── ADMIN — Comptes famille CRUD ──────────────────────────────────────────────

// Champs de la commande affichés à côté d'un profil. Liste explicite plutôt
// que la ligne entière : le panel n'a besoin que de l'identité de l'acheteur,
// et tout champ superflu repart de Supabase à chaque chargement du panel.
const CHAMPS_CLIENT = {
  id: true,
  clientName: true,
  clientWhatsapp: true,
  clientEmail: true,
  expiresAt: true,
  createdAt: true,
};

// Rattache à chaque profil l'acheteur qui l'occupe.
//
// Un profil ne garde qu'un identifiant de commande (`currentOrderId`). Sans
// cette résolution, le panel ne peut afficher qu'un identifiant opaque — ce
// qui revient à ne rien afficher, et laissait l'administrateur incapable de
// savoir quel client utilise quel profil.
// Qui occupe ces profils ?
//
// La reponse se lit dans `ProfileOccupancy`, jamais dans `currentOrderId`.
// Cette colonne appartient au modele « un profil = un client » : plus personne
// ne l'ecrivait depuis le partage de profils, si bien que l'ancienne section du
// panel montrait « disponible, aucun client » sur un profil que la section
// « Comptes partages » montrait, elle, occupe. Deux sections du meme ecran se
// contredisaient.
//
// La deriver a la lecture, plutot que de faire confiance au reflet, la rend
// aussi juste au fil du temps : une occupation dont la date de fin est passee
// cesse d'apparaitre sans qu'aucune ecriture n'ait eu lieu.
async function attacherClients(accounts) {
  if (accounts.length === 0) return [];

  const maintenant = new Date();
  const occupations = await prisma.profileOccupancy.findMany({
    where: { profileId: { in: accounts.map((a) => a.id) }, ...filtreActive(maintenant) },
    orderBy: { startedAt: "desc" },
    select: { profileId: true, order: { select: CHAMPS_CLIENT } },
  });

  // Le premier trouve gagne : la liste est triee du plus recent au plus ancien,
  // et cet affichage herite ne sait montrer qu'un client par profil. Le nombre
  // reel d'occupants se lit dans « Comptes partages ».
  const parProfil = new Map();
  for (const o of occupations) {
    if (!parProfil.has(o.profileId)) parProfil.set(o.profileId, o.order);
  }

  return accounts.map((a) => ({ ...a, client: parProfil.get(a.id) || null }));
}

async function getFamilyAccounts(req, res) {
  try {
    const rows = await prisma.familyAccount.findMany({
      where: { planId: req.params.planId },
      orderBy: { createdAt: "asc" },
      // Repli de `dechiffrerIdentifiants` pour les profils tâche 6 : leurs
      // identifiants hérités sont vides, les vrais vivent sur le compte.
      include: { account: { select: { email: true, passwordEncrypted: true } } },
    });
    const accounts = await attacherClients(rows);
    // Reconstruction explicite, jamais un spread de `a` : `a` porte
    // `passwordEncrypted` (le chiffré du profil hérité) et `account` (le
    // chiffré du compte, chargé uniquement pour le repli de
    // `dechiffrerIdentifiants`) — deux champs qu'un spread ferait fuiter
    // dans la réponse.
    const decrypted = accounts.map((a) => {
      const { email, password, erreurDechiffrement } = dechiffrerIdentifiants(a);
      return {
        id: a.id,
        planId: a.planId,
        accountId: a.accountId,
        capacite: a.capacite,
        email,
        password,
        profile: a.profile,
        profilePassword: a.profilePassword,
        status: a.status,
        currentOrderId: a.currentOrderId,
        createdAt: a.createdAt,
        client: a.client,
        erreurDechiffrement,
      };
    });
    return res.json({ accounts: decrypted });
  } catch (err) {
    logger.error("Erreur getFamilyAccounts", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Défaut préexistant, sans rapport avec la fonctionnalité de partage de
// profils : `addFamilyAccount`/`updateFamilyAccount` renvoyaient la ligne
// Prisma brute, `passwordEncrypted` compris. `FAMILY_ACCOUNT_SELECT_SUR`
// énumère explicitement les colonnes sûres d'un compte famille — à la
// différence de `PROFIL_SELECT_SUR`, `email` y reste : sur ces deux routes,
// c'est l'identifiant réel du compte, pas une colonne héritée vidée par la
// tâche 6.
const FAMILY_ACCOUNT_SELECT_SUR = {
  id: true,
  planId: true,
  email: true,
  profile: true,
  profilePassword: true,
  status: true,
  currentOrderId: true,
  accountId: true,
  capacite: true,
  createdAt: true,
};

// Ancienne section du panel, sous chaque formule. Elle creait un profil
// ORPHELIN : ses identifiants vivaient sur le profil lui-meme, et aucun
// `StreamingAccount` ne le portait.
//
// Ces profils sont invisibles pour la livraison automatique —
// `candidatsDuService` filtre sur `account.serviceId`. Le panel les affichait
// pourtant normalement, ils acceptaient les identifiants, et ils ne servaient
// jamais : toute commande payee repartait sans identifiants, sans que rien ne
// signale pourquoi. Deux commandes reelles y sont passees.
//
// La route continue d'exister — c'est un geste que l'administrateur connait —
// mais elle produit desormais la MEME chose que « Comptes partages » : un
// compte streaming (cree ou retrouve par son adresse) et un profil rattache.
// Il n'existe plus qu'une seule forme de donnee, donc plus de piege.
async function addFamilyAccount(req, res) {
  try {
    const { email, password, profile, profilePassword } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Adresse et mot de passe requis" });
    }

    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: req.params.planId },
      select: { id: true, serviceId: true, capaciteProfil: true },
    });
    if (!plan) return res.status(404).json({ error: "Formule introuvable" });

    const adresse = String(email).trim();
    const account = await prisma.$transaction(async (tx) => {
      // Une adresse = un compte, par service. Retrouve plutot que duplique :
      // deux comptes pour la meme boite se partageraient le plafond de flux
      // sans le savoir.
      let compte = await tx.streamingAccount.findFirst({
        where: { serviceId: plan.serviceId, email: adresse },
        select: { id: true },
      });
      if (!compte) {
        compte = await tx.streamingAccount.create({
          data: {
            serviceId: plan.serviceId,
            email: adresse,
            passwordEncrypted: encrypt(password),
          },
          select: { id: true },
        });
      }
      return tx.familyAccount.create({
        data: {
          planId: plan.id,
          accountId: compte.id,
          profile: profile || "",
          profilePassword: profilePassword || null,
          // La capacite est HERITEE de la formule, jamais saisie ici.
          //
          // Elle se reglait auparavant profil par profil, dans deux ecrans
          // differents : deux profils vendus sous la meme formule pouvaient
          // donc accueillir 1 et 3 personnes, sans que le client sache lequel
          // il achetait. La formule est desormais l'autorite.
          capacite: Math.max(1, Number(plan.capaciteProfil) || 1),
          status: "disponible",
          // Colonnes heritees : les identifiants vivent sur le compte.
          email: "",
          passwordEncrypted: "",
        },
        select: FAMILY_ACCOUNT_SELECT_SUR,
      });
    });
    // `password` reste volontairement en clair ici : c'est celui que
    // l'admin vient de saisir, renvoyé pour confirmer ce qui a été
    // enregistré — seul le CHIFFRÉ (`passwordEncrypted`) ne doit plus sortir,
    // et il est désormais structurellement absent de `account`.
    return res.status(201).json({ account: { ...account, password } });
  } catch (err) {
    logger.error("Erreur addFamilyAccount", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function updateFamilyAccount(req, res) {
  try {
    // Liste blanche : le corps de la requête était recopié tel quel, si bien
    // qu'un `planId` ou un `passwordEncrypted` envoyé par erreur écrasait
    // silencieusement la ligne. Seuls ces champs sont modifiables ici — le
    // rattachement client passe par sa propre route.
    const { email, password, profile, profilePassword, status, capacite } = req.body;
    const data = {};
    if (email !== undefined) data.email = email;
    if (profile !== undefined) data.profile = profile;
    if (profilePassword !== undefined) data.profilePassword = profilePassword;
    if (password) data.passwordEncrypted = encrypt(password);

    // La capacite ne se regle plus ici : elle est declaree sur la FORMULE et
    // heritee par ses profils. Repondre plutot qu'ignorer en silence — un
    // champ accepte puis sans effet est le pire des deux mondes.
    if (capacite !== undefined) {
      return res.status(400).json({
        error:
          "La capacité se règle désormais sur la formule, pas sur le profil : " +
          "modifiez « personnes par profil » dans la formule, tous ses profils suivront.",
      });
    }
    if (status !== undefined) {
      data.status = status;
      // Un profil remis « disponible » n'a plus d'occupant. Garder son
      // `currentOrderId` afficherait l'ancien acheteur sur un profil annoncé
      // libre, et l'attribution automatique pourrait le réattribuer en
      // écrasant ce lien — on perdrait alors toute trace du client précédent.
      if (status === "disponible") data.currentOrderId = null;
    }

    const account = await prisma.familyAccount.update({
      where: { id: req.params.id },
      data,
      select: FAMILY_ACCOUNT_SELECT_SUR,
    });
    return res.json({ account });
  } catch (err) {
    logger.error("Erreur updateFamilyAccount", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// Rattache — ou détache — manuellement un profil à l'acheteur qui l'utilise.
//
// L'attribution automatique n'existe que depuis peu : les profils distribués
// avant elle ne portent aucun lien, et c'est par ici que l'administrateur le
// rétablit. Ce lien ne sert pas qu'à l'affichage : le bot OTP s'en sert pour
// savoir vers qui router un code reçu.
async function setFamilyAccountClient(req, res) {
  try {
    const { orderId } = req.body;
    const profil = await prisma.familyAccount.findUnique({
      where: { id: req.params.id },
      select: { id: true, planId: true },
    });
    if (!profil) return res.status(404).json({ error: "Profil introuvable" });

    if (!orderId) {
      const libere = await prisma.familyAccount.update({
        where: { id: profil.id },
        data: { currentOrderId: null, status: "disponible" },
        select: { id: true, status: true, currentOrderId: true },
      });
      return res.json({ account: { ...libere, client: null } });
    }

    const order = await prisma.subscriptionOrder.findUnique({
      where: { id: orderId },
      select: { ...CHAMPS_CLIENT, planId: true },
    });
    if (!order)
      return res.status(404).json({ error: "Commande introuvable" });

    // Un profil Netflix rattaché à un acheteur Spotify serait une erreur
    // silencieuse, et le bot OTP enverrait ses codes à la mauvaise personne.
    if (order.planId !== profil.planId)
      return res
        .status(400)
        .json({ error: "Cette commande ne porte pas sur cette formule" });

    // Deux profils sur la même commande rendraient le routage des codes
    // indécidable. Le client qui a payé deux fois a deux commandes distinctes :
    // c'est celles-là qu'il faut rattacher, une par profil.
    const dejaPris = await prisma.familyAccount.findFirst({
      where: { currentOrderId: order.id, id: { not: profil.id } },
      select: { profile: true },
    });
    if (dejaPris)
      return res.status(409).json({
        error: `Cette commande occupe déjà le profil « ${dejaPris.profile || "sans nom"} »`,
      });

    const maj = await prisma.familyAccount.update({
      where: { id: profil.id },
      data: { currentOrderId: order.id, status: "envoyé" },
      select: { id: true, status: true, currentOrderId: true },
    });
    const { planId, ...client } = order;
    return res.json({ account: { ...maj, client } });
  } catch (err) {
    logger.error("Erreur setFamilyAccountClient", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

// Route héritée : `/admin/accounts/:id`, encore appelée par la section des
// formules du panel.
//
// Elle faisait un `delete` nu et renvoyait `err.message` dans une 400.
// Concrètement, supprimer un compte famille ayant hébergé quelqu'un affichait
// à l'administrateur « Foreign key constraint violated:
// ProfileOccupancy_profileId_fkey » — un message que PostgreSQL écrit pour un
// développeur, dans une langue qui n'est pas celle du panel, et qui ne dit ni
// ce qui bloque ni quoi faire. Elle partage désormais la garde de
// `/admin/profils/:id`.
async function deleteFamilyAccount(req, res) {
  try {
    const force = forceDemandee(req);
    const r = await retirerProfil(req.params.id, { force });
    if (r.statut === "introuvable") {
      return res.status(404).json({ error: "Compte introuvable" });
    }
    if (r.statut === "refuse") return res.status(409).json({ error: r.message });
    if (force) {
      logger.warn("Profil supprimé de force", { profilId: r.profil.id, ...r.bilan });
    }
    return res.json({
      message: `Compte « ${r.profil.profile} » supprimé${resumeSuppression(r.bilan, LIBELLES_PROFIL)}`,
      ...r.bilan,
    });
  } catch (err) {
    logger.error("Erreur deleteFamilyAccount", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── ADMIN — Comptes streaming et occupations (partage de profils) ────────────
// Ce bloc expose au panel les objets introduits par la tâche 1 : un compte
// streaming porte un plafond de flux et plusieurs profils, chaque profil a
// une capacité et des occupations (actives ou passées).

// Sélection sûre d'un profil renvoyé au panel : jamais les colonnes héritées
// `email` / `passwordEncrypted`. Elles ne veulent plus rien dire pour un
// profil (les identifiants vivent sur le compte) et, sur un profil hérité
// déjà rattaché à un compte, `passwordEncrypted` porte un chiffré RÉEL —
// pas la chaîne vide des profils créés par `ajouterProfil`. Un `select`
// explicite est préféré à un `passwordEncrypted: undefined` posé après
// coup : il ne peut pas être défait par un futur spread qui oublierait la
// redaction.
// Colonnes du compte renvoyees au panel. Meme raison que PROFIL_SELECT_SUR :
// `passwordEncrypted` est absent du resultat de la requete, il ne peut donc pas
// reapparaitre par un spread qui oublierait de le masquer. Le masquage par
// `passwordEncrypted: undefined` pose apres coup marchait, mais reposait sur le
// fait que personne ne rajoute un spread plus loin.
const COMPTE_SELECT_SUR = {
  id: true,
  serviceId: true,
  email: true,
  maxFluxSimultanes: true,
  createdAt: true,
};

const PROFIL_SELECT_SUR = {
  id: true,
  profile: true,
  profilePassword: true,
  capacite: true,
  accountId: true,
  planId: true,
  status: true,
  currentOrderId: true,
  createdAt: true,
};

async function listerComptes(req, res) {
  try {
    const comptes = await prisma.streamingAccount.findMany({
      where: { serviceId: req.params.serviceId },
      include: {
        profils: {
          orderBy: { createdAt: "asc" },
          select: {
            ...PROFIL_SELECT_SUR,
            // La formule decide desormais qui peut occuper ce profil : un
            // acheteur Standard ne prend une place que sur un profil Standard.
            // Sans ce libelle a l'ecran, l'administrateur ne peut ni verifier
            // la repartition de ses places, ni comprendre pourquoi un
            // placement est refuse.
            plan: { select: { id: true, label: true, price: true, aVie: true } },
            occupations: {
              where: filtreActive(),
              select: {
                id: true, occupantName: true, occupantWhatsapp: true,
                startedAt: true, endsAt: true,
              },
              orderBy: { startedAt: "desc" },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Le mot de passe du compte est déchiffré ici, comme pour les profils : le
    // panel doit pouvoir l'afficher à l'administrateur.
    const sortie = comptes.map((c) => {
      let motDePasse = null;
      let erreurDechiffrement = null;
      try {
        motDePasse = decrypt(c.passwordEncrypted);
      } catch (err) {
        erreurDechiffrement = err.message;
        logger.error("Déchiffrement du mot de passe de compte impossible", {
          compte: c.email, err: err.message,
        });
      }
      const occupantsCompte = c.profils.reduce((n, p) => n + p.occupations.length, 0);
      // Champs enumeres un a un, jamais `...c` : la requete DOIT ramener
      // `passwordEncrypted` pour le dechiffrer ci-dessus, donc un spread le
      // ferait sortir dans la reponse. L'enumeration est ce qui garantit qu'il
      // n'en sorte pas, independamment de ce que la requete rapporte.
      return {
        id: c.id,
        serviceId: c.serviceId,
        email: c.email,
        maxFluxSimultanes: c.maxFluxSimultanes,
        createdAt: c.createdAt,
        password: motDePasse,
        erreurDechiffrement,
        occupantsActifs: occupantsCompte,
        margeDeFlux: c.maxFluxSimultanes - occupantsCompte,
        // `p` vient de PROFIL_SELECT_SUR + `occupations` : jamais de
        // passwordEncrypted/email dans ce spread, par construction du select.
        profils: c.profils.map((p) => ({
          ...p,
          occupantsActifs: p.occupations.length,
          placesRestantes: p.capacite - p.occupations.length,
        })),
      };
    });

    return res.json({ comptes: sortie });
  } catch (err) {
    logger.error("Erreur listerComptes", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function creerCompte(req, res) {
  try {
    const { email, password, maxFluxSimultanes } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Adresse et mot de passe requis" });
    }
    const compte = await prisma.streamingAccount.create({
      data: {
        serviceId: req.params.serviceId,
        email: String(email).trim(),
        passwordEncrypted: encrypt(password),
        maxFluxSimultanes: Number(maxFluxSimultanes) || 4,
      },
      select: COMPTE_SELECT_SUR,
    });
    return res.status(201).json({ compte });
  } catch (err) {
    // Adresse deja enregistree sur ce service : c'est une erreur de saisie
    // courante, pas une panne. Un « Erreur serveur » laisserait l'admin
    // relancer sans comprendre ce qui bloque.
    if (err.code === "P2002") {
      return res.status(409).json({
        error: "Un compte avec cette adresse existe deja pour ce service.",
      });
    }
    logger.error("Erreur creerCompte", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function modifierCompte(req, res) {
  try {
    const { email, password, maxFluxSimultanes } = req.body;
    const data = {};
    if (email) data.email = String(email).trim();
    if (password) data.passwordEncrypted = encrypt(password);
    if (maxFluxSimultanes !== undefined) data.maxFluxSimultanes = Number(maxFluxSimultanes);

    // Existence verifiee avant l'ecriture : sans ce controle, un identifiant
    // inconnu remontait en P2025 puis en 500 « Erreur serveur », alors que les
    // autres fonctions de ce bloc repondent 404. L'admin voyait une panne la ou
    // il n'y avait qu'une mauvaise reference.
    const existe = await prisma.streamingAccount.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!existe) return res.status(404).json({ error: "Compte introuvable" });

    const compte = await prisma.streamingAccount.update({
      where: { id: req.params.id },
      data,
      select: COMPTE_SELECT_SUR,
    });
    return res.json({ compte });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({
        error: "Un compte avec cette adresse existe deja pour ce service.",
      });
    }
    logger.error("Erreur modifierCompte", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Profils ──────────────────────────────────────────────────────────────────
async function ajouterProfil(req, res) {
  try {
    const { profile, profilePassword, capacite } = req.body;
    if (!profile) return res.status(400).json({ error: "Nom du profil requis" });

    const compte = await prisma.streamingAccount.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!compte) return res.status(404).json({ error: "Compte introuvable" });

    const profil = await prisma.familyAccount.create({
      data: {
        accountId: compte.id,
        profile: String(profile).trim(),
        profilePassword: profilePassword || null,
        capacite: Math.max(1, Number(capacite) || 1),
        // Colonnes héritées, encore obligatoires tant que la migration
        // destructive n'a pas eu lieu.
        email: "",
        passwordEncrypted: "",
        planId: req.body.planId || null,
      },
      select: PROFIL_SELECT_SUR,
    });
    return res.status(201).json({ profil });
  } catch (err) {
    logger.error("Erreur ajouterProfil", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function modifierProfil(req, res) {
  try {
    const { profile, profilePassword, capacite } = req.body;
    const data = {};
    if (profile !== undefined) data.profile = String(profile).trim();
    if (profilePassword !== undefined) data.profilePassword = profilePassword || null;

    // La capacite ne se regle plus ici : elle est declaree sur la FORMULE et
    // heritee par ses profils. Repondre plutot qu'ignorer en silence — un
    // champ accepte puis sans effet est le pire des deux mondes.
    if (capacite !== undefined) {
      return res.status(400).json({
        error:
          "La capacité se règle désormais sur la formule, pas sur le profil : " +
          "modifiez « personnes par profil » dans la formule, tous ses profils suivront.",
      });
    }

    const profil = await prisma.familyAccount.update({
      where: { id: req.params.id },
      data,
      select: PROFIL_SELECT_SUR,
    });
    return res.json({ profil });
  } catch (err) {
    logger.error("Erreur modifierProfil", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Occupations ──────────────────────────────────────────────────────────────
async function listerOccupations(req, res) {
  try {
    const occupations = await prisma.profileOccupancy.findMany({
      where: { profileId: req.params.id },
      orderBy: { startedAt: "desc" },
      include: {
        order: { select: { id: true, clientName: true, clientWhatsapp: true, amount: true } },
      },
    });
    const maintenant = new Date();
    return res.json({
      occupations: occupations.map((o) => ({ ...o, active: estActive(o, maintenant) })),
    });
  } catch (err) {
    logger.error("Erreur listerOccupations", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Libération anticipée. On ne supprime jamais la ligne : `releasedAt` clôt la
// période et l'historique reste consultable.
async function libererOccupation(req, res) {
  try {
    const occupation = await prisma.profileOccupancy.update({
      where: { id: req.params.id },
      data: { releasedAt: new Date() },
    });
    await synchroniserMiroirProfil(prisma, occupation.profileId);
    return res.json({ occupation });
  } catch (err) {
    logger.error("Erreur libererOccupation", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Déplacer un occupant d'un profil à l'autre.
//
// On ne réécrit jamais le passé : l'occupation en cours est close à la date du
// jour et une nouvelle est ouverte sur le profil d'arrivée. L'historique dira
// donc « il était dans LONDRE jusqu'au 19 août, puis dans PARIS » — ce qui est
// la vérité. Muter `profileId` sur place effacerait le séjour précédent.
//
// `orderId` étant unique, la nouvelle occupation ne peut pas coexister avec
// l'ancienne : les deux écritures tiennent donc dans une transaction, et
// TOUJOURS dans cet ordre (clore, puis créer) — l'index unique
// `ProfileOccupancy_orderId_active_key` n'est partiel que sur les lignes non
// libérées, donc créer avant de clore violerait cette contrainte.
//
// Le comptage des occupants du profil cible doit se faire SOUS VERROU, à
// l'intérieur de la transaction : compté avant, comme le faisait une version
// précédente de cette fonction, deux déplacements simultanés vers le même
// profil liraient tous deux « il reste une place », passeraient tous deux la
// garde, et le profil dépasserait sa capacité — la même classe de défaut que
// `revendiquerPlace` (occupancy.js) traite avec un verrou explicite. On
// reprend ici le MÊME ORDRE d'acquisition que `revendiquerPlace` — le compte,
// puis le profil — pour qu'aucun chemin concurrent ne verrouille ces deux
// lignes dans des ordres opposés, ce qui est la condition d'un interblocage.
async function deplacerOccupation(req, res) {
  try {
    const { profileIdCible } = req.body;
    if (!profileIdCible) return res.status(400).json({ error: "Profil de destination requis" });

    const actuelle = await prisma.profileOccupancy.findUnique({
      where: { id: req.params.id },
    });
    if (!actuelle) return res.status(404).json({ error: "Occupation introuvable" });
    if (actuelle.releasedAt) {
      return res.status(409).json({ error: "Cette occupation est déjà close" });
    }

    const cible = await prisma.familyAccount.findUnique({
      where: { id: profileIdCible },
      select: { id: true, capacite: true, profile: true, accountId: true, planId: true },
    });
    if (!cible) return res.status(404).json({ error: "Profil de destination introuvable" });

    // Deplacer vers une autre formule reviendrait a changer ce que le client a
    // achete sans que rien ne le dise.
    const commandeDeplacee = await prisma.subscriptionOrder.findUnique({
      where: { id: actuelle.orderId },
      select: { planId: true },
    });
    if (commandeDeplacee && commandeDeplacee.planId !== cible.planId) {
      return res.status(409).json({
        error: `Le profil « ${cible.profile} » appartient à une autre formule que cette commande.`,
      });
    }

    const maintenant = new Date();
    const resultat = await prisma.$transaction(async (tx) => {
      // Compte d'abord (si le profil en a un — toujours le cas pour un
      // profil rattaché au nouveau modèle), profil ensuite.
      if (cible.accountId) {
        await tx.$queryRaw`SELECT id FROM "StreamingAccount" WHERE id = ${cible.accountId} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM "FamilyAccount" WHERE id = ${cible.id} FOR UPDATE`;

      const occupantsCible = await tx.profileOccupancy.count({
        where: { profileId: cible.id, ...filtreActive(maintenant) },
      });

      // Le plafond de flux du compte d'arrivée, que cette fonction ignorait :
      // seule la capacité du profil était vérifiée, si bien qu'un déplacement
      // vers un compte déjà saturé le faisait déborder — et les clients se
      // coupent alors mutuellement la lecture, ce que la capacité seule ne
      // peut pas prévenir.
      //
      // L'occupation en cours est exclue du comptage. Un déplacement à
      // l'intérieur du même compte ne consomme aucun flux supplémentaire :
      // la compter reviendrait à refuser tout déplacement sur un compte plein,
      // y compris celui qui ne fait que changer de profil.
      const fluxCompte = cible.accountId
        ? await tx.profileOccupancy.count({
            where: {
              profile: { accountId: cible.accountId },
              id: { not: actuelle.id },
              ...filtreActive(maintenant),
            },
          })
        : 0;
      // `null` — et non l'absence de valeur — pour un profil hérité sans
      // compte : `verifierPlacement` distingue une absence DÉCLARÉE de plafond
      // d'une valeur qu'on aurait échoué à lire, qu'elle refuse.
      let fluxMax = null;
      if (cible.accountId) {
        const [compteVerrouille] = await tx.$queryRaw`
          SELECT "maxFluxSimultanes" FROM "StreamingAccount" WHERE id = ${cible.accountId}`;
        fluxMax = Number(compteVerrouille?.maxFluxSimultanes);
      }

      const verdict = verifierPlacement({
        capacite: Number(cible.capacite),
        occupantsActifs: occupantsCible,
        fluxMax,
        fluxActifs: fluxCompte,
      });
      if (!verdict.ok) return { refus: verdict, occupantsCible };

      await tx.profileOccupancy.update({
        where: { id: actuelle.id },
        data: { releasedAt: maintenant },
      });
      const occupation = await tx.profileOccupancy.create({
        data: {
          profileId: cible.id,
          orderId: actuelle.orderId,
          occupantName: actuelle.occupantName,
          occupantWhatsapp: actuelle.occupantWhatsapp,
          startedAt: maintenant,
          endsAt: actuelle.endsAt,
        },
      });
      // Le profil de depart se vide, celui d'arrivee se remplit : les deux
      // reflets changent, dans la meme transaction que le deplacement.
      await synchroniserMiroirProfil(tx, actuelle.profileId, maintenant);
      await synchroniserMiroirProfil(tx, cible.id, maintenant);

      return { occupation };
    });

    if (resultat.refus) {
      return res.status(409).json({
        error: `Profil « ${cible.profile} » : ${resultat.refus.message}`,
      });
    }

    return res.json({ occupation: resultat.occupation });
  } catch (err) {
    logger.error("Erreur deplacerOccupation", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Administration manuelle : placer, corriger, supprimer ────────────────────
//
// Jusqu'ici, une occupation ne naissait que d'un paiement (`revendiquerPlace`)
// ou d'un déplacement depuis une occupation existante. Un client ayant payé
// avant l'existence du partage de profils — ou le jour où aucune place n'était
// libre — n'avait donc AUCUN chemin vers un profil. Ce bloc ouvre ce chemin,
// et avec lui la correction d'une saisie et la suppression d'une ligne vide.

// Champs d'une commande plaçable affichés au panel.
const COMMANDE_LIBRE_SELECT = {
  id: true,
  clientName: true,
  clientWhatsapp: true,
  clientEmail: true,
  amount: true,
  expiresAt: true,
  createdAt: true,
  isGift: true,
  giftName: true,
  giftWhatsapp: true,
  // `aVie` : sans lui, le selecteur de placement annonce « sans date de fin »
  // pour un abonnement a vie — vrai, mais indistinguable d'une commande dont
  // l'expiration n'a jamais pu etre calculee, qui est un defaut a corriger.
  plan: { select: { id: true, label: true, aVie: true } },
};

// Les commandes payées de ce service qui n'occupent aucun profil.
//
// Le filtre est `releasedAt: null`, et non `filtreActive()`, parce qu'il doit
// refléter la contrainte réelle de la base : l'index unique partiel
// `ProfileOccupancy_orderId_active_key` interdit deux occupations non libérées
// pour une même commande. Une occupation expirée mais jamais libérée bloque
// donc bel et bien un nouveau placement — la proposer ici ferait échouer
// l'écriture au dernier moment. L'admin libère d'abord, puis replace.
async function listerCommandesLibres(req, res) {
  try {
    const maintenant = new Date();
    const commandes = await prisma.subscriptionOrder.findMany({
      where: {
        serviceId: req.params.serviceId,
        status: "CONFIRMED",
        occupations: { none: { releasedAt: null } },
        // Sans cette borne, la liste contient TOUT l'historique : un client de
        // l'an dernier dont l'occupation a été libérée y figure comme un client
        // d'hier, et elle ne fait que grossir à chaque revente. On ne propose
        // que des abonnements encore valides — un abonnement sans date de fin
        // en fait partie, on ne coupe pas sur une date qu'on n'a pas.
        OR: [{ expiresAt: null }, { expiresAt: { gt: maintenant } }],
      },
      select: COMMANDE_LIBRE_SELECT,
      orderBy: { createdAt: "desc" },
      // Le sélecteur du panel est une liste déroulante : au-delà, elle n'est
      // plus utilisable de toute façon, et la borne protège la réponse.
      take: 200,
    });
    return res.json({ commandes });
  } catch (err) {
    logger.error("Erreur listerCommandesLibres", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Place une commande payée dans un profil.
//
// Les deux plafonds sont vérifiés SOUS VERROU, dans le même ordre d'acquisition
// que `revendiquerPlace` et `deplacerOccupation` — compte, puis profil. Comptés
// avant la transaction, deux placements simultanés liraient tous deux « il
// reste une place » et le profil déborderait. L'ordre fixe évite l'interblocage
// entre deux placements visant des profils différents du même compte.
async function placerCommande(req, res) {
  try {
    const { orderId, occupantName, occupantWhatsapp } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "Commande requise" });

    // Nettoyés comme dans `modifierOccupation` : une chaîne d'espaces est
    // « vraie » en JavaScript, elle écraserait donc le nom de la commande par
    // du vide sans que rien ne le signale.
    const nomFourni = occupantName === undefined ? "" : String(occupantName).trim();
    const numeroFourni =
      occupantWhatsapp === undefined ? "" : String(occupantWhatsapp).trim();

    const profil = await prisma.familyAccount.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        profile: true,
        capacite: true,
        accountId: true,
        account: { select: { id: true, serviceId: true, maxFluxSimultanes: true } },
      },
    });
    if (!profil) return res.status(404).json({ error: "Profil introuvable" });
    if (!profil.account) {
      return res.status(409).json({
        error:
          "Ce profil n'est rattaché à aucun compte streaming — rattachez-le avant d'y placer un client.",
      });
    }

    const commande = await prisma.subscriptionOrder.findUnique({
      where: { id: orderId },
      // `planId` explicitement : `COMMANDE_LIBRE_SELECT` ne porte que la
      // relation `plan`, pas le scalaire. Sans lui, `commande.planId` valait
      // `undefined` et la comparaison de formule ci-dessous refusait TOUT
      // placement manuel, sans exception.
      select: { ...COMMANDE_LIBRE_SELECT, serviceId: true, status: true, planId: true },
    });
    if (!commande) return res.status(404).json({ error: "Commande introuvable" });
    if (commande.status !== "CONFIRMED") {
      return res.status(409).json({ error: "Cette commande n'est pas payée." });
    }
    // Placer un client de Spotify dans un profil Netflix lui enverrait les
    // codes du mauvais service — le rapprochement du bot OTP se fait par le
    // compte, pas par la commande.
    if (commande.serviceId !== profil.account.serviceId) {
      return res.status(409).json({
        error: "Cette commande appartient à un autre service que ce compte.",
      });
    }

    // Et pas davantage dans une autre FORMULE : un acheteur Standard place sur
    // un profil Premium recoit mieux que ce qu'il a paye, un acheteur Premium
    // place sur du Standard recoit moins. Le placement automatique applique la
    // meme regle ; le placement manuel ne doit pas etre la porte derobee.
    if (commande.planId !== profil.planId) {
      return res.status(409).json({
        error:
          `Ce profil appartient à une autre formule que la commande. ` +
          `Choisissez un profil de la formule achetée, ou corrigez la formule du profil.`,
      });
    }

    const maintenant = new Date();
    const resultat = await prisma.$transaction(async (tx) => {
      // Le verrou ET la relecture du plafond en une seule requête, comme
      // `revendiquerPlace` : lus avant la transaction, les plafonds auraient pu
      // changer entre la lecture et l'écriture.
      const [compteVerrouille] = await tx.$queryRaw`
        SELECT "maxFluxSimultanes" FROM "StreamingAccount"
        WHERE id = ${profil.account.id} FOR UPDATE`;
      const [profilVerrouille] = await tx.$queryRaw`
        SELECT capacite FROM "FamilyAccount"
        WHERE id = ${profil.id} FOR UPDATE`;

      // Le profil ou le compte a pu être supprimé entre la lecture ci-dessus
      // et l'obtention du verrou. Sans ce contrôle, `Number(undefined)` donne
      // NaN et l'admin lit « capacité illisible » là où la vraie cause est que
      // le profil n'existe plus.
      if (!compteVerrouille || !profilVerrouille) return { conflit: "disparu" };

      // Séquentiels, pas en `Promise.all` : une transaction interactive Prisma
      // tient UNE connexion, et l'ordre d'exécution de requêtes lancées en
      // parallèle sur cette connexion n'est pas garanti — c'est la convention
      // de tout le reste de ce fichier.
      const occupantsProfil = await tx.profileOccupancy.count({
        where: { profileId: profil.id, ...filtreActive(maintenant) },
      });
      const fluxCompte = await tx.profileOccupancy.count({
        where: { profile: { accountId: profil.account.id }, ...filtreActive(maintenant) },
      });
      const dejaPlacee = await tx.profileOccupancy.count({
        where: { orderId, releasedAt: null },
      });

      // Course possible : la commande a pu être placée ailleurs entre le
      // chargement de la liste et ce clic. Sans cette garde, l'index unique
      // partiel remonterait une P2002 brute.
      if (dejaPlacee > 0) return { conflit: "deja-placee" };

      const verdict = verifierPlacement({
        capacite: Number(profilVerrouille?.capacite),
        occupantsActifs: occupantsProfil,
        fluxMax: Number(compteVerrouille?.maxFluxSimultanes),
        fluxActifs: fluxCompte,
      });
      if (!verdict.ok) return { refus: verdict };

      const occupation = await tx.profileOccupancy.create({
        data: {
          profileId: profil.id,
          orderId,
          // Même convention que le placement automatique : sur une commande
          // cadeau, l'occupant est le destinataire, pas l'acheteur. C'est ce
          // nom et ce numéro qui décideront à qui part le code.
          occupantName:
            nomFourni ||
            (commande.isGift && commande.giftName ? commande.giftName : commande.clientName),
          occupantWhatsapp:
            numeroFourni ||
            (commande.isGift && commande.giftWhatsapp
              ? commande.giftWhatsapp
              : commande.clientWhatsapp),
          startedAt: maintenant,
          endsAt: commande.expiresAt,
        },
      });
      await synchroniserMiroirProfil(tx, profil.id, maintenant);

      return { occupation };
    });

    if (resultat.conflit === "disparu") {
      return res.status(409).json({
        error: "Ce profil ou son compte vient d'être supprimé — rechargez la page.",
      });
    }
    if (resultat.conflit === "deja-placee") {
      return res.status(409).json({
        error: "Cette commande occupe déjà un profil — rechargez la liste.",
      });
    }
    if (resultat.refus) {
      return res.status(409).json({ error: resultat.refus.message });
    }
    return res.status(201).json({ occupation: resultat.occupation });
  } catch (err) {
    // La garde `dejaPlacee` ne voit pas un placement concurrent vers un AUTRE
    // profil : les deux transactions verrouillent des lignes différentes et
    // passent toutes deux. C'est l'index unique partiel sur `orderId` qui
    // tranche — il doit rendre le même message que la garde, pas un 500.
    if (err.code === "P2002") {
      return res.status(409).json({
        error: "Cette commande occupe déjà un profil — rechargez la liste.",
      });
    }
    logger.error("Erreur placerCommande", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Corrige une saisie sur une occupation : nom, numéro WhatsApp, date de fin.
//
// Ne touche JAMAIS `profileId` (c'est le rôle de `deplacerOccupation`, qui
// clôt et rouvre pour ne pas réécrire le passé) ni `startedAt`/`releasedAt`.
// Corriger une saisie n'est pas refaire l'histoire.
//
// Le numéro compte plus que le reste : c'est lui qui décide à qui part le code
// de vérification. Une faute de frappe ici rend le client injoignable, et le
// seul recours était jusqu'ici de libérer la place et de refaire payer.
async function modifierOccupation(req, res) {
  try {
    const { occupantName, occupantWhatsapp, endsAt } = req.body || {};
    const data = {};

    if (occupantName !== undefined) {
      const nom = String(occupantName).trim();
      if (!nom) return res.status(400).json({ error: "Le nom ne peut pas être vide" });
      data.occupantName = nom;
    }

    if (occupantWhatsapp !== undefined) {
      const numero = String(occupantWhatsapp).trim();
      if (!numero) return res.status(400).json({ error: "Le numéro ne peut pas être vide" });
      data.occupantWhatsapp = numero;
    }

    if (endsAt !== undefined) {
      // Une date vide retire l'échéance : l'occupation reste alors active
      // indéfiniment (`estActive`), et c'est délibéré — on ne coupe pas un
      // client sur une date qu'on n'a pas. `normaliserDateFin` traite aussi le
      // décalage du Bénin, sans quoi « jusqu'au 30 » s'éteignait au tout début
      // du 30.
      const borne = normaliserDateFin(endsAt);
      if (!borne.ok) {
        return res.status(400).json({ error: "Date de fin illisible" });
      }
      data.endsAt = borne.date;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "Aucune modification demandée" });
    }

    const existe = await prisma.profileOccupancy.findUnique({
      where: { id: req.params.id },
      select: { id: true, releasedAt: true },
    });
    if (!existe) return res.status(404).json({ error: "Occupation introuvable" });

    // Une occupation close appartient à l'historique, et l'historique est ce
    // qui tranche un litige : le réécrire changerait qui a occupé ce profil et
    // quand. `deplacerOccupation` refuse déjà une occupation close pour la
    // même raison — corriger une saisie n'est pas refaire l'histoire.
    if (existe.releasedAt) {
      return res.status(409).json({
        error: "Cette occupation est close — son historique n'est plus modifiable.",
      });
    }

    const occupation = await prisma.profileOccupancy.update({
      where: { id: req.params.id },
      data,
    });
    return res.json({ occupation });
  } catch (err) {
    logger.error("Erreur modifierOccupation", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Supprime un profil, à condition qu'aucune occupation n'y soit rattachée —
// même close. Un profil ayant hébergé un client porte son historique, et cet
// historique est ce qui permet de trancher un litige. Le doublon créé par
// erreur, lui, n'a rien derrière lui et part sans discussion.
// Ce qu'une suppression forcée emporte, nommé pour le compte rendu à l'admin.
// « client placé » plutôt que « occupation » : le mot qui compte pour celui qui
// valide, c'est le nombre de personnes qui perdent leur accès.
const LIBELLES_PROFIL = {
  occupations: ["client placé", "clients placés"],
};

const LIBELLES_COMPTE = {
  occupations: ["client placé", "clients placés"],
  demandes: ["demande de code", "demandes de code"],
};

// Efface des occupations et les demandes de code qui s'y accrochent.
//
// `OtpRequest.occupancyId` est obligatoire : effacer une occupation sans ses
// demandes fait rejeter toute la transaction par PostgreSQL. Les demandes
// partent donc d'abord, et leurs identifiants sont relus ici plutôt que
// devinés — un `deleteMany` par relation imbriquée n'existe pas côté Prisma.
//
// `filtre` est un `where` de `ProfileOccupancy` : un profil précis, ou toutes
// les occupations d'un compte. Rend le nombre d'occupations effacées.
async function effacerOccupations(tx, filtre) {
  const occupations = await tx.profileOccupancy.findMany({
    where: filtre,
    select: { id: true },
  });
  const ids = occupations.map((o) => o.id);
  if (ids.length === 0) return 0;

  await tx.otpRequest.deleteMany({ where: { occupancyId: { in: ids } } });
  await tx.profileOccupancy.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

// Suppression d'un profil, quel que soit le chemin qui la demande.
//
// DEUX routes suppriment un `FamilyAccount` : `/admin/profils/:id`, ouverte
// avec le partage de profils, et `/admin/accounts/:id`, héritée du modèle où
// un « compte famille » ÉTAIT le profil. Le panel appelle encore la seconde
// depuis la section des formules. Elles doivent donc partager exactement la
// même garde — sans quoi l'une refuse proprement pendant que l'autre laisse
// PostgreSQL rejeter la suppression et renvoie son message interne, en
// anglais, à l'administrateur.
//
// `force` lève la garde et emporte l'historique du profil — occupations et
// demandes de code comprises. Même raison que pour une formule : un profil
// créé par erreur, ou dont le compte streaming est mort, restait sinon dans le
// panel pour toujours dès qu'un client y était passé une fois.
//
// Rend `{ statut, message?, profil?, bilan? }` : la traduction en HTTP
// appartient aux deux handlers, dont les libellés diffèrent.
async function retirerProfil(id, { force = false } = {}) {
  const profil = await prisma.familyAccount.findUnique({
    where: { id },
    select: { id: true, profile: true },
  });
  if (!profil) return { statut: "introuvable" };

  // Comptage et suppression sous le MÊME verrou que celui pris par
  // `revendiquerPlace` avant de créer une occupation : comptés hors
  // transaction, un paiement atterrissant entre les deux ferait échouer la
  // suppression sur une violation de clé étrangère, remontée en 500.
  const verdict = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "FamilyAccount" WHERE id = ${profil.id} FOR UPDATE`;
    const occupations = await tx.profileOccupancy.count({
      where: { profileId: profil.id },
    });
    if (!force) {
      const v = verifierSuppression([
        { nombre: occupations, singulier: "occupation", pluriel: "occupations" },
      ]);
      if (!v.ok) return v;
    } else {
      await effacerOccupations(tx, { profileId: profil.id });
    }

    await tx.familyAccount.delete({ where: { id: profil.id } });
    return { ok: true, bilan: { occupations } };
  });

  if (!verdict.ok) return { statut: "refuse", message: verdict.message };
  return { statut: "ok", profil, bilan: verdict.bilan };
}

async function supprimerProfil(req, res) {
  try {
    const force = forceDemandee(req);
    const r = await retirerProfil(req.params.id, { force });
    if (r.statut === "introuvable") {
      return res.status(404).json({ error: "Profil introuvable" });
    }
    if (r.statut === "refuse") return res.status(409).json({ error: r.message });
    if (force) {
      logger.warn("Profil supprimé de force", { profilId: r.profil.id, ...r.bilan });
    }
    return res.json({
      message: `Profil « ${r.profil.profile} » supprimé${resumeSuppression(r.bilan, LIBELLES_PROFIL)}`,
      ...r.bilan,
    });
  } catch (err) {
    logger.error("Erreur supprimerProfil", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Supprime un compte streaming et ses profils, à condition qu'aucun d'eux
// n'ait jamais hébergé personne. Les profils partent avec le compte : seuls,
// ils ne veulent plus rien dire, et la relation n'a pas de suppression en
// cascade — les laisser derrière produirait des orphelins invisibles au panel.
//
// `?force=1` emporte cet historique. Sans cela le compte serait la dernière
// ligne indéboulonnable du panel, alors que chacun de ses profils peut
// désormais partir : l'admin devrait tous les forcer un à un pour arriver au
// même résultat, en croyant chaque fois que le compte, lui, est protégé.
async function supprimerCompte(req, res) {
  try {
    const force = forceDemandee(req);
    const compte = await prisma.streamingAccount.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true, profils: { select: { id: true } } },
    });
    if (!compte) return res.status(404).json({ error: "Compte introuvable" });

    // Même raison que pour un profil : le verrou est celui que prend
    // `revendiquerPlace` avant d'occuper une place de ce compte.
    const verdict = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "StreamingAccount" WHERE id = ${compte.id} FOR UPDATE`;
      const occupations = await tx.profileOccupancy.count({
        where: { profile: { accountId: compte.id } },
      });
      const demandes = await tx.otpRequest.count({ where: { accountId: compte.id } });

      if (!force) {
        const v = verifierSuppression([
          { nombre: occupations, singulier: "occupation", pluriel: "occupations" },
          { nombre: demandes, singulier: "demande de code", pluriel: "demandes de code" },
        ]);
        if (!v.ok) return v;
      } else {
        await effacerOccupations(tx, { profile: { accountId: compte.id } });
        // Une demande peut survivre à son occupation : `OtpRequest` pointe sur
        // le COMPTE autant que sur l'occupation, et celles reçues hors
        // placement resteraient sinon accrochées à la ligne qu'on efface.
        await tx.otpRequest.deleteMany({ where: { accountId: compte.id } });
      }

      await tx.familyAccount.deleteMany({ where: { accountId: compte.id } });
      await tx.streamingAccount.delete({ where: { id: compte.id } });
      return { ok: true, bilan: { occupations, demandes } };
    });
    if (!verdict.ok) return res.status(409).json({ error: verdict.message });

    if (force) {
      logger.warn("Compte supprimé de force", { compteId: compte.id, ...verdict.bilan });
    }
    return res.json({
      message:
        `Compte ${compte.email} supprimé (${compte.profils.length} profil(s))` +
        resumeSuppression(verdict.bilan, LIBELLES_COMPTE),
      ...verdict.bilan,
    });
  } catch (err) {
    logger.error("Erreur supprimerCompte", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Renvoie les identifiants au client qui occupe ce profil.
//
// Il n'existait AUCUN moyen d'envoyer des identifiants depuis le panel : le
// seul chemin d'envoi etait le paiement lui-meme. Quand une livraison
// automatique echouait — aucun profil disponible le jour du paiement, session
// WhatsApp tombee, client ayant perdu le message — la commande restait payee et
// muette, et personne ne pouvait la rattraper. `setFamilyAccountClient`
// marquait bien le profil « envoye », mais n'envoyait rien.
//
// L'action porte sur l'OCCUPATION, pas sur le profil seul : c'est elle qui dit
// a la fois quel profil et quel client. Une occupation close n'est pas servie —
// ce client n'a plus sa place, lui renvoyer les identifiants lui rendrait un
// acces qu'on lui a retire.
async function envoyerIdentifiants(req, res) {
  try {
    const occupation = await prisma.profileOccupancy.findUnique({
      where: { id: req.params.id },
      include: {
        profile: {
          select: {
            profile: true, profilePassword: true,
            email: true, passwordEncrypted: true,
            account: { select: { email: true, passwordEncrypted: true } },
          },
        },
        order: {
          select: {
            id: true, clientName: true, clientWhatsapp: true, clientEmail: true,
            service: { select: { name: true, slug: true } },
          },
        },
      },
    });
    if (!occupation) return res.status(404).json({ error: "Occupation introuvable" });
    if (occupation.releasedAt) {
      return res.status(409).json({
        error: "Cette occupation est close — le client n'occupe plus ce profil.",
      });
    }

    const credentials = dechiffrerIdentifiants(occupation.profile);
    // Un mot de passe illisible partirait comme « null » chez le client. Mieux
    // vaut ne rien envoyer et le dire : la cause est une cle AES qui a change,
    // pas quelque chose que l'administrateur peut corriger en reessayant.
    if (credentials.erreurDechiffrement || !credentials.password) {
      return res.status(500).json({
        error:
          "Mot de passe du compte illisible — rien n'a ete envoye. " +
          "Verifiez AES_SECRET_KEY, ou ressaisissez le mot de passe du compte.",
      });
    }

    const serviceName = occupation.order.service.name;

    // L'occupation fait foi sur le destinataire : sur une commande cadeau, elle
    // porte le nom et le numero du DESTINATAIRE, pas de l'acheteur. Meme regle
    // que le bot OTP.
    const parWhatsapp = await whatsapp.sendSubscriptionCredentials({
      clientWhatsapp: occupation.occupantWhatsapp,
      clientName: occupation.occupantName,
      serviceName,
      credentials,
    });

    // L'e-mail part a l'adresse de facturation de la commande, comme apres un
    // paiement : c'est la seule que nous connaissions.
    const parEmail = await emailSvc.sendSubscriptionCredentials({
      clientEmail: occupation.order.clientEmail,
      clientName: occupation.occupantName,
      serviceName,
      serviceSlug: occupation.order.service.slug,
      credentials,
    });

    logger.info(`Identifiants renvoyes manuellement — ${serviceName}`, {
      occupation: occupation.id,
      destinataire: occupation.occupantWhatsapp,
      parWhatsapp,
      parEmail,
    });

    if (!parWhatsapp && !parEmail) {
      return res.status(502).json({
        error:
          "Aucun envoi n'a abouti — WhatsApp et e-mail ont tous deux echoue. " +
          "Verifiez la session WhatsApp, puis reessayez.",
      });
    }

    return res.json({
      parWhatsapp,
      parEmail,
      message: [
        parWhatsapp ? "WhatsApp envoye" : "WhatsApp echoue",
        parEmail ? "e-mail envoye" : "e-mail non envoye",
      ].join(", "),
    });
  } catch (err) {
    logger.error("Erreur envoyerIdentifiants", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Demande de code (public) ─────────────────────────────────────────────────
// Aucune vérification d'identité à la saisie : c'est un choix assumé, et le
// garde-fou est ailleurs — le code part TOUJOURS vers le numéro enregistré de
// l'occupant, jamais vers celui qui a rempli ce formulaire. Un tiers qui
// ouvrirait une fenêtre avec le numéro d'un client ne recevrait donc rien ; il
// lui enverrait un code que ce client n'attendait pas.
//
// La réponse ne dit jamais si le numéro correspond à un abonnement : ce serait
// un moyen de tester des numéros au hasard pour découvrir qui est client.
//
// Le plafond anti-abus (raison "trop-de-demandes") n'est atteignable QUE si le
// numéro correspond a une occupation active : `ouvrirDemandes` ne consulte ce
// compteur qu'apres avoir trouve au moins une occupation pour ce numero (sinon
// elle rend "aucune-occupation-active" plus tot, sans jamais toucher au
// compteur). Un 429 distinct du succes serait donc un oracle : six requetes
// suffiraient a distinguer un numero client d'un numero quelconque, sous le
// budget meme de `strictLimiter`. Sur le canal web, on rend donc EXACTEMENT le
// message de succes meme quand le plafond est atteint — la fenetre ne s'ouvre
// pas plus pour autant, seule la reponse HTTP se tait. Sur WhatsApp
// (`whatsappEcoute.js`), l'identite de l'expediteur est etablie par le canal
// lui-meme : il n'y a rien a dissimuler, et un client qui a suivi la
// procedure merite qu'on lui dise explicitement de patienter.
async function demanderCode(req, res) {
  try {
    const whatsapp = req.body?.whatsapp;
    if (!whatsapp) return res.status(400).json({ error: "Numéro WhatsApp requis" });

    const { raison, demandes } = await ouvrirDemandes({ numero: whatsapp, canal: "web" });

    if (raison === "numero-invalide") {
      return res.status(400).json({ error: "Numéro invalide" });
    }

    // La reponse ne dit rien, le journal du serveur dit tout.
    //
    // Le visiteur recoit la meme phrase dans les trois cas — c'est ce qui
    // empeche de tester des numeros au hasard pour decouvrir qui est client.
    // Mais rien n'etait ecrit cote serveur non plus : quand un client
    // rapportait « votre page ne marche pas », il n'existait AUCUNE trace a
    // consulter, et l'exploitant ne pouvait pas distinguer un numero mal saisi
    // d'une panne reelle. Le silence etait pour le visiteur, pas pour nous.
    if (raison === "ouvertes") {
      logger.info(`Demande de code (web) : ${demandes?.length ?? 0} fenetre(s) ouverte(s)`, {
        numero: whatsapp,
      });
    } else {
      logger.warn(`Demande de code (web) sans effet — ${raison}`, { numero: whatsapp });
    }

    // "ouvertes", "aucune-occupation-active" et "trop-de-demandes" rendent
    // volontairement la meme reponse : voir le commentaire de fonction.
    return res.json({
      message:
        "Demande enregistrée. Connectez-vous maintenant à votre service : c'est " +
        "votre tentative de connexion qui déclenche l'envoi du code. Si rien " +
        "n'arrive dans les minutes qui suivent, écrivez-nous sur WhatsApp.",
    });
  } catch (err) {
    logger.error("Erreur demanderCode", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Journal des demandes (admin) ─────────────────────────────────────────────
async function listerDemandes(req, res) {
  try {
    const demandes = await journalDemandes(req.query.limit);
    const maintenant = new Date();
    return res.json({
      demandes: demandes.map((d) => ({
        id: d.id,
        canal: d.canal,
        requestedAt: d.requestedAt,
        expiresAt: d.expiresAt,
        servedAt: d.servedAt,
        otpLogId: d.otpLogId,
        ouverte: !d.servedAt && new Date(d.expiresAt) > maintenant,
        compte: d.account?.email || null,
        service: d.account?.service?.name || null,
        occupant: d.occupancy?.occupantName || null,
        occupantWhatsapp: d.occupancy?.occupantWhatsapp || null,
        profil: d.occupancy?.profile?.profile || null,
      })),
    });
  } catch (err) {
    logger.error("Erreur listerDemandes", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── ADMIN — Réserve de liens ──────────────────────────────────────────────────

async function getPoolLinks(req, res) {
  try {
    const links = await prisma.linkAccessLink.findMany({
      where: { planId: req.params.planId },
      orderBy: { createdAt: "asc" },
    });
    return res.json({ links });
  } catch (err) {
    logger.error("Erreur getPoolLinks", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function addPoolLink(req, res) {
  try {
    const brut = req.body.link;
    if (!lienValide(brut)) {
      return res.status(400).json({ error: "Lien invalide — attendu une adresse http ou https" });
    }
    const link = await prisma.linkAccessLink.create({
      data: {
        planId: req.params.planId,
        link: String(brut).trim(),
        status: "disponible",
      },
    });
    return res.status(201).json({ link });
  } catch (err) {
    // P2002 = violation de l'index unique (planId, link). C'est le cas de loin
    // le plus fréquent ici : l'admin recolle une invitation déjà déposée. Le
    // message générique « Ajout impossible » ne lui apprenait rien, et comme
    // l'écran tronque les URL il n'avait aucun moyen de repérer le doublon
    // dans la liste. On le nomme explicitement.
    if (err.code === "P2002") {
      logger.warn("Lien déjà présent dans la réserve", { planId: req.params.planId });
      return res
        .status(400)
        .json({ error: "Ce lien figure déjà dans la réserve de cette formule" });
    }
    logger.error("Erreur addPoolLink", { err: err.message });
    return res.status(400).json({ error: "Ajout impossible" });
  }
}

async function deletePoolLink(req, res) {
  try {
    // Comme pour `claimLinkAccessLink`, la garde `status: "disponible"` doit
    // vivre DANS le `where` de l'écriture, pas dans une lecture qui la
    // précède : un `findUnique` puis un `delete` inconditionnel laisseraient
    // une fenêtre entre les deux où un paiement concurrent (webhook, donc
    // asynchrone) peut faire passer ce même lien à "envoyé" via
    // `claimLinkAccessLink` — le `delete` partirait quand même et effacerait
    // la trace de ce que ce client a reçu. `deleteMany` accepte un filtre sur
    // une colonne non unique (contrairement à `delete`), ce qui permet à
    // Postgres d'évaluer la condition au moment même de l'écriture : la
    // fenêtre disparaît.
    const resultat = await prisma.linkAccessLink.deleteMany({
      where: { id: req.params.id, status: "disponible" },
    });
    if (resultat.count === 1) {
      return res.json({ message: "Lien supprimé" });
    }

    // `count === 0` : soit le lien n'existe pas, soit il existe mais n'était
    // plus "disponible" au moment de l'écriture. La suppression (ou son
    // absence) est déjà actée ; cette lecture après coup ne fait que choisir
    // le bon message, elle ne rouvre aucune fenêtre.
    const existant = await prisma.linkAccessLink.findUnique({
      where: { id: req.params.id },
      select: { status: true },
    });
    if (!existant) return res.status(404).json({ error: "Lien introuvable" });

    // Un lien déjà attribué est la trace de ce qu'a reçu un client : le
    // supprimer effacerait la seule preuve de ce qui lui a été envoyé.
    return res
      .status(400)
      .json({ error: "Ce lien a déjà été attribué à un client et ne peut plus être supprimé" });
  } catch (err) {
    logger.error("Erreur deletePoolLink", { err: err.message });
    return res.status(400).json({ error: "Suppression impossible" });
  }
}

// ── ADMIN — Link access ───────────────────────────────────────────────────────

async function getLinkClients(req, res) {
  try {
    const clients = await prisma.linkAccessClient.findMany({
      where: { planId: req.params.planId },
      orderBy: { paidAt: "desc" },
    });
    return res.json({ clients });
  } catch (err) {
    logger.error("Erreur getLinkClients", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function addLinkClient(req, res) {
  try {
    const client = await prisma.linkAccessClient.create({
      data: {
        planId: req.params.planId,
        name: req.body.name,
        whatsapp: req.body.whatsapp,
        email: req.body.email || null,
        status: "en_attente",
      },
    });
    return res.status(201).json({ client });
  } catch (err) {
    logger.error("Erreur addLinkClient", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteLinkClient(req, res) {
  try {
    await prisma.linkAccessClient.delete({ where: { id: req.params.id } });
    return res.json({ message: "Client d'accès par lien supprimé" });
  } catch (err) {
    logger.error("Erreur deleteLinkClient", { err: err.message });
    return res.status(404).json({ error: "Client introuvable ou déjà supprimé" });
  }
}

async function sendLinkToClient(req, res) {
  try {
    const { link } = req.body;
    if (!link) return res.status(400).json({ error: "Lien requis" });

    const client = await prisma.linkAccessClient.findUnique({
      where: { id: req.params.id },
      include: { plan: { include: { service: true } } },
    });
    if (!client) return res.status(404).json({ error: "Client introuvable" });

    // ── Ce lien appartient-il bien a la formule de ce client ? ──────────────
    //
    // Le lien arrive du corps de la requete : c'est l'administrateur qui le
    // choisit, et rien ne verifiait qu'il venait de la bonne reserve. Deux
    // formules Apple Music portent le meme nom (« Individuel », 1 500 et
    // 16 000 XOF) et sont indiscernables a l'ecran : envoyer l'abonnement d'un
    // an a un client qui a paye un mois, ou l'inverse, ne demandait qu'un
    // instant d'inattention et ne laissait aucune trace.
    //
    // On ne refuse que ce qu'on peut PROUVER faux : un lien present dans la
    // reserve d'une AUTRE formule. Un lien absent de toute reserve reste
    // accepte — l'envoi manuel d'un lien ponctuel est un usage legitime, et le
    // bloquer casserait un flux qui marche.
    const ailleurs = await prisma.linkAccessLink.findFirst({
      where: { link: String(link).trim(), planId: { not: client.planId } },
      include: { plan: { select: { label: true, price: true } } },
    });
    if (ailleurs) {
      return res.status(409).json({
        error:
          `Ce lien appartient à la réserve de la formule « ${ailleurs.plan.label} » ` +
          `(${ailleurs.plan.price} XOF), pas à celle de ce client. ` +
          `Choisissez un lien de sa formule.`,
      });
    }

    // Les deux envois rendent des booléens fiables (`sendMessage` de
    // whatsapp.js, `envoyer` d'email.js) : les ignorer, comme le faisait le
    // code précédent, revenait à marquer « envoyé » une ligne dont rien n'était
    // parti — session WhatsApp tombée et client sans e-mail, l'admin voyait une
    // confirmation verte et la ligne quittait la file pour toujours.
    const whatsappOk = await whatsapp
      .sendLinkAccess({
        clientWhatsapp: client.whatsapp,
        clientName: client.name,
        serviceName: client.plan.service.name,
        link,
      })
      .catch(() => false);

    const emailOk = client.email
      ? await emailSvc
          .sendLinkAccess({
            clientEmail: client.email,
            clientName: client.name,
            serviceName: client.plan.service.name,
            link,
          })
          .catch(() => false)
      : false;

    // Règle unique et déjà testée (linkPool.js) : un seul canal abouti suffit.
    // Ne pas la redoubler ici — deux copies divergeraient.
    const statut = statutApresEnvoi({ whatsappOk, emailOk });

    if (statut !== "envoyé") {
      // Rien n'est parti : la ligne reste « en_attente » et garde le lien
      // saisi, pour que l'administrateur retrouve le champ pré-rempli et
      // réessaie en un clic. Aucun lien de réserve n'est consommé — le client
      // n'a rien reçu, il serait absurde de retirer une invitation du stock.
      await prisma.linkAccessClient.update({
        where: { id: req.params.id },
        data: { link },
      });
      logger.error("Envoi manuel du lien : aucun canal n'a abouti", {
        clientId: req.params.id,
        whatsapp: client.whatsapp,
        aUnEmail: !!client.email,
      });
      return res.status(502).json({
        error:
          "Aucun canal n'a abouti : ni WhatsApp ni e-mail n'ont pu délivrer le lien. " +
          "Le client reste en attente, le lien est conservé — vérifiez la session " +
          "WhatsApp puis réessayez.",
      });
    }

    // Le lien vient peut-être de la réserve affichée juste au-dessus de cet
    // écran : l'admin recopie volontiers une invitation de cette liste. Sans
    // cette consommation, le lien resterait « disponible » et la réservation
    // automatique le servirait à un SECOND client au paiement suivant — deux
    // clients sur la même invitation. Un lien saisi à la main qui ne figure pas
    // dans la réserve ne correspond simplement à rien : `updateMany` affecte
    // zéro ligne, sans erreur.
    await prisma.linkAccessLink.updateMany({
      where: { planId: client.planId, link, status: "disponible" },
      data: { status: "envoyé", claimedAt: new Date() },
    });

    await prisma.linkAccessClient.update({
      where: { id: req.params.id },
      data: { link, status: "envoyé", sentAt: new Date() },
    });

    logger.info(
      `✅ Lien envoyé à ${client.whatsapp} pour ${client.plan.service.name}`,
    );
    return res.json({ message: "Lien envoyé avec succès" });
  } catch (err) {
    logger.error("Erreur sendLinkToClient", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function setOrderExpiry(req, res) {
  try {
    const { expiresAt } = req.body;
    let valeur = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "Date invalide" });
      }
      valeur = d;
    }

    const existante = await prisma.subscriptionOrder.findUnique({
      where: { id: req.params.id },
      select: { expiresAt: true, plan: { select: { aVie: true } } },
    });
    if (!existante) {
      return res.status(404).json({ error: "Commande introuvable" });
    }

    // Poser une echeance sur un abonnement a vie y met fin — c'est meme la
    // SEULE facon de le faire, et elle passerait pour une correction de
    // routine. Le terme se decide sur la formule, pas commande par commande :
    // si l'offre change, on decoche « a vie » la-bas, et le changement est
    // alors visible par tout le monde.
    //
    // Effacer une date (`valeur` nul) reste permis : c'est ce qui rattrape une
    // commande a vie qui aurait recu une date avant ce controle.
    if (valeur && estAVie(existante.plan)) {
      return res.status(409).json({
        error:
          "Cet abonnement est à vie — il n'a pas d'échéance. " +
          "Modifiez la formule si l'offre a changé.",
      });
    }

    // La règle du projet est « un seul rappel par abonnement » ; on la lit
    // désormais comme « un seul rappel par date d'expiration ». Sans ça, un
    // admin qui corrige une date saisie par erreur (ex. 4 septembre au lieu
    // de 4 décembre) laisse `reminderSentAt` posé par le rappel déjà envoyé
    // sur la mauvaise date : le 3 décembre, plus aucun rappel ne partirait,
    // et rien dans le panel ne préviendrait l'admin que le client a été
    // condamné au silence. On compare par valeur temporelle (`getTime()`),
    // pas par identité d'objet, en traitant explicitement le passage de
    // `null` à une date et l'inverse. Si la date est identique, on ne touche
    // pas à `reminderSentAt` : réenregistrer la même valeur ne doit pas
    // rouvrir la porte à un second envoi.
    const ancienne = existante.expiresAt;
    const dateChangee =
      (ancienne === null) !== (valeur === null) ||
      (ancienne !== null && valeur !== null && ancienne.getTime() !== valeur.getTime());

    const data = { expiresAt: valeur };
    if (dateChangee) {
      data.reminderSentAt = null;
    }

    const order = await prisma.subscriptionOrder.update({
      where: { id: req.params.id },
      data,
    });
    return res.json({ order });
  } catch (err) {
    logger.error("Erreur setOrderExpiry", { err: err.message });
    return res.status(400).json({ error: "Modification impossible" });
  }
}

// ── Client hors site ─────────────────────────────────────────────────────────
//
// Refonte OTP du 13/10/2026. Des clients detenaient les identifiants du compte
// Netflix B sans avoir jamais commande sur le site. Invisibles pour le bot, qui
// envoyait donc tous les codes de ce compte au seul client enregistre — « c'est
// toujours Tounde qui recoit ». Ce point d'entree les enregistre sur leur
// profil : une commande `HORS-SITE` payee (montant saisi, 0 par defaut) et son
// occupation, dans la meme transaction.
//
// Les verrous et la regle de capacite sont ceux de `placerCommande`, dans le
// meme ordre. La commande n'est creee qu'APRES que la place a ete accordee : un
// refus de capacite ne laisse aucune commande orpheline derriere lui.
async function enregistrerClientHorsSite(req, res) {
  try {
    const profil = await prisma.familyAccount.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        profile: true,
        planId: true,
        plan: { select: { id: true, aVie: true, serviceId: true } },
        account: { select: { id: true, serviceId: true } },
      },
    });
    if (!profil) return res.status(404).json({ error: "Profil introuvable" });
    if (!profil.account) {
      return res.status(409).json({
        error: "Ce profil n'est rattaché à aucun compte streaming — rattachez-le avant d'y placer un client.",
      });
    }
    // Sans formule, le profil ne correspond a aucune offre : la commande
    // n'aurait pas de formule, et le placement automatique l'ignore deja.
    if (!profil.plan) {
      return res.status(409).json({
        error: "Ce profil n'a pas de formule — choisissez-en une avant d'y enregistrer un client.",
      });
    }
    if (profil.plan.serviceId !== profil.account.serviceId) {
      return res.status(409).json({
        error: "La formule de ce profil appartient à un autre service que son compte — corrigez-la d'abord.",
      });
    }

    const saisie = validerClientHorsSite(req.body || {}, { aVie: estAVie(profil.plan) });
    if (!saisie.ok) return res.status(400).json({ error: saisie.message });
    const { nom, whatsapp, email, montant, finLe } = saisie.valeurs;

    const maintenant = new Date();
    const resultat = await prisma.$transaction(
      async (tx) => {
        const [compteVerrouille] = await tx.$queryRaw`
          SELECT "maxFluxSimultanes" FROM "StreamingAccount"
          WHERE id = ${profil.account.id} FOR UPDATE`;
        const [profilVerrouille] = await tx.$queryRaw`
          SELECT capacite FROM "FamilyAccount"
          WHERE id = ${profil.id} FOR UPDATE`;
        if (!compteVerrouille || !profilVerrouille) return { conflit: "disparu" };

        const occupantsProfil = await tx.profileOccupancy.count({
          where: { profileId: profil.id, ...filtreActive(maintenant) },
        });
        const fluxCompte = await tx.profileOccupancy.count({
          where: { profile: { accountId: profil.account.id }, ...filtreActive(maintenant) },
        });
        const verdict = verifierPlacement({
          capacite: Number(profilVerrouille.capacite),
          occupantsActifs: occupantsProfil,
          fluxMax: Number(compteVerrouille.maxFluxSimultanes),
          fluxActifs: fluxCompte,
        });
        if (!verdict.ok) return { refus: verdict };

        const commande = await tx.subscriptionOrder.create({
          data: {
            serviceId: profil.account.serviceId,
            planId: profil.plan.id,
            clientName: nom,
            clientWhatsapp: whatsapp,
            clientEmail: email,
            amount: montant,
            status: "CONFIRMED",
            // Reconnaissable dans les listes et unique par formule : la
            // contrainte (sourceOrderRef, planId) refuserait deux « HORS-SITE ».
            sourceOrderRef: `HORS-SITE-${crypto.randomUUID().slice(0, 8)}`,
            expiresAt: finLe,
          },
        });
        const occupation = await tx.profileOccupancy.create({
          data: {
            profileId: profil.id,
            orderId: commande.id,
            occupantName: nom,
            occupantWhatsapp: whatsapp,
            startedAt: maintenant,
            endsAt: finLe,
          },
        });
        await synchroniserMiroirProfil(tx, profil.id, maintenant);
        return { commande, occupation };
      },
      { timeout: 15000, maxWait: 10000 },
    );

    if (resultat.conflit === "disparu") {
      return res.status(409).json({
        error: "Ce profil ou son compte vient d'être supprimé — rechargez la page.",
      });
    }
    if (resultat.refus) return res.status(409).json({ error: resultat.refus.message });

    logger.info("Client hors site enregistré", {
      profil: profil.profile,
      commande: resultat.commande.id,
    });
    return res.status(201).json({ commande: resultat.commande, occupation: resultat.occupation });
  } catch (err) {
    logger.error("Erreur enregistrerClientHorsSite", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// ── Journal des codes ────────────────────────────────────────────────────────
// Chaque mail de service traite par le bot : d'ou il vient, de quel type, et
// ce qui en a ete fait. Sans lui, l'audit du 13/10 a du reconstituer les envois
// a partir des journaux du serveur, qui ne couvrent que deux jours et demi.
async function listerJournalCodes(req, res) {
  try {
    const limite = Math.min(Math.max(Number.parseInt(req.query.limite, 10) || 100, 1), 500);
    const lignes = await prisma.otpCourriel.findMany({
      orderBy: { createdAt: "desc" },
      take: limite,
      select: {
        id: true, createdAt: true, recuLe: true, boite: true, adresseEcrite: true,
        service: true, type: true, code: true, decision: true, raison: true,
        destinataire: true, sujet: true,
      },
    });
    return res.json({ lignes });
  } catch (err) {
    logger.error("Erreur listerJournalCodes", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

module.exports = {
  enregistrerClientHorsSite,
  listerJournalCodes,
  // Public
  getServices,
  getServiceBySlug,
  createOrder,
  // Admin — commandes
  getAllOrders,
  deleteOrder,
  getAdminDashboard,
  updateCategoryOrder,
  setOrderExpiry,
  // Non appelée par aucune route HTTP : exportée uniquement pour être
  // exercée directement par le script de vérification de la tâche 4, seul
  // moyen d'éprouver la sûreté en concurrence de cette fonction (aucune
  // route ne déclenche de réservation).
  claimLinkAccessLink,
  // Admin — services
  createService,
  updateService,
  deleteService,
  // Admin — plans
  createPlan,
  updatePlan,
  deletePlan,
  // Admin — comptes famille
  getFamilyAccounts,
  addFamilyAccount,
  updateFamilyAccount,
  setFamilyAccountClient,
  deleteFamilyAccount,
  // Admin — comptes streaming, profils et occupations (partage de profils)
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
  modifierOccupation,
  supprimerProfil,
  supprimerCompte,
  envoyerIdentifiants,
  // Demande de code
  demanderCode,
  listerDemandes,
  // Admin — réserve de liens
  getPoolLinks,
  addPoolLink,
  deletePoolLink,
  // Admin — link access
  getLinkClients,
  addLinkClient,
  deleteLinkClient,
  sendLinkToClient,
  // Interne
  assignSubscriptionAfterPayment,
  assignSubscriptionFromOrderItem,
};
