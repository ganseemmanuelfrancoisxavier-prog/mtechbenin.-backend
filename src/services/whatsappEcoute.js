const logger = require("../utils/logger");
const whatsapp = require("./whatsapp");
const { ouvrirDemandes } = require("../modules/subscriptions/demandeCodeStore");
const { motCleDemande } = require("../modules/subscriptions/demandeCode");

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
  if (!motCleDemande(texte)) return { traite: false, raison: "hors-sujet" };

  const { demandes, occupations, raison } = await ouvrirDemandes({
    numero,
    canal: "whatsapp",
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
      `\nConnectez-vous maintenant : dès que le code arrive, nous vous l'envoyons ici.`,
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

module.exports = { traiterMessageEntrant };
