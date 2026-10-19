const logger = require("../utils/logger");
const { buildGoogleMapsLink } = require("../utils/maps");
const { getClient, isConnected } = require("./whatsappClient");
const { memeNumero } = require("../modules/subscriptions/demandeCode");

const {
  gras,
  champ,
  assembler,
  SIGNATURE,
  ENTETE,
} = require("./whatsappFormat");

// Conserve pour les gabarits destines a l ADMINISTRATEUR, qui gardent leur
// mise en forme d origine : ce sont des rapports de diagnostic, pas des
// messages clients.
const HEADER = ENTETE;

// ── Envoie vers un JID DÉJÀ résolu (1 retry automatique) ─────────────────────
//
// Ce chemin ne touche pas à l'adresse qu'on lui donne. C'est sa raison d'être :
// répondre à un message entrant impose de réutiliser le JID d'origine tel quel.
// Sur un identifiant masqué (`…@lid`, voir whatsappMessage.js), le reconstruire
// à partir de ses chiffres donnerait `<chiffres du LID>@s.whatsapp.net` — une
// adresse qui n'existe pas, vers laquelle le message part sans jamais arriver
// et sans que rien ne le signale.
async function sendMessageToJid(jid, message) {
  if (!jid || typeof jid !== "string" || !jid.includes("@")) {
    logger.warn("JID invalide — message ignoré", { jid });
    return false;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const sock = getClient();
      if (!sock || !isConnected()) {
        logger.warn("WhatsApp non connecté — message non envoyé", { jid });
        return false;
      }

      await sock.sendMessage(jid, { text: message });
      logger.info(`✅ WhatsApp envoyé à ${jid}`);
      return true;
    } catch (err) {
      if (attempt === 1) {
        logger.warn(`⚠️ Envoi WhatsApp échoué (tentative 1) — retry dans 2s`, {
          jid,
          err: err.message,
        });
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        logger.error(`❌ Envoi WhatsApp définitivement échoué`, {
          jid,
          err: err.message,
        });
        return false;
      }
    }
  }
  return false;
}

// ── Envoie à un NUMÉRO (le JID est reconstruit) ──────────────────────────────
// Chemin de tous les envois sortants à l'initiative de la boutique, où l'on ne
// dispose que d'un numéro saisi à la main. Ne PAS l'employer pour répondre à un
// message entrant : voir `sendMessageToJid`.
async function sendMessage(phone, message) {
  const cleanPhone = String(phone ?? "").replace(/\D/g, "");
  if (!cleanPhone) {
    logger.warn("Numéro invalide — message ignoré", { phone });
    return false;
  }
  return sendMessageToJid(`${cleanPhone}@s.whatsapp.net`, message);
}

// ── Nouvelle commande → ADMIN ─────────────────────────────────────────────────
async function sendNewOrderToAdmin(order) {
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (!vendorPhone) {
    logger.warn("VENDOR_WHATSAPP_NUMBER non défini — notif admin ignorée");
    return false;
  }

  const cleanClientPhone = order.guestWhatsapp.replace(/\D/g, "");
  const waClientLink = `https://wa.me/${cleanClientPhone}`;
  const adminLink = `${process.env.FRONTEND_URL}/admin/commandes`;

  const hasDelivery = !!order.city;
  const mapsLink =
    order.deliveryLat && order.deliveryLng
      ? buildGoogleMapsLink(
          order.deliveryLat,
          order.deliveryLng,
          `${order.guestName} - ${order.neighborhood || order.city}`,
        )
      : null;

  const itemsList = order.items
    .map((i) => {
      const variantLine =
        Array.isArray(i.variants) && i.variants.length
          ? "\n    " + i.variants.map((v) => `${v.typeName} : ${v.value}`).join(" | ")
          : "";
      return `  • ${i.productName} ×${i.quantity} — ${i.totalPrice.toLocaleString("fr-FR")} FCFA${variantLine}`;
    })
    .join("\n");

  const lines = [
    HEADER,
    ``,
    `🛎️ *NOUVELLE COMMANDE — ${order.reference}*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `👤 *CLIENT*`,
    `Nom : ${order.guestName}`,
    `WhatsApp : ${order.guestWhatsapp}`,
    order.guestEmail ? `Email : ${order.guestEmail}` : null,
    `Contacter : ${waClientLink}`,
    ``,
    order.isGift
      ? [
          `🎁 *CADEAU POUR*`,
          `Destinataire : ${order.giftName}`,
          `WhatsApp : ${order.giftWhatsapp}`,
          ``,
        ].join("\n")
      : null,
    hasDelivery ? `📦 *LIVRAISON*` : `📦 *COMMANDE NUMÉRIQUE*`,
    hasDelivery ? `Ville : ${order.city}` : null,
    hasDelivery && order.neighborhood ? `Quartier : ${order.neighborhood}` : null,
    hasDelivery ? `Créneau : ${order.deliverySlot || "Non précisé"}` : null,
    hasDelivery && order.instructions ? `Instructions : ${order.instructions}` : null,
    hasDelivery && mapsLink ? `GPS : ${mapsLink}` : null,
    ``,
    `🛒 *ARTICLES*`,
    itemsList,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    order.discount > 0
      ? `Réduction : -${order.discount.toLocaleString("fr-FR")} FCFA`
      : null,
    hasDelivery && order.deliveryFee > 0
      ? `Livraison : ${order.deliveryFee.toLocaleString("fr-FR")} FCFA`
      : null,
    `💰 *TOTAL ENCAISSÉ : ${order.total.toLocaleString("fr-FR")} FCFA* ✅`,
    ``,
    hasDelivery
      ? [
          `━━━━━━━━━━━━━━━━━━━━━━━━`,
          `⚠️ *ACTION REQUISE*`,
          `Préparez et expédiez cette commande dès que possible.`,
          `Mettez à jour le statut dans le panel admin une fois envoyée.`,
        ].join("\n")
      : null,
    ``,
    `👉 Panel admin : ${adminLink}`,
  ];

  return sendMessage(vendorPhone, lines.filter(Boolean).join("\n"));
}

// ── Confirmation commande → CLIENT ────────────────────────────────────────────
async function sendOrderConfirmToClient(order) {
  const hasDelivery = !!order.city;

  // Le lieu est assemble a part : une ligne `*📦 Cotonou, *` — avec une virgule
  // suivie de rien — casserait le gras, l'asterisque fermante suivant une
  // espace.
  const lieu = [order.city, order.neighborhood]
    .filter(Boolean)
    .join(", ")
    .concat(order.deliverySlot ? ` · ${order.deliverySlot}` : "");

  const montant = `${order.total.toLocaleString("fr-FR")} FCFA`;

  const message = assembler([
    ENTETE,
    ``,
    hasDelivery
      ? gras(
          `Votre commande ${order.reference} confirmée — ${montant} et en préparation, ` +
            `un coursier vous contactera dans les plus brefs délais`,
        )
      : gras(
          `Votre commande ${order.reference} confirmée — ${montant}. ` +
            `Votre accès vous parvient dans les plus brefs délais`,
        ),
    ``,
    hasDelivery ? gras(`📦 ${lieu}`) : null,
    hasDelivery ? `` : null,
    // Libelle en gras, URL en clair : une adresse en gras se lit mal.
    `*Suivi :* ${process.env.FRONTEND_URL}/suivi/${order.reference}`,
    ``,
    SIGNATURE,
  ]);

  return sendMessage(order.guestWhatsapp, message);
}

// ── Mise à jour statut → CLIENT ───────────────────────────────────────────────
async function sendStatusUpdateToClient(order, statusLabel) {
  const message = assembler([
    ENTETE,
    ``,
    gras(`Votre commande ${order.reference} : ${statusLabel}`),
    ``,
    // Libelle en gras, URL en clair : une adresse en gras se lit mal.
    `*Suivi :* ${process.env.FRONTEND_URL}/suivi/${order.reference}`,
    ``,
    SIGNATURE,
  ]);

  return sendMessage(order.guestWhatsapp, message);
}

// ── Identifiants abonnement → CLIENT ─────────────────────────────────────────
async function sendSubscriptionCredentials({
  clientWhatsapp,
  clientName,
  serviceName,
  credentials,
}) {
  const message = assembler([
    ENTETE,
    ``,
    gras(`Abonnement ${serviceName} activé`),
    ``,
    gras(`Voici vos informations de connexion :`),
    ``,
    // `champ` supprime la ligne quand la valeur manque. Un client avait recu
    // « Email : » et « Profil : » suivis de rien : trois libelles annoncant
    // une valeur qui n'existe pas.
    champ("Email", credentials.email),
    champ("Mot de passe", credentials.password),
    champ("Profil", credentials.profile),
    champ("Code profil", credentials.profilePassword),
    ``,
    // Texte fourni par le commercant. Le sens s'est precise : le code arrive
    // normalement TOUT SEUL, et « Code » ne sert qu'a le reclamer s'il tarde.
    gras(
      `${serviceName} demande un code et vous ne le recevez pas automatiquement ? ` +
        `Écrivez simplement « Code » dans cette discussion.`,
    ),
    ``,
    gras(`Merci pour votre confiance.`),
    ``,
    SIGNATURE,
  ]);

  return sendMessage(clientWhatsapp, message);
}

// ── Notif abonnement → ADMIN ──────────────────────────────────────────────────
async function sendSubscriptionNotifToAdmin({
  clientName,
  clientWhatsapp,
  serviceName,
  planDescription = null,
  amount,
  isGift = false,
  giftName = null,
  giftWhatsapp = null,
}) {
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (!vendorPhone) return false;

  const cleanClientPhone = clientWhatsapp.replace(/\D/g, "");

  const message = [
    HEADER,
    ``,
    `💳 *NOUVEL ABONNEMENT SOUSCRIT*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Service : *${serviceName}*`,
    planDescription ? `Formule : *${planDescription}*` : null,
    `Montant encaissé : *${amount.toLocaleString("fr-FR")} FCFA*`,
    ``,
    `👤 *ACHETEUR*`,
    `Nom : ${clientName}`,
    `WhatsApp : ${clientWhatsapp}`,
    `Contacter : https://wa.me/${cleanClientPhone}`,
    isGift && giftName
      ? [``, `🎁 *DESTINATAIRE*`, `Nom : ${giftName}`, `WhatsApp : ${giftWhatsapp}`].join("\n")
      : null,
    ``,
    `✅ Identifiants envoyés automatiquement au ${isGift ? "destinataire" : "client"}.`,
    `Aucune action requise.`,
  ].filter(Boolean).join("\n");

  return sendMessage(vendorPhone, message);
}

// ── Lien d'accès → CLIENT ─────────────────────────────────────────────────────
async function sendLinkAccess({ clientWhatsapp, clientName, serviceName, link }) {
  const message = assembler([
    ENTETE,
    ``,
    gras(`Votre accès ${serviceName} :`),
    // En clair : une URL en gras se lit mal et se recopie mal.
    `${link}`,
    ``,
    gras(`Lien personnel — ne le partagez pas.`),
    ``,
    SIGNATURE,
  ]);

  return sendMessage(clientWhatsapp, message);
}

// ── OTP → CLIENT ──────────────────────────────────────────────────────────────
async function sendOTPToClient({ clientWhatsapp, clientName, serviceName, otpCode }) {
  const message = assembler([
    ENTETE,
    ``,
    gras(`Code ${serviceName} : ${otpCode}`),
    ``,
    gras(`Valable 10 minutes. Ne le communiquez à personne.`),
    ``,
    SIGNATURE,
  ]);

  return sendMessage(clientWhatsapp, message);
}

// ── OTP cadeau — fallback vers l'acheteur ─────────────────────────────────────
async function sendOTPFallbackToBuyer({ clientWhatsapp, clientName, recipientName, serviceName, otpCode }) {
  const message = assembler([
    ENTETE,
    ``,
    gras(`Code ${serviceName} : ${otpCode}`),
    ``,
    gras(`${recipientName} est injoignable sur WhatsApp — merci de lui transmettre.`),
    gras(`Valable 10 minutes.`),
    ``,
    SIGNATURE,
  ]);

  return sendMessage(clientWhatsapp, message);
}

// ── OTP non livré → ADMIN ─────────────────────────────────────────────────────
async function sendOTPUndeliveredToAdmin({ serviceName, clientName, clientWhatsapp, recipientName, recipientWhatsapp, otpCode }) {
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (!vendorPhone) return false;

  const message = [
    HEADER,
    ``,
    `🚨 *OTP NON LIVRÉ — ACTION REQUISE*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Service : *${serviceName}*`,
    `Code OTP : *${otpCode}*`,
    ``,
    `👤 Acheteur : ${clientName} (${clientWhatsapp})`,
    recipientWhatsapp && recipientWhatsapp !== clientWhatsapp
      ? `🎁 Destinataire : ${recipientName} (${recipientWhatsapp})`
      : null,
    ``,
    `Aucun message WhatsApp n'a pu être livré.`,
    `Merci d'envoyer ce code manuellement au client.`,
    `— MTECHBENIN`,
  ].filter(Boolean).join("\n");

  return sendMessage(vendorPhone, message);
}

// ── Identifiants abonnement (cadeau) → ACHETEUR en fallback ──────────────────
async function sendSubscriptionCredentialsFallback({
  clientWhatsapp,
  clientName,
  recipientName,
  serviceName,
  credentials,
}) {
  const message = assembler([
    ENTETE,
    ``,
    gras(`Cadeau ${serviceName} — ${recipientName} est injoignable sur WhatsApp.`),
    gras(`Merci de lui transmettre :`),
    ``,
    champ("Email", credentials.email),
    champ("Mot de passe", credentials.password),
    champ("Profil", credentials.profile),
    champ("Code profil", credentials.profilePassword),
    ``,
    SIGNATURE,
  ]);

  return sendMessage(clientWhatsapp, message);
}

// ── Stock abonnement épuisé → ADMIN ──────────────────────────────────────────
// `raison` distingue « tous les profils sont pleins » (ajouter un profil) de
// « le compte a atteint son plafond de flux » (acheter un compte). Sans elle,
// l'alerte disait seulement « stock épuisé » et laissait chercher lequel des
// deux remèdes appliquer.
async function sendStockEpuiseAlert({ serviceName, clientName, clientWhatsapp, raison }) {
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (!vendorPhone) return false;

  const message = [
    HEADER,
    ``,
    `🚨 *STOCK ÉPUISÉ — ACTION REQUISE*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Service : *${serviceName}*`,
    `Client en attente : ${clientName}`,
    `WhatsApp : ${clientWhatsapp}`,
    ``,
    raison || `Aucune place disponible pour ce service.`,
    `Veuillez réapprovisionner immédiatement afin de traiter cette commande.`,
    `— MTECHBENIN`,
  ].join("\n");

  return sendMessage(vendorPhone, message);
}

// ── Notif link access → ADMIN ─────────────────────────────────────────────────
async function sendLinkAccessNotifToAdmin({
  serviceName,
  planDescription = null,
  clientName,
  clientWhatsapp,
  amount,
  isGift = false,
  giftName = null,
  giftWhatsapp = null,
  // Paramètre facultatif : le lien est déjà parti tout seul (réserve garnie).
  // Absent, le message garde mot pour mot son comportement d'avant — aucun
  // autre appelant n'est affecté. Présent et vrai, il retire l'ordre « collez
  // le lien et cliquez sur Envoyer » : sur une vente entièrement automatisée,
  // ce texte poussait l'opérateur à servir une seconde fois un client déjà
  // servi, en recopiant un lien depuis la réserve — geste qui laisse ce lien
  // « disponible » pour un futur acheteur et met deux clients sur la même
  // invitation.
  lienDejaEnvoye = false,
}) {
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (!vendorPhone) return false;

  const cleanPhone = clientWhatsapp.replace(/\D/g, "");

  const message = [
    HEADER,
    ``,
    lienDejaEnvoye
      ? `🔗 *NOUVEL ABONNEMENT — LIEN D'ACCÈS ENVOYÉ*`
      : `🔗 *NOUVEL ABONNEMENT — LIEN D'ACCÈS REQUIS*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Service : *${serviceName}*`,
    planDescription ? `Formule : *${planDescription}*` : null,
    amount ? `Montant encaissé : *${amount.toLocaleString("fr-FR")} FCFA*` : null,
    ``,
    `👤 *ACHETEUR*`,
    `Nom : ${clientName}`,
    `WhatsApp : ${clientWhatsapp}`,
    `Contacter : https://wa.me/${cleanPhone}`,
    isGift && giftName
      ? [``, `🎁 *DESTINATAIRE DU CADEAU*`, `Nom : ${giftName}`, `WhatsApp : ${giftWhatsapp}`].join("\n")
      : null,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    lienDejaEnvoye
      ? `✅ Le lien a été attribué depuis la réserve et envoyé automatiquement.`
      : `⚠️ Action requise : rendez-vous dans le panel admin,`,
    lienDejaEnvoye
      ? `Aucune action requise — message d'information.`
      : `collez le lien d'accès et cliquez sur Envoyer.`,
  ]
    .filter(Boolean)
    .join("\n");

  return sendMessage(vendorPhone, message);
}

// ── Notif OTP reçu → ADMIN (toujours envoyée) ────────────────────────────────
// `clientName`/`clientWhatsapp` portent le destinataire RÉEL du code (l'acheteur,
// ou l'occupant du profil quand une occupation redirige l'envoi — commande
// cadeau notamment). `buyerName`/`buyerWhatsapp` sont optionnels et ne
// s'affichent que lorsqu'ils diffèrent du destinataire : l'admin doit savoir
// qui a payé ET qui a reçu quand ce n'est pas la même personne, sans doublon
// quand c'en est une.
async function sendOTPNotifToAdmin({ otp, serviceName, clientName, clientWhatsapp, waSent, emailSent, buyerName, buyerWhatsapp }) {
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (!vendorPhone) return false;

  // `memeNumero` et pas `!==` : les deux numéros ne viennent pas de la même
  // saisie (l'un de la commande, l'autre de l'occupation) et le même client
  // peut donc apparaître ici sous deux écritures. Comparés en chaînes brutes,
  // « +229 97 43 75 51 » et « 22997437551 » désignent un « acheteur distinct »
  // de lui-même, et l'admin lit un litige là où il n'y en a pas.
  const acheteurDistinct = Boolean(buyerWhatsapp && !memeNumero(buyerWhatsapp, clientWhatsapp));

  const message = [
    HEADER,
    ``,
    `🔐 *OTP reçu — ${serviceName}*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Code : *${otp}*`,
    ``,
    `👤 Envoyé à : ${clientName} (${clientWhatsapp})`,
    ...(acheteurDistinct ? [`🛒 Acheteur : ${buyerName} (${buyerWhatsapp})`] : []),
    ``,
    `📤 WhatsApp : ${waSent ? "✅ Livré" : "❌ Échec"}`,
    `📧 Email : ${emailSent ? "✅ Envoyé" : "— Non disponible"}`,
  ].join("\n");

  return sendMessage(vendorPhone, message);
}

// ── Alerte stock faible → ADMIN ───────────────────────────────────────────────
async function sendLowStockAlert({ productName, stock }) {
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (!vendorPhone) return false;

  const message = [
    HEADER,
    ``,
    `⚠️ *ALERTE — STOCK FAIBLE*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Produit : *${productName}*`,
    `Stock restant : *${stock}* unité${stock > 1 ? "s" : ""}`,
    ``,
    `Veuillez réapprovisionner rapidement pour éviter toute rupture.`,
    `— MTECHBENIN`,
  ].join("\n");

  return sendMessage(vendorPhone, message);
}

// ── Configuration abonnement manquante → ADMIN ──────────────────────────────
// Distinct de « stock épuisé » : ici, `revendiquerPlace` n'a trouvé AUCUN
// profil candidat pour ce service — pas « tous pleins », mais « rien à
// remplir ». Deux causes possibles, le même remède : aucun `StreamingAccount`
// n'est configuré pour ce service, ou la reprise de données
// (`scripts/migrate-comptes-occupations.js --appliquer`) n'a jamais rattaché
// les profils existants à leur compte. Réutiliser l'alerte « stock épuisé »
// ici enverrait l'admin chercher une place à ajouter alors que rien n'est
// branché — c'est exactement la confusion que ce message évite.
async function sendConfigurationAbonnementManquanteAlert({ serviceName, clientName, clientWhatsapp }) {
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (!vendorPhone) return false;

  const message = [
    HEADER,
    ``,
    `🚨 *CONFIGURATION MANQUANTE — ACTION REQUISE*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Service : *${serviceName}*`,
    `Client en attente : ${clientName}`,
    `WhatsApp : ${clientWhatsapp}`,
    ``,
    `Aucun profil candidat n'existe pour ce service : aucun compte streaming`,
    `n'y est configuré, ou la reprise de données n'a pas encore été exécutée.`,
    ``,
    `Ce n'est PAS un problème de stock — ajouter une place ne résoudra rien.`,
    `Vérifier les comptes du service dans le panel, ou lancer :`,
    `  node scripts/migrate-comptes-occupations.js --appliquer`,
    `— MTECHBENIN`,
  ].join("\n");

  return sendMessage(vendorPhone, message);
}

// ── Devis réparation → CLIENT ─────────────────────────────────────────────────
// `lignes` porte le détail retenu par le client (une réparation peut proposer
// plusieurs qualités de pièce à des prix différents) : sans le libellé de
// qualité, le client ne peut pas vérifier qu'il a bien reçu le devis pour la
// pièce qu'il a choisie.
async function sendRepairQuoteToClient({ clientWhatsapp, clientName, modelName, lignes, total }) {
  const detailLignes = lignes
    .map(
      (l) =>
        `• ${l.jobName} (${l.optionLabel}) — ${l.unitPrice.toLocaleString("fr-FR")} FCFA`,
    )
    .join("\n");

  const message = assembler([
    ENTETE,
    ``,
    gras(`Devis réparation — ${modelName}`),
    ``,
    detailLignes,
    ``,
    gras(`Total : ${total.toLocaleString("fr-FR")} FCFA`),
    ``,
    // Pas une formule de politesse : le tarif peut changer entre le devis et
    // le paiement, et c'est le tarif du jour de la commande qui est facturé,
    // pas celui affiché ici.
    `Prix indicatif, valable 5 jours, sous réserve du tarif en vigueur.`,
    ``,
    SIGNATURE,
  ]);

  return sendMessage(clientWhatsapp, message);
}

// Écrit la date de retour en français, lisible par un client (ex.
// « 14 septembre 2026 »). `returnDate` arrive ici comme objet `Date` Prisma
// (ou, selon l'appelant, une chaîne) — interpolée brute, elle ressort telle
// que `Date.prototype.toString()` la rend, en anglais et avec l'heure et le
// fuseau du serveur (« Mon Sep 14 2026 00:00:00 GMT+0000 (Coordinated
// Universal Time) »). C'est la seule date que le client voit de tout le
// parcours réparation ; le reste du fichier formate déjà ses montants en
// `fr-FR`, la date suit la même convention.
function formatDateRetourFr(returnDate) {
  const date = returnDate instanceof Date ? returnDate : new Date(returnDate);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

// ── Mise à jour statut réparation → CLIENT ───────────────────────────────────
async function sendRepairStatusToClient({
  clientWhatsapp,
  clientName,
  reference,
  modelName,
  message,
  returnDate,
}) {
  // La date de retour n'est connue qu'à partir de certaines étapes (par
  // exemple « prêt » ou « réparé ») : l'afficher inconditionnellement
  // annoncerait une date de retour absente ou obsolète sur les étapes qui la
  // précèdent.
  const dateRetourFr = returnDate ? formatDateRetourFr(returnDate) : null;
  const texte = assembler([
    ENTETE,
    ``,
    gras(`Réparation ${reference} — ${modelName}`),
    ``,
    gras(message),
    ``,
    dateRetourFr ? gras(`Date de retour prévue : ${dateRetourFr}`) : null,
    dateRetourFr ? `` : null,
    SIGNATURE,
  ]);

  return sendMessage(clientWhatsapp, texte);
}

// ── Nouvelle réparation → ADMIN ───────────────────────────────────────────────
// Sert aux deux alertes retenues : une réparation payée (le montant encaissé
// compte) et un diagnostic reçu (rien n'est encaissé, mais l'admin doit
// connaître la panne décrite par le client pour préparer son diagnostic).
async function sendNewRepairToAdmin({
  reference,
  kind,
  clientName,
  clientWhatsapp,
  modelName,
  total,
  problemDescription,
}) {
  const vendorPhone = process.env.VENDOR_WHATSAPP_NUMBER;
  if (!vendorPhone) return false;

  const cleanClientPhone = clientWhatsapp.replace(/\D/g, "");
  const estDiagnostic = kind === "DIAGNOSTIC";

  const message = [
    HEADER,
    ``,
    estDiagnostic
      ? `🔧 *NOUVEAU DIAGNOSTIC — ${reference}*`
      : `🔧 *NOUVELLE RÉPARATION — ${reference}*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Appareil : *${modelName}*`,
    estDiagnostic
      ? `Panne décrite : ${problemDescription}`
      : `Montant encaissé : *${total.toLocaleString("fr-FR")} FCFA*`,
    ``,
    `👤 *CLIENT*`,
    `Nom : ${clientName}`,
    `WhatsApp : ${clientWhatsapp}`,
    `Contacter : https://wa.me/${cleanClientPhone}`,
  ].join("\n");

  return sendMessage(vendorPhone, message);
}

function setClient() {}

module.exports = {
  setClient,
  sendMessage,
  sendMessageToJid,
  sendNewOrderToAdmin,
  sendOrderConfirmToClient,
  sendStatusUpdateToClient,
  sendSubscriptionCredentials,
  sendSubscriptionCredentialsFallback,
  sendSubscriptionNotifToAdmin,
  sendStockEpuiseAlert,
  sendConfigurationAbonnementManquanteAlert,
  sendLinkAccessNotifToAdmin,
  sendLinkAccess,
  sendOTPToClient,
  sendOTPFallbackToBuyer,
  sendOTPUndeliveredToAdmin,
  sendOTPNotifToAdmin,
  sendLowStockAlert,
  sendRepairQuoteToClient,
  sendRepairStatusToClient,
  sendNewRepairToAdmin,
};
