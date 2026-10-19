// ─────────────────────────────────────────────────────────────────────────────
// Journal des mails traites par le bot OTP — et garde d'unicite.
//
// Refonte du 13/10/2026. Chaque mail de service est REVENDIQUE avant tout
// envoi : une ligne est creee sur son Message-ID, cle unique en base. Un mail
// lu deux fois — present dans deux boites par renvoi, ou pris par deux passes
// concurrentes — se heurte a la contrainte et n'est pas traite une seconde
// fois. La garde tient dans la base, pas dans un test prealable que deux
// processus pourraient passer en meme temps.
//
// La meme ligne garde la trace de la decision (type, compte, destinataire,
// raison). OTPLog ne gardait que la commande et le code : l'audit du 13/10 a du
// reconstituer le reste dans les journaux du serveur, qui ne couvrent que deux
// jours et demi.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const prisma = require("../src/services/prisma");
const logger = require("../src/utils/logger");

// La cle d'un mail : son Message-ID, ou a defaut une empreinte STABLE de son
// contenu. L'empreinte ignore la boite : un mail renvoye dans une seconde boite
// est le meme mail.
function cleCourriel({ messageId, expediteur, date, sujet, code } = {}) {
  const id = String(messageId || "").trim();
  if (id) return id;
  const d = date instanceof Date ? date.toISOString() : String(date || "");
  const empreinte = crypto
    .createHash("sha256")
    .update([expediteur, d, sujet, code].map((v) => String(v || "")).join("\n"))
    .digest("hex")
    .slice(0, 32);
  return `sans-id:${empreinte}`;
}

// Revendique un mail. Rend :
//   • la ligne creee — le mail est a nous, on le traite ;
//   • `null` — deja revendique, on s'arrete ;
//   • `{ indisponible: true }` — la table manque ou la base hoquette. On
//     continue SANS garde d'unicite plutot que de perdre le code : les mails
//     sont marques lus avant traitement et ne seront jamais relus. La garde par
//     commande (OTPLog) reste en place derriere.
async function revendiquerCourriel(champs) {
  try {
    return await prisma.otpCourriel.create({ data: champs });
  } catch (err) {
    if (err?.code === "P2002") return null;
    logger.warn("Journal des courriels OTP indisponible — traitement sans garde d'unicite", {
      err: err.message,
    });
    return { indisponible: true };
  }
}

// Consigne la decision prise sur un mail revendique. Sans ligne (journal
// indisponible), ne fait rien : la trace manque, l'envoi n'en depend pas.
async function consignerCourriel(ligne, champs) {
  if (!ligne?.id) return;
  try {
    await prisma.otpCourriel.update({ where: { id: ligne.id }, data: champs });
  } catch (err) {
    logger.warn("Consignation du courriel OTP echouee", { err: err.message });
  }
}

module.exports = { cleCourriel, revendiquerCourriel, consignerCourriel };
