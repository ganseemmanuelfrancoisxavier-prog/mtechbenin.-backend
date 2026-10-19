const crypto = require("crypto");
const logger = require("./logger");

const ALGORITHM      = "aes-256-cbc";
const FALLBACK_KEY   = "mtechbenin_aes_key_2026_32chars_!!";
const SECRET_KEY     = process.env.AES_SECRET_KEY || FALLBACK_KEY;

const CLE_PAR_DEFAUT = !process.env.AES_SECRET_KEY;

// La clé de secours reste utilisée pour DÉCHIFFRER : la retirer rendrait
// illisibles les identifiants déjà stockés avec elle. Mais elle figure en clair
// dans ce fichier, donc dans le dépôt : chiffrer de NOUVEAUX secrets avec elle
// revient à les stocker en clair pour quiconque a lu le code. En production, on
// refuse donc de le faire plutôt que de se contenter d'un avertissement que
// personne ne lit.
if (CLE_PAR_DEFAUT) {
  logger.error(
    "AES_SECRET_KEY non configurée — la clé par défaut est publiée dans le dépôt. " +
      "Le déchiffrement des identifiants existants reste possible, mais aucun nouvel " +
      "identifiant ne sera chiffré en production tant que la variable est absente.",
  );
}

const KEY = crypto.scryptSync(SECRET_KEY, "salt", 32);

function encrypt(text) {
  if (CLE_PAR_DEFAUT && process.env.NODE_ENV === "production") {
    throw new Error(
      "AES_SECRET_KEY absente — refus de chiffrer un identifiant avec la clé publique du dépôt. " +
        "Définissez AES_SECRET_KEY sur l'hébergeur.",
    );
  }
  const iv         = crypto.randomBytes(16);
  const cipher     = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted  = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

// Lève une exception explicite sur une valeur qui n'a pas la forme attendue,
// au lieu de laisser `Buffer.from(undefined, "hex")` produire une erreur
// obscure. Les appelants distinguent ainsi « valeur absente » de « mauvaise clé ».
function decrypt(encryptedText) {
  if (typeof encryptedText !== "string" || !encryptedText.includes(":")) {
    throw new Error("Valeur chiffrée absente ou malformée");
  }
  const [ivHex, encryptedHex] = encryptedText.split(":");
  const iv        = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  if (iv.length !== 16) throw new Error("Vecteur d'initialisation invalide");
  const decipher  = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString();
}

module.exports = { encrypt, decrypt };
