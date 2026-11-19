const logger = require("../utils/logger");
const whatsapp = require("./whatsapp");
const redis = require("./redis");
const { ouvrirDemandes } = require("../modules/subscriptions/demandeCodeStore");
const { motCleDemande, normaliserNumero } = require("../modules/subscriptions/demandeCode");

// Le numéro de souscription peut être différent du WhatsApp qui demande le
// code. On garde le JID d'origine pour y envoyer l'OTP après vérification de
// l'abonnement actif correspondant au numéro fourni.
const demandesNumero = new Map();
const ATTENTE_NUMERO_MS = 5 * 60 * 1000;

const CLE_ATTENTE_WEB = (numero) => "otp-phone-flow:" + numero;

async function demanderNumeroSouscription(numeroBrut) {
  const numero = normaliserNumero(numeroBrut);
  if (!numero) return false;

  const cle = CLE_ATTENTE_WEB(numero);
  await redis.set(cle, "1", { ex: ATTENTE_NUMERO_MS });
  const envoye = await whatsapp.sendMessage(
    numero,
    [
      "Bonjour. Pour vérifier votre abonnement Netflix, répondez à ce message avec le numéro utilisé lors de votre souscription.",
      "Après nous avoir envoyé ce numéro, reconnectez-vous à Netflix et demandez un nouveau code. Nous vous le transmettrons ici dès sa réception.",
      "Vous avez 5 minutes pour nous envoyer le numéro de souscription.",
    ].join("\n"),
  );

  if (!envoye) await redis.del(cle);
  return envoye;
}

// Traite un message entrant. Rend un compte rendu plutôt que rien, pour que
// l'appelant puisse journaliser sans avoir à deviner ce qui s'est passé.
//
// Le silence est le comportement par défaut : ce numéro est aussi celui du
// service client, et un bot qui répond à tout s'immisce dans des conversations
// qui ne le regardent pas.
// `adresse` et `numero` sont deux valeurs distinctes, et les confondre casse
// tout le chemin (voir whatsappMessage.js) :
//   • `adresse` est le JID d'origine — la seule chose à quoi répondre, reprise
//     telle quelle et jamais reconstruite à partir de ses chiffres ;
//   • `numero` est ce qu'on rapproche des occupations enregistrées.
// Sur un JID classique les deux coïncident ; sur un identifiant masqué
// (`…@lid`) elles n'ont même pas les mêmes chiffres.
async function traiterMessageEntrant({ adresse, numero, texte }) {
  const maintenant = Date.now();
  for (const [jid, demande] of demandesNumero) {
    if (demande.expireLe <= maintenant) demandesNumero.delete(jid);
  }

  // Redirige les questions vers le numéro principal. L’état d’une demande OTP
  // en cours est conservé : le client peut toujours envoyer ensuite le numéro
  // de souscription demandé par le bot.
  if (/[?？]/u.test(String(texte || ""))) {
    await whatsapp.sendMessageToJid(
      adresse,
      "Pour toute question, demande d’explication ou pour découvrir nos contenus, contactez directement notre numéro principal : +229 60 50 63 20.",
    );
    return { traite: true, raison: "question-redirigee" };
  }

  if (motCleDemande(texte)) {
    const numeroDemandeur = normaliserNumero(numero);
    if (numeroDemandeur) await redis.del(CLE_ATTENTE_WEB(numeroDemandeur));
    demandesNumero.set(adresse, { expireLe: maintenant + ATTENTE_NUMERO_MS });
    await whatsapp.sendMessageToJid(
      adresse,
      [
        `Pour vérifier votre abonnement, envoyez nous le numéro utilisé lors de la souscription.`,
        `Exemple : +229 97 00 00 00`,
        `Vous avez 5 minutes. Le numéro peut être différent de celui de ce WhatsApp.`,
      ].join("\n"),
    );
    return { traite: true, raison: "numero-demande" };
  }

  const attente = demandesNumero.get(adresse);
  const numeroDemandeur = normaliserNumero(numero);
  const cleAttenteWeb = numeroDemandeur ? CLE_ATTENTE_WEB(numeroDemandeur) : null;
  const attenteWeb = cleAttenteWeb ? await redis.get(cleAttenteWeb) : null;
  if (!attente && !attenteWeb) return { traite: false, raison: "hors-sujet" };
  demandesNumero.delete(adresse);
  if (attenteWeb) await redis.del(cleAttenteWeb);

  const numeroSouscription = normaliserNumero(texte);
  if (!numeroSouscription) {
    await whatsapp.sendMessageToJid(
      adresse,
      `Numéro non reconnu. Écrivez « code » pour recommencer et saisissez le numéro utilisé pour souscrire.`,
    );
    return { traite: true, raison: "numero-souscription-invalide" };
  }

  const { demandes, occupations, raison } = await ouvrirDemandes({
    numero: numeroSouscription,
    canal: "whatsapp",
    demandeurJid: adresse,
  });

  if (raison === "numero-invalide") {
    return { traite: false, raison };
  }

  if (raison === "trop-de-demandes") {
    await whatsapp.sendMessageToJid(
      adresse,
      `Vous avez déjà plusieurs demandes en cours. Patientez quelques minutes avant d'en formuler une nouvelle.`,
    );
    return { traite: true, raison };
  }

  if (raison === "aucune-occupation-active") {
    // Répondre est ici plus utile que se taire : le client a suivi la
    // procédure qu'on lui a donnée, et un silence lui ferait croire à une
    // panne. On lui dit ce qu'il en est sans rien promettre.
    await whatsapp.sendMessageToJid(
      adresse,
      [
        `Nous ne trouvons aucun abonnement actif à ce numéro.`,
        ``,
        `Si vous venez de payer, laissez-nous quelques minutes.`,
        `Sinon, votre abonnement est peut-être arrivé à échéance — écrivez-nous pour le renouveler.`,
      ].join("\n"),
    );
    return { traite: true, raison };
  }

  const services = [
    ...new Set(occupations.map((o) => o.profile?.profile).filter(Boolean)),
  ];
  await whatsapp.sendMessageToJid(
    adresse,
    [
      `✅ Demande enregistrée.`,
      `\nReconnectez-vous à Netflix et demandez un nouveau code. Dès qu'il arrive, nous vous l'envoyons ici.`,
      services.length ? `Profil concerné : ${services.join(", ")}` : null,
      `\nCette demande reste valable 15 minutes.`,
    ]
      // `.filter(Boolean)` est la convention des gabarits de whatsapp.js. Les
      // respirations passent donc par un `\n` en tête de ligne, jamais par une
      // chaîne vide : sinon l'absence de nom de profil laisserait une ligne
      // vide orpheline au milieu du message.
      .filter(Boolean)
      .join("\n"),
  );

  logger.info("Demande de code par WhatsApp", { demandes: demandes.length });
  return { traite: true, raison: "ouvertes" };
}

module.exports = { traiterMessageEntrant, demanderNumeroSouscription };
