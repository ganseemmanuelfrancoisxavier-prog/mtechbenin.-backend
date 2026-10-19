const bcrypt = require("bcryptjs");
const prisma = require("../../services/prisma");

// Clés publiques exposées sans auth
const PUBLIC_KEYS = [
  "shopName",
  "shopSlogan",
  "shopEmail",
  "shopWhatsapp",
  "shopAddress",
  "shopFacebook",
  "shopInstagram",
  "shopTiktok",
  "fedapayPublicKey",
  "fedapayEnv", // ← remplacé kkiapay
  "paymentFeePercent",
  "maintenanceMode",
  "maintenanceMessage",
  // Le client doit voir le montant des frais d'enlèvement AVANT de payer
  // (cas 3 de la spec réparation : « il décrit le problème, paie les frais
  // d'enlèvement ») — sans cette clé, aucune page publique ne peut afficher
  // ce montant ni savoir s'il y a même quelque chose à payer.
  "fraisEnlevementReparation",
];

async function getPublicSettings(req, res) {
  try {
    const settings = await prisma.setting.findMany({
      where: { key: { in: PUBLIC_KEYS } },
    });
    const result = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    return res.json({ settings: result });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Réglages jamais renvoyés, même à un administrateur authentifié : le panel
// n'en a aucun usage (le champ de saisie du mot de passe part toujours vide) et
// les faire transiter les expose au cache du navigateur, aux journaux d'un
// proxy et à toute extension installée. Un secret qu'on ne renvoie pas est un
// secret qu'on ne peut pas perdre.
const CLES_JAMAIS_EXPOSEES = new Set(["adminPassword"]);

async function getAllSettings(req, res) {
  try {
    const settings = await prisma.setting.findMany();
    const result = Object.fromEntries(
      settings
        .filter((s) => !CLES_JAMAIS_EXPOSEES.has(s.key))
        .map((s) => [s.key, s.value]),
    );
    return res.json({ settings: result });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

// Longueur minimale d'un mot de passe d'administration.
//
// Huit caracteres n'est pas une exigence severe ; c'est le seuil en dessous
// duquel la borne existe surtout pour arreter les valeurs accidentelles.
const LONGUEUR_MIN_MOT_DE_PASSE = 8;

// Valide un nouveau mot de passe AVANT tout hachage.
//
// Cette fonction existe a cause d'un defaut precis, et le detail compte : le
// code testait `if (key === "adminPassword" && value)`. Une chaine VIDE est
// falsy, elle echappait donc a la branche de hachage — et retombait sur
// `String(value)`, qui l'enregistrait telle quelle. Le mot de passe devenait
// litteralement "" : verifie ensuite par bcrypt.compare contre une valeur qui
// n'est pas un hash, il ne pouvait plus jamais correspondre. PERSONNE n'aurait
// pu se reconnecter, et rien dans la reponse ne l'aurait annonce — l'API
// repondait « Parametres mis a jour ».
//
// On refuse desormais au lieu d'ecrire. Refuser est bruyant ; ecrire une
// valeur inutilisable est silencieux, et c'est ce silence qui coute cher.
function validerNouveauMotDePasse(valeur) {
  if (typeof valeur !== "string") {
    return { ok: false, message: "Le mot de passe doit être une chaîne de caractères." };
  }
  // Pas de `trim()` sur la valeur conservee : un espace peut faire partie d'un
  // mot de passe. Il ne peut simplement pas le constituer a lui seul.
  if (valeur.trim().length === 0) {
    return { ok: false, message: "Le mot de passe ne peut pas être vide." };
  }
  if (valeur.length < LONGUEUR_MIN_MOT_DE_PASSE) {
    return {
      ok: false,
      message: `Le mot de passe doit faire au moins ${LONGUEUR_MIN_MOT_DE_PASSE} caractères.`,
    };
  }
  return { ok: true, valeur };
}

async function updateSettings(req, res) {
  try {
    const updates = req.body;

    // Deux passes : on VALIDE tout avant d'ecrire quoi que ce soit. Sans cela,
    // un lot contenant un reglage valide puis un mot de passe refuse laisserait
    // la moitie des reglages appliques et l'autre non, sans moyen de savoir
    // lesquels.
    for (const [key, value] of Object.entries(updates)) {
      if (key !== "adminPassword") continue;
      const verdict = validerNouveauMotDePasse(value);
      if (!verdict.ok) return res.status(400).json({ error: verdict.message });
    }

    for (const [key, value] of Object.entries(updates)) {
      const storedValue =
        key === "adminPassword" ? await bcrypt.hash(value, 10) : String(value);
      await prisma.setting.upsert({
        where: { key },
        create: { key, value: storedValue },
        update: { value: storedValue },
      });
    }
    return res.json({ message: "Paramètres mis à jour" });
  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

module.exports = {
  getPublicSettings,
  getAllSettings,
  updateSettings,
  validerNouveauMotDePasse,
  LONGUEUR_MIN_MOT_DE_PASSE,
};
