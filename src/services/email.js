const { Resend } = require("resend");
const logger = require("../utils/logger");
const emails = require("../emails");

// Le constructeur de Resend LÈVE si la clé est absente. Le construire au
// chargement du module ferait donc échouer le `require` de ce fichier — et
// comme `payments.controller.js` et `subscriptions.controller.js` le chargent
// en tête, c'est le backend entier qui refuserait de démarrer : catalogue,
// paiements et suivi de commande compris, pour une variable d'environnement
// qui ne concerne que l'e-mail. On le construit donc à la demande, et son
// absence dégrade l'envoi sans emporter le reste du site.
let clientResend = null;
let absenceDeCleSignalee = false;

function getResend() {
  if (clientResend) return clientResend;
  if (!process.env.RESEND_API_KEY) {
    // Une seule fois : cette fonction est appelée à chaque envoi, et un
    // journal saturé du même message masquerait tout le reste.
    if (!absenceDeCleSignalee) {
      logger.error("RESEND_API_KEY absente — aucun e-mail ne partira");
      absenceDeCleSignalee = true;
    }
    return null;
  }
  clientResend = new Resend(process.env.RESEND_API_KEY);
  return clientResend;
}

// `onboarding@resend.dev` est l'expéditeur de démonstration de Resend : il
// n'accepte QUE l'adresse du titulaire du compte et répond 403 à toute autre.
// Utilisé en production, il rejette silencieusement chaque e-mail client —
// confirmations de commande, identifiants d'abonnement, codes OTP, rappels.
// Le domaine `mtechbenin.com` est validé chez Resend et fonctionne vers
// n'importe quelle adresse : c'est lui qui doit servir en production, quoi que
// dise la variable d'environnement.
const EXPEDITEUR_PRODUCTION = "MTECHBENIN <noreply@mtechbenin.com>";
const EXPEDITEUR_DEMO = "MTECHBENIN <onboarding@resend.dev>";

let expediteurDeDemoSignale = false;

function getFrom() {
  if (process.env.NODE_ENV !== "production") return EXPEDITEUR_DEMO;

  const configure = process.env.RESEND_FROM_EMAIL;
  if (configure && !/@resend\.dev\b/i.test(configure)) return configure;

  if (configure && !expediteurDeDemoSignale) {
    logger.error(
      "RESEND_FROM_EMAIL pointe sur l'expéditeur de démonstration de Resend, " +
        `qui rejette toute adresse tierce en production — repli sur ${EXPEDITEUR_PRODUCTION}. ` +
        "Corrigez la variable d'environnement.",
      { valeurConfiguree: configure },
    );
    expediteurDeDemoSignale = true;
  }
  return EXPEDITEUR_PRODUCTION;
}

function getRecipient(email) {
  if (process.env.NODE_ENV === "production") return email;
  return process.env.ADMIN_EMAIL || email;
}

// Envoi unique de tout ce fichier.
//
// Resend ne lève JAMAIS d'exception sur une erreur d'API : il résout toujours
// la promesse et renvoie `{ data, error }`. Un `await resend.emails.send(...)`
// dont on ignore le retour fait donc passer pour un succès un 429 de
// limitation de débit, un domaine non vérifié, une adresse rejetée ou un
// timeout réseau — et le journal affiche « envoyé » pour un message qui n'est
// jamais parti. C'est ce qui rendait le diagnostic impossible : les logs
// mentaient.
//
// Renvoie `true` seulement si Resend a réellement accepté le message.
async function envoyer({ to, subject, html, contexte }) {
  const client = getResend();
  if (!client) return false;

  try {
    const { error } = await client.emails.send({ from: getFrom(), to, subject, html });
    if (error) {
      logger.error(`Échec envoi e-mail — ${contexte}`, {
        to,
        statusCode: error.statusCode,
        name: error.name,
        message: error.message,
      });
      return false;
    }
    logger.info(`E-mail envoyé — ${contexte} → ${to}`);
    return true;
  } catch (err) {
    // Reste utile pour les vraies exceptions : panne DNS, abort, bug du SDK.
    logger.error(`Erreur envoi e-mail — ${contexte}`, { to, err: err.message });
    return false;
  }
}

async function sendOrderConfirmToClient({ order }) {
  const to = order.guestEmail ? getRecipient(order.guestEmail) : null;
  if (!to) return false;
  return envoyer({
    to,
    subject: `✅ Commande ${order.reference} confirmée — MTECHBENIN`,
    html: emails.renderOrderConfirm({ order }),
    contexte: `confirmation commande ${order.reference}`,
  });
}

async function sendOrderNotifToAdmin({ order }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return false;
  const hasDelivery = !!order.city;
  return envoyer({
    to: adminEmail,
    subject: `🛎️ Nouvelle commande ${order.reference}${hasDelivery ? " — À préparer" : " — Numérique"}`,
    html: emails.renderOrderAdmin({ order }),
    contexte: `notif admin commande ${order.reference}`,
  });
}

async function sendSubscriptionCredentials({ clientEmail, clientName, serviceName, credentials, serviceSlug }) {
  const to = clientEmail ? getRecipient(clientEmail) : null;
  if (!to) return false;
  return envoyer({
    to,
    subject: `🎬 Votre accès ${serviceName} est prêt — MTECHBENIN`,
    html: emails.renderSubCredentials({ clientName, serviceName, credentials, serviceSlug }),
    contexte: `identifiants ${serviceName}`,
  });
}

// Rappel envoyé la veille de l'expiration d'un abonnement. La boucle qui
// l'appelle (`workers/subscriptionExpiry.js`) ne relâche sa revendication que
// si cette fonction rend `false` : un faux succès y marquerait le client comme
// prévenu définitivement, sans qu'aucun e-mail soit parti.
async function sendSubscriptionExpiryReminder({ clientEmail, clientName, serviceName, planLabel, expiresAt, serviceSlug }) {
  const to = clientEmail ? getRecipient(clientEmail) : null;
  if (!to) {
    logger.info(`Rappel d'expiration ignoré : aucune adresse e-mail (${serviceName})`);
    return false;
  }

  // Le rendu lève sur une date illisible, volontairement : mieux vaut ne pas
  // envoyer que d'annoncer au client une date fausse ou un « Invalid Date ».
  let html;
  try {
    html = emails.renderSubExpiryReminder({ clientName, serviceName, planLabel, expiresAt, serviceSlug });
  } catch (err) {
    logger.error("Rappel d'expiration non rendu — date illisible", {
      serviceName,
      err: err.message,
    });
    return false;
  }

  return envoyer({
    to,
    subject: `Votre abonnement ${serviceName} expire demain — MTECHBENIN`,
    html,
    contexte: `rappel expiration ${serviceName}`,
  });
}

async function sendLinkAccess({ clientEmail, clientName, serviceName, link }) {
  const to = clientEmail ? getRecipient(clientEmail) : null;
  if (!to) return false;
  return envoyer({
    to,
    subject: `🔗 Votre accès ${serviceName} — MTECHBENIN`,
    html: emails.renderLinkAccess({ clientName, serviceName, link }),
    contexte: `lien d'accès ${serviceName}`,
  });
}

async function sendOTPToClient({ clientEmail, clientName, serviceName, otpCode }) {
  const to = clientEmail ? getRecipient(clientEmail) : null;
  if (!to) return false;
  return envoyer({
    to,
    subject: `🔐 Code de vérification ${serviceName} — MTECHBENIN`,
    html: emails.renderOTP({ clientName, serviceName, otpCode }),
    contexte: `OTP ${serviceName}`,
  });
}

// `buyerName`/`buyerWhatsapp` sont optionnels : l'acheteur d'une commande
// cadeau, distinct du destinataire (`clientName`/`clientWhatsapp`) qui a reçu
// le code. Le gabarit ne les affiche que lorsqu'ils diffèrent réellement.
async function sendOTPNotifToAdmin({ otp, serviceName, clientName, clientEmail, clientWhatsapp, waSent, emailSent, buyerName, buyerWhatsapp }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return false;
  return envoyer({
    to: adminEmail,
    subject: `🔐 OTP reçu — ${serviceName} : ${otp}`,
    html: emails.renderOTPAdmin({ otp, serviceName, clientName, clientEmail, clientWhatsapp, waSent, emailSent, buyerName, buyerWhatsapp }),
    contexte: `notif admin OTP ${serviceName}`,
  });
}

// Alerte administrateur par e-mail — repli quand WhatsApp est le canal en
// panne. Toutes les autres alertes admin de ce projet passent par WhatsApp ;
// quand c'est précisément la session WhatsApp qui est tombée, l'alerte
// « lien consommé sans trace » ne partait pas non plus et personne n'apprenait
// jamais l'incident. Rend `true` seulement si Resend a accepté le message,
// comme le reste de ce fichier.
async function sendAdminLinkIncident({ serviceName, clientName, clientWhatsapp, link }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return false;
  return envoyer({
    to: adminEmail,
    subject: `⚠️ Lien ${serviceName} consommé sans trace — action requise`,
    html: emails.renderAdminLinkIncident({ serviceName, clientName, clientWhatsapp, link }),
    contexte: `alerte admin lien sans trace ${serviceName}`,
  });
}

// Alerte admin générique — repli du bot OTP quand la session WhatsApp est
// tombée. Même contrat que le reste du fichier : `true` uniquement si Resend a
// accepté le message, pour que l'appelant sache s'il reste aveugle.
async function sendAdminAlert({ sujet, message }) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return false;
  return envoyer({
    to: adminEmail,
    subject: `⚠️ ${sujet}`,
    html: emails.renderAdminAlert({ sujet, message }),
    contexte: `alerte admin — ${sujet}`,
  });
}

module.exports = {
  // Lu par le bot IMAP pour reconnaitre et ecarter ses propres alertes.
  getFrom,
  sendAdminAlert,
  sendOrderConfirmToClient,
  sendOrderNotifToAdmin,
  sendAdminLinkIncident,
  sendSubscriptionCredentials,
  sendSubscriptionExpiryReminder,
  sendLinkAccess,
  sendOTPToClient,
  sendOTPNotifToAdmin,
};
