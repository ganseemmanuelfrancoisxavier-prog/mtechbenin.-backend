'use strict';

// Même décalage fixe que celui utilisé par workers/subscriptionExpiry.js pour
// décider « expire demain » (Bénin = UTC+1 toute l'année, serveur en UTC sur
// Render). On l'importe plutôt que de le dupliquer : la date annoncée dans le
// rappel doit toujours tomber sur exactement le même jour calendaire que celui
// retenu par le worker, jamais un jour de décalage.
const { DECALAGE_BENIN_H } = require('../../workers/subscriptionExpiry');
const logger = require('../utils/logger');
const { memeNumero } = require('../modules/subscriptions/demandeCode');

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

// Adresse du site, utilisée par tous les boutons des e-mails.
//
// `.env.example` livre `FRONTEND_URL="http://localhost:3000"`. Reprise telle
// quelle en production — ce qui est le geste naturel quand on remplit les
// variables d'un hébergeur depuis l'exemple — elle transforme chaque bouton
// en lien mort : le client reçoit « Suivre ma commande » et atterrit sur une
// adresse qui n'existe que sur la machine du développeur. On refuse donc une
// adresse locale en production, et on le signale au lieu de le subir.
const SITE_PRODUCTION = 'https://mtechbenin.com';
const ADRESSE_LOCALE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i;

let urlLocaleSignalee = false;

function getFrontendUrl() {
  const configure = process.env.FRONTEND_URL;

  if (process.env.NODE_ENV !== 'production') {
    return configure || SITE_PRODUCTION;
  }
  if (configure && !ADRESSE_LOCALE.test(configure)) {
    // On retire un éventuel « / » final pour ne pas produire de « //suivi ».
    return configure.replace(/\/+$/, '');
  }
  if (configure && !urlLocaleSignalee) {
    logger.error(
      `FRONTEND_URL vaut une adresse locale en production : les boutons des e-mails ` +
        `seraient des liens morts pour le client — repli sur ${SITE_PRODUCTION}. ` +
        `Corrigez la variable d'environnement.`,
      { valeurConfiguree: configure },
    );
    urlLocaleSignalee = true;
  }
  return SITE_PRODUCTION;
}

// ─── Layout commun ──────────────────────────────────────────────────────────
function layout(preview, body) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
  "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta content="text/html; charset=UTF-8" http-equiv="Content-Type"/>
  <meta name="x-apple-disable-message-reformatting"/>
  ${preview ? `<meta name="description" content="${esc(preview)}"/>` : ''}
</head>
<body style="font-family:Arial,sans-serif;background:#F9FAFB;margin:0;padding:0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F9FAFB;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;padding:24px;border-radius:0;">
        <!-- Header -->
        <tr><td style="background:#1D1D1F;padding:16px;border-radius:12px;text-align:center;margin-bottom:24px;">
          <p style="color:#ffffff;margin:0;font-size:20px;font-weight:bold;letter-spacing:2px;">MTECHBENIN</p>
        </td></tr>
        <!-- Content -->
        <tr><td style="padding-top:24px;">${body}</td></tr>
        <!-- Footer -->
        <tr><td style="margin-top:32px;border-top:1px solid #E5E7EB;padding-top:16px;text-align:center;">
          <p style="color:#6E6E73;font-size:12px;margin:4px 0;">
            Pour toute question, répondez à cet email ou contactez-nous sur WhatsApp.
          </p>
          <p style="color:#6E6E73;font-size:12px;margin:4px 0;">MTECHBENIN — Votre boutique tech au Bénin</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}

// Écrit une date en toutes lettres, en français (ex. « 12 septembre 2026 »).
// On applique le décalage fixe Bénin (+1h) puis on lit jour/mois/année en
// UTC — jamais l'heure locale de la machine qui exécute ce code, ni
// toLocaleDateString sans fuseau explicite, pour rester cohérent avec le jour
// que workers/subscriptionExpiry.js a retenu comme « demain ». Une entrée
// illisible lève une exception plutôt que d'afficher un « Invalid Date » au
// client : un rappel avec une date fausse serait pire que pas de rappel du
// tout. sendSubscriptionExpiryReminder (services/email.js) attrape cette
// exception et retombe proprement sur `false`, sans jamais planter la boucle
// d'envoi de la tâche suivante.
function formatDateExpirationFr(expiresAt) {
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Date d'expiration invalide : ${expiresAt}`);
  }
  const decale = new Date(d.getTime() + DECALAGE_BENIN_H * 3600 * 1000);
  const jour = decale.getUTCDate();
  const mois = MOIS_FR[decale.getUTCMonth()];
  const annee = decale.getUTCFullYear();
  // Le premier jour du mois s'écrit « 1ᵉʳ » en français, pas « 1 » — seule
  // exception à la numérotation cardinale des jours du mois.
  const jourTexte = jour === 1 ? "1ᵉʳ" : String(jour);
  return `${jourTexte} ${mois} ${annee}`;
}

// ─── Confirmation commande client ────────────────────────────────────────────
function renderOrderConfirm({ order }) {
  const hasDelivery = !!order.city;
  const frontendUrl = getFrontendUrl();

  const giftSection = order.isGift && order.giftName ? `
    <div style="background:#FFF7ED;padding:16px;border-radius:12px;margin:16px 0;border-left:4px solid #F97316;">
      <p style="margin:0 0 4px;font-weight:600;color:#9A3412;">🎁 Cadeau pour ${esc(order.giftName)}</p>
      <p style="margin:0;color:#9A3412;font-size:13px;">Les identifiants seront envoyés directement au destinataire.</p>
    </div>` : '';

  const deliverySection = hasDelivery ? `
    <div style="background:#F5F5F7;padding:16px;border-radius:12px;margin:16px 0;">
      <p style="margin:0 0 8px;font-weight:600;color:#1D1D1F;font-size:14px;">📦 Livraison</p>
      <p style="margin:4px 0;font-size:14px;color:#3D3D3F;"><strong>Ville :</strong> ${esc(order.city)}${order.neighborhood ? `, ${esc(order.neighborhood)}` : ''}</p>
      <p style="margin:4px 0;font-size:14px;color:#3D3D3F;"><strong>Créneau :</strong> ${esc(order.deliverySlot || '—')}</p>
      ${order.instructions ? `<p style="margin:4px 0;font-size:14px;color:#3D3D3F;"><strong>Instructions :</strong> ${esc(order.instructions)}</p>` : ''}
    </div>` : `
    <div style="background:#F0FDF4;padding:16px;border-radius:12px;margin:16px 0;border-left:4px solid #22C55E;">
      <p style="margin:0;color:#166534;">📲 Votre accès numérique sera envoyé très prochainement sur WhatsApp.</p>
    </div>`;

  const discountLine = order.discount > 0
    ? `<p style="margin:4px 0;font-size:14px;color:#16A34A;"><strong>Réduction :</strong> -${fmt(order.discount)} FCFA</p>` : '';
  const deliveryFeeLine = hasDelivery && order.deliveryFee > 0
    ? `<p style="margin:4px 0;font-size:14px;color:#3D3D3F;"><strong>Frais de livraison :</strong> ${fmt(order.deliveryFee)} FCFA</p>` : '';

  const body = `
    <p style="font-size:24px;font-weight:700;color:#1D1D1F;margin:0 0 12px;">Commande confirmée ✅</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">Bonjour <strong>${esc(order.guestName)}</strong>,</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">Votre commande <strong>${esc(order.reference)}</strong> a été confirmée et le paiement validé avec succès.</p>
    ${giftSection}
    ${deliverySection}
    <div style="background:#F5F5F7;padding:16px;border-radius:12px;margin:16px 0;">
      <p style="margin:0 0 8px;font-weight:600;color:#1D1D1F;font-size:14px;">💰 Récapitulatif</p>
      ${discountLine}
      ${deliveryFeeLine}
      <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#1D1D1F;">Total réglé : ${fmt(order.total)} FCFA</p>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${esc(frontendUrl)}/suivi/${esc(order.reference)}"
         style="background:#1D1D1F;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Suivre ma commande →
      </a>
    </div>`;

  return layout(`Commande ${order.reference} confirmée — paiement reçu ✅`, body);
}

// ─── Notification admin nouvelle commande ────────────────────────────────────
function renderOrderAdmin({ order }) {
  const hasDelivery = !!order.city;
  const frontendUrl = getFrontendUrl();

  const giftSection = order.isGift && order.giftName ? `
    <div style="background:#FFF7ED;padding:12px 16px;border-radius:8px;margin:12px 0;border-left:4px solid #F97316;">
      <p style="margin:0 0 4px;font-weight:600;color:#9A3412;font-size:14px;">🎁 Cadeau pour : ${esc(order.giftName)}</p>
      <p style="margin:0;color:#9A3412;font-size:13px;">WhatsApp destinataire : ${esc(order.giftWhatsapp)}</p>
    </div>` : '';

  const deliverySection = hasDelivery ? `
    <div style="background:#F5F5F7;padding:12px 16px;border-radius:8px;margin:12px 0;">
      <p style="margin:0 0 6px;font-weight:600;color:#1D1D1F;font-size:14px;">📦 Livraison</p>
      <p style="margin:3px 0;font-size:14px;color:#3D3D3F;">Ville : <strong>${esc(order.city)}</strong></p>
      ${order.neighborhood ? `<p style="margin:3px 0;font-size:14px;color:#3D3D3F;">Quartier : <strong>${esc(order.neighborhood)}</strong></p>` : ''}
      <p style="margin:3px 0;font-size:14px;color:#3D3D3F;">Créneau : <strong>${esc(order.deliverySlot || 'Non précisé')}</strong></p>
      ${order.instructions ? `<p style="margin:3px 0;font-size:14px;color:#3D3D3F;">Instructions : <em>${esc(order.instructions)}</em></p>` : ''}
      ${Number.isFinite(Number(order.deliveryLat)) && Number.isFinite(Number(order.deliveryLng)) ? `<p style="margin:3px 0;font-size:14px;"><a href="https://www.google.com/maps?q=${Number(order.deliveryLat)},${Number(order.deliveryLng)}" style="color:#1D1D1F;">📍 Voir la position GPS</a></p>` : ''}
    </div>
    <div style="background:#FEF2F2;padding:16px;border-radius:8px;margin:20px 0;border:2px solid #DC2626;">
      <p style="margin:0;font-weight:700;color:#DC2626;font-size:16px;">⚠️ ACTION REQUISE</p>
      <p style="margin:8px 0 12px;color:#7F1D1D;">Préparez et expédiez cette commande dès que possible. Mettez à jour le statut dans le panel admin une fois envoyée.</p>
      <a href="${esc(frontendUrl)}/admin/commandes"
         style="background:#DC2626;color:#ffffff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
        Gérer la commande →
      </a>
    </div>` : `
    <div style="background:#F0FDF4;padding:12px 16px;border-radius:8px;margin:12px 0;border-left:4px solid #22C55E;">
      <p style="margin:0;color:#166534;">📲 Commande numérique — identifiants envoyés automatiquement.</p>
    </div>`;

  const itemsHtml = (order.items || []).map(item => {
    const variants = Array.isArray(item.variants) ? item.variants : [];
    const variantChips = variants.length
      ? `<div style="margin:3px 0 6px;">${variants.map(v =>
          `<span style="background:#E5E7EB;color:#374151;padding:2px 8px;border-radius:10px;font-size:11px;margin-right:4px;display:inline-block;">${esc(v.typeName)}: ${esc(v.value)}</span>`
        ).join('')}</div>`
      : '';
    return `<div style="margin-bottom:6px;">
      <p style="margin:0;font-size:14px;color:#3D3D3F;">• ${esc(item.productName)} × ${item.quantity} — <strong>${fmt(item.totalPrice)} FCFA</strong></p>
      ${variantChips}
    </div>`;
  }).join('');

  const discountLine = order.discount > 0
    ? `<p style="margin:4px 0;font-size:14px;color:#16A34A;">Réduction : -${fmt(order.discount)} FCFA</p>` : '';
  const deliveryFeeLine = hasDelivery && order.deliveryFee > 0
    ? `<p style="margin:4px 0;font-size:14px;color:#3D3D3F;">Livraison : ${fmt(order.deliveryFee)} FCFA</p>` : '';

  const body = `
    <p style="font-size:22px;font-weight:700;color:#1D1D1F;margin:0 0 16px;">Nouvelle commande — ${esc(order.reference)}</p>
    <div style="background:#F5F5F7;padding:12px 16px;border-radius:8px;margin:12px 0;">
      <p style="margin:0 0 6px;font-weight:600;color:#1D1D1F;font-size:14px;">👤 Client</p>
      <p style="margin:3px 0;font-size:14px;color:#3D3D3F;">Nom : <strong>${esc(order.guestName)}</strong></p>
      <p style="margin:3px 0;font-size:14px;color:#3D3D3F;">WhatsApp : <strong>${esc(order.guestWhatsapp)}</strong></p>
      ${order.guestEmail ? `<p style="margin:3px 0;font-size:14px;color:#3D3D3F;">Email : ${esc(order.guestEmail)}</p>` : ''}
    </div>
    ${giftSection}
    ${deliverySection}
    <div style="background:#F5F5F7;padding:12px 16px;border-radius:8px;margin:12px 0;">
      <p style="margin:0 0 6px;font-weight:600;color:#1D1D1F;font-size:14px;">🛒 Articles</p>
      ${itemsHtml}
    </div>
    <div style="background:#F5F5F7;padding:12px 16px;border-radius:8px;margin:12px 0;">
      ${discountLine}
      ${deliveryFeeLine}
      <p style="margin:8px 0 0;font-size:18px;font-weight:700;color:#1D1D1F;">💰 Total encaissé : ${fmt(order.total)} FCFA</p>
    </div>`;

  return layout(`🛎️ Nouvelle commande ${order.reference}${hasDelivery ? ' — À préparer' : ' — Numérique'}`, body);
}

// ─── Identifiants abonnement ──────────────────────────────────────────────────
// `serviceSlug` est facultatif, comme pour le rappel d'expiration : fourni,
// le bouton mène à la page du service ; absent, au catalogue des abonnements.
// On ne le déduit jamais du nom du service — accents, espaces et casse
// donneraient un lien mort.
function renderSubCredentials({ clientName, serviceName, credentials, serviceSlug }) {
  const frontendUrl = getFrontendUrl();
  const lien = serviceSlug
    ? `${frontendUrl}/abonnements/${encodeURIComponent(serviceSlug)}`
    : `${frontendUrl}/abonnements`;
  // L'adresse est écrite EN CLAIR, pas seulement posée sur un lien : le mail
  // annonçait « vous pouvez aussi le demander depuis notre site » sans que
  // cette page apparaisse nulle part, et aucun élément de navigation n'y
  // menait. Un client qui lit ce mail sur un client courrier qui masque ou
  // bloque les liens doit pouvoir recopier l'adresse.
  const lienCode = `${frontendUrl}/mon-code`;
  const profileLine = credentials.profile
    ? `<p style="margin:8px 0;font-size:15px;color:#1D1D1F;font-family:monospace,monospace;"><strong>Profil :</strong> ${esc(credentials.profile)}</p>` : '';
  const profilePassLine = credentials.profilePassword
    ? `<p style="margin:8px 0;font-size:15px;color:#1D1D1F;font-family:monospace,monospace;"><strong>Code profil :</strong> ${esc(credentials.profilePassword)}</p>` : '';

  const body = `
    <p style="font-size:24px;font-weight:700;color:#1D1D1F;margin:0 0 12px;">Votre abonnement est prêt ! 🎉</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">Bonjour <strong>${esc(clientName)}</strong>,</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">Votre accès <strong>${esc(serviceName)}</strong> a été activé avec succès. Voici vos identifiants de connexion :</p>
    <div style="background:#F5F5F7;padding:20px;border-radius:12px;margin:20px 0;">
      <p style="margin:0 0 12px;font-weight:600;color:#1D1D1F;font-size:14px;">🔑 Identifiants de connexion</p>
      <p style="margin:8px 0;font-size:15px;color:#1D1D1F;font-family:monospace,monospace;"><strong>Email :</strong> ${esc(credentials.email)}</p>
      <p style="margin:8px 0;font-size:15px;color:#1D1D1F;font-family:monospace,monospace;"><strong>Mot de passe :</strong> ${esc(credentials.password)}</p>
      ${profileLine}
      ${profilePassLine}
    </div>
    <div style="background:#F5F5F7;padding:16px;border-radius:12px;margin:16px 0;">
      <p style="margin:0 0 6px;font-weight:600;color:#1D1D1F;font-size:14px;">🔐 Code de vérification</p>
      <p style="margin:0;color:#3D3D3F;font-size:14px;">
        Si ${esc(serviceName)} vous demande un code de connexion, écrivez-nous
        « CODE » sur WhatsApp — le code vous parviendra automatiquement. Vous
        pouvez aussi le demander depuis
        <a href="${esc(lienCode)}" style="color:#1D1D1F;font-weight:600;">${esc(lienCode)}</a>.
      </p>
    </div>
    <div style="background:#FEF2F2;padding:16px;border-radius:8px;margin:16px 0;border-left:4px solid #DC2626;">
      <p style="margin:0;color:#7F1D1D;font-weight:600;">⚠️ Ne partagez pas ces identifiants avec quiconque.</p>
      <p style="margin:4px 0 0;color:#7F1D1D;font-size:13px;">En cas de problème d'accès, contactez-nous immédiatement sur WhatsApp.</p>
    </div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${esc(lien)}"
         style="background:#1D1D1F;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Voir mon abonnement →
      </a>
    </div>`;

  return layout(`Votre accès ${serviceName} est prêt 🎉`, body);
}

// ─── Lien d'accès ────────────────────────────────────────────────────────────
function renderLinkAccess({ clientName, serviceName, link }) {
  let safeLink = '#';
  try {
    const u = new URL(link);
    if (u.protocol === 'http:' || u.protocol === 'https:') safeLink = link;
  } catch (_) {}

  const body = `
    <p style="font-size:24px;font-weight:700;color:#1D1D1F;margin:0 0 12px;">Votre lien d'accès est prêt ! ✅</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">Bonjour <strong>${esc(clientName)}</strong>,</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">Votre accès <strong>${esc(serviceName)}</strong> est disponible. Cliquez sur le bouton ci-dessous pour y accéder.</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${esc(safeLink)}"
         style="background:#1D1D1F;color:#ffffff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block;">
        Accéder maintenant →
      </a>
    </div>
    <p style="font-size:12px;color:#9CA3AF;margin:4px 0;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :</p>
    <p style="font-size:12px;color:#6E6E73;margin:4px 0;word-break:break-all;">${esc(safeLink)}</p>`;

  return layout(`Votre accès ${serviceName} est disponible ✅`, body);
}

// ─── Rappel d'expiration d'abonnement ─────────────────────────────────────────
// `serviceSlug` est facultatif : fourni, le bouton mène directement à la page
// du service à renouveler (`/abonnements/<slug>`) ; absent, il retombe sur le
// catalogue. On ne le déduit pas de `serviceName` — un nom peut contenir des
// accents, des espaces ou une casse qui ne correspondent pas au slug, et un
// lien mort dans un rappel enverrait le client sur une page d'erreur.
function renderSubExpiryReminder({ clientName, serviceName, planLabel, expiresAt, serviceSlug }) {
  const frontendUrl = getFrontendUrl();
  const dateFr = formatDateExpirationFr(expiresAt);
  const lien = serviceSlug
    ? `${frontendUrl}/abonnements/${encodeURIComponent(serviceSlug)}`
    : `${frontendUrl}/abonnements`;

  const body = `
    <p style="font-size:24px;font-weight:700;color:#1D1D1F;margin:0 0 12px;">Votre abonnement arrive à échéance</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">Bonjour <strong>${esc(clientName)}</strong>,</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">
      Votre abonnement <strong>${esc(serviceName)}</strong>, formule <strong>${esc(planLabel)}</strong>, expire le <strong>${esc(dateFr)}</strong>.
    </p>
    <div style="background:#F5F5F7;padding:16px;border-radius:12px;margin:16px 0;">
      <p style="margin:0;color:#3D3D3F;font-size:14px;">
        Sans renouvellement d'ici là, l'accès sera interrompu à cette date.
      </p>
    </div>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">
      Vous pouvez renouveler dès maintenant pour continuer à profiter de votre abonnement sans interruption.
    </p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${esc(lien)}"
         style="background:#1D1D1F;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Renouveler mon abonnement →
      </a>
    </div>`;

  return layout(`Votre abonnement ${serviceName} expire le ${dateFr}`, body);
}

// ─── Code OTP ────────────────────────────────────────────────────────────────
function renderOTP({ clientName, serviceName, otpCode }) {
  const body = `
    <p style="font-size:24px;font-weight:700;color:#1D1D1F;margin:0 0 12px;">Code de vérification 🔐</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">Bonjour <strong>${esc(clientName)}</strong>,</p>
    <p style="font-size:15px;color:#3D3D3F;margin:6px 0;">Voici votre code de vérification pour <strong>${esc(serviceName)}</strong> :</p>
    <div style="background:#F5F5F7;padding:28px;border-radius:12px;margin:24px 0;text-align:center;">
      <p style="font-size:42px;font-weight:700;letter-spacing:12px;color:#1D1D1F;margin:0;font-family:monospace,monospace;">${esc(otpCode)}</p>
    </div>
    <div style="background:#FFFBEB;padding:16px;border-radius:8px;margin:16px 0;border-left:4px solid #F59E0B;">
      <p style="margin:0;color:#92400E;font-weight:600;">⚠️ Ce code expire dans 10 minutes.</p>
      <p style="margin:4px 0 0;color:#92400E;font-size:13px;">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
    </div>`;

  return layout(`Code de vérification ${serviceName} : ${otpCode}`, body);
}

// ─── Notif OTP admin ──────────────────────────────────────────────────────────
// L'acheteur (qui a payé) et le destinataire (qui a reçu le code) ne sont pas
// toujours la même personne : commande cadeau, ou profil partagé dont
// l'occupant diffère de l'acheteur. `clientName`/`clientWhatsapp` portent
// désormais le destinataire RÉEL du code ; `buyerName`/`buyerWhatsapp`
// (optionnels) portent l'acheteur, affichés seulement quand ils diffèrent du
// destinataire pour ne pas dupliquer la même personne dans l'immense
// majorité des envois.
function renderOTPAdmin({ otp, serviceName, clientName, clientEmail, clientWhatsapp, waSent, emailSent, buyerName, buyerWhatsapp }) {
  const waColor = waSent ? '#166534' : '#7F1D1D';
  const waBg = waSent ? '#F0FDF4' : '#FEF2F2';
  const waBorder = waSent ? '#22C55E' : '#DC2626';
  // `memeNumero` et pas `!==` : acheteur et destinataire viennent de deux
  // saisies distinctes (la commande, l'occupation). Comparés en chaînes
  // brutes, « +229 97 43 75 51 » et « 22997437551 » font apparaître le même
  // client comme deux personnes, et l'admin lit un litige inexistant.
  const acheteurDistinct = Boolean(buyerWhatsapp && !memeNumero(buyerWhatsapp, clientWhatsapp));

  const body = `
    <p style="font-size:22px;font-weight:700;color:#1D1D1F;margin:0 0 16px;">OTP reçu — ${esc(serviceName)} 🔐</p>
    <div style="background:#F5F5F7;padding:28px;border-radius:12px;margin:20px 0;text-align:center;">
      <p style="font-size:42px;font-weight:700;letter-spacing:12px;color:#1D1D1F;margin:0;font-family:monospace,monospace;">${esc(otp)}</p>
    </div>
    <div style="background:#F5F5F7;padding:14px 16px;border-radius:8px;margin:10px 0;">
      <p style="margin:0 0 6px;font-weight:600;color:#1D1D1F;font-size:14px;">👤 Envoyé à</p>
      <p style="margin:2px 0;font-size:14px;color:#3D3D3F;">Nom : <strong>${esc(clientName)}</strong></p>
      <p style="margin:2px 0;font-size:14px;color:#3D3D3F;">WhatsApp : ${esc(clientWhatsapp)}</p>
      ${clientEmail ? `<p style="margin:2px 0;font-size:14px;color:#3D3D3F;">Email : ${esc(clientEmail)}</p>` : ''}
      ${acheteurDistinct ? `<p style="margin:8px 0 2px;font-size:14px;color:#3D3D3F;">🛒 Acheteur : <strong>${esc(buyerName)}</strong> (${esc(buyerWhatsapp)})</p>` : ''}
    </div>
    <div style="background:${waBg};padding:14px 16px;border-radius:8px;margin:10px 0;border-left:4px solid ${waBorder};">
      <p style="margin:0;color:${waColor};font-weight:600;">📤 WhatsApp : ${waSent ? '✅ Code transmis' : '❌ Échec — non livré'}</p>
      <p style="margin:6px 0 0;color:#3D3D3F;font-size:13px;">📧 Email : ${emailSent ? '✅ Code envoyé' : '— Email non disponible'}</p>
    </div>
    <div style="text-align:center;margin:24px 0 8px;">
      <a href="${esc(getFrontendUrl())}/admin/abonnements"
         style="background:#1D1D1F;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Ouvrir les abonnements →
      </a>
    </div>`;

  return layout(`OTP ${serviceName} reçu : ${otp}`, body);
}

// ─── Alerte admin : lien consommé sans trace ──────────────────────────────────
// Gabarit volontairement sobre : c'est un message d'incident, pas une vitrine.
// Il n'a qu'un seul rôle, être lisible vite et porter l'URL du lien — qui, à ce
// stade, n'existe plus nulle part ailleurs qu'ici et dans le journal serveur.
// L'URL est donc affichée en clair, jamais en simple bouton : elle doit rester
// copiable même si le client mail bloque les liens.
function renderAdminLinkIncident({ serviceName, clientName, clientWhatsapp, link }) {
  const body = `
    <p style="font-size:22px;font-weight:700;color:#1D1D1F;margin:0 0 16px;">⚠️ Lien consommé sans trace</p>
    <div style="background:#FEF2F2;padding:14px 16px;border-radius:8px;margin:10px 0;border-left:4px solid #DC2626;">
      <p style="margin:0;color:#7F1D1D;font-size:14px;">
        Un lien d'accès a été retiré de la réserve, mais son enregistrement en base
        a échoué : aucune ligne cliente ne le porte. Il faut l'envoyer à la main.
      </p>
    </div>
    <div style="background:#F5F5F7;padding:14px 16px;border-radius:8px;margin:10px 0;">
      <p style="margin:2px 0;font-size:14px;color:#3D3D3F;">Service : <strong>${esc(serviceName)}</strong></p>
      <p style="margin:2px 0;font-size:14px;color:#3D3D3F;">Client : <strong>${esc(clientName)}</strong></p>
      ${clientWhatsapp ? `<p style="margin:2px 0;font-size:14px;color:#3D3D3F;">WhatsApp : ${esc(clientWhatsapp)}</p>` : ''}
    </div>
    <div style="background:#F5F5F7;padding:14px 16px;border-radius:8px;margin:10px 0;">
      <p style="margin:0 0 6px;font-weight:600;color:#1D1D1F;font-size:14px;">🔗 Lien à transmettre</p>
      <p style="margin:2px 0;font-size:13px;color:#3D3D3F;word-break:break-all;font-family:monospace,monospace;">${esc(link)}</p>
    </div>`;

  return layout(`Lien ${serviceName} consommé sans trace — action requise`, body);
}

// ─── Alerte admin générique ───────────────────────────────────────────────────
// Repli e-mail des alertes du bot OTP, écrites à l'origine pour WhatsApp. On
// reprend le texte tel quel plutôt que de le remettre en forme : il est déjà
// rédigé pour être lu vite, et une alerte doit rester identique quel que soit
// le canal qui la porte. Seul le gras WhatsApp `*mot*` est traduit en HTML, et
// le texte est échappé AVANT pour qu'un objet de mail piégé ne puisse pas
// injecter de balises.
function renderAdminAlert({ sujet, message }) {
  const corps = esc(message)
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');

  const body = `
    <p style="font-size:20px;font-weight:700;color:#1D1D1F;margin:0 0 16px;">${esc(sujet)}</p>
    <div style="background:#FFFBEB;padding:14px 16px;border-radius:8px;margin:10px 0;border-left:4px solid #F59E0B;">
      <p style="margin:0;color:#92400E;font-size:13px;">
        WhatsApp n'a pas pu délivrer cette alerte — elle vous parvient par e-mail.
      </p>
    </div>
    <div style="background:#F5F5F7;padding:16px;border-radius:8px;margin:12px 0;">
      <p style="margin:0;font-size:14px;color:#3D3D3F;line-height:1.6;">${corps}</p>
    </div>`;

  return layout(sujet, body);
}

module.exports = {
  getFrontendUrl,
  renderAdminAlert,
  renderOrderConfirm,
  renderOrderAdmin,
  renderSubCredentials,
  renderSubExpiryReminder,
  renderLinkAccess,
  renderOTP,
  renderOTPAdmin,
  renderAdminLinkIncident,
};
