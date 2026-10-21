// ─────────────────────────────────────────────────────────────────────────────
// Envoi de photos jointes à un avis client.
//
// C'est le SEUL endpoint d'upload ouvert au public : le formulaire d'avis
// n'exige aucun compte. Tout ce qui suit part du principe qu'un visiteur peut
// être malveillant. L'endpoint d'upload administrateur reste protégé et
// inchangé — on ne lui a pas retiré `isAdmin` pour les besoins de ce formulaire.
// ─────────────────────────────────────────────────────────────────────────────

const cloudinary = require("../../services/cloudinary");
const logger = require("../../utils/logger");

const DOSSIER = "mtechbenin/reviews";
const TAILLE_MAX_MO = 5;
const MAX_PHOTOS = 3;

// Images uniquement. Une vidéo déguisée en `data:image/...` serait de toute
// façon rejetée par Cloudinary puisqu'on force `resource_type: "image"`.
const TYPES_ACCEPTES = ["jpeg", "jpg", "png", "webp", "heic", "heif"];
const PREFIXE_DATA = /^data:image\/([a-z0-9.+-]+);base64,/i;

// Taille réelle du fichier à partir de la longueur du base64 : 4 caractères
// encodent 3 octets, moins le rembourrage final.
function tailleDecodee(base64) {
  const net = base64.replace(/=+$/, "").length;
  return Math.floor((net * 3) / 4);
}

/**
 * Valide une image envoyée en `data:` URI.
 * @returns {{ ok: true } | { ok: false, erreur: string }}
 */
function validerImage(donnee) {
  if (typeof donnee !== "string" || !donnee) {
    return { ok: false, erreur: "Aucune image reçue" };
  }

  const entete = donnee.match(PREFIXE_DATA);
  if (!entete) {
    return {
      ok: false,
      erreur: "Format non accepté — envoyez une image JPG, PNG ou WEBP",
    };
  }

  const format = entete[1].toLowerCase();
  if (!TYPES_ACCEPTES.includes(format)) {
    return {
      ok: false,
      erreur: "Format non accepté — envoyez une image JPG, PNG ou WEBP",
    };
  }

  const octets = tailleDecodee(donnee.slice(entete[0].length));
  if (octets > TAILLE_MAX_MO * 1024 * 1024) {
    return {
      ok: false,
      erreur: `Image trop lourde (${Math.round(octets / 1024 / 1024)} Mo) — maximum ${TAILLE_MAX_MO} Mo`,
    };
  }

  return { ok: true };
}

// ── Endpoint public ──────────────────────────────────────────────────────────
async function uploadReviewPhoto(req, res) {
  try {
    const { image } = req.body;

    const verdict = validerImage(image);
    if (!verdict.ok) return res.status(400).json({ error: verdict.erreur });

    const result = await cloudinary.uploader.upload(image, {
      folder: DOSSIER,
      // Forcé : même si l'en-tête `data:` mentait, Cloudinary refuserait une
      // vidéo présentée comme une image.
      resource_type: "image",
      transformation: [
        { quality: "auto", fetch_format: "webp" },
        { width: 1200, crop: "limit" },
      ],
    });

    // On ne renvoie que l'URL : exposer le publicId permettrait à un visiteur
    // de cibler la suppression d'une photo qui ne lui appartient pas.
    return res.json({ url: result.secure_url });
  } catch (err) {
    logger.error("Erreur upload photo d'avis", { err: err.message });
    return res
      .status(500)
      .json({ error: "Envoi impossible pour le moment — réessayez" });
  }
}

// ── Validation des URLs au moment de créer l'avis ────────────────────────────
// Le client renvoie les URLs obtenues ci-dessus, mais rien ne l'empêche d'en
// inventer d'autres : sans ce filtre, n'importe quelle image externe pourrait
// être injectée dans une page du site.
function filtrerPhotosAutorisees(photos) {
  if (!Array.isArray(photos)) return [];
  return photos
    .filter((url) => typeof url === "string")
    .map((url) => url.trim())
    .filter((url) => {
      try {
        const u = new URL(url);
        return (
          u.protocol === "https:" &&
          u.hostname === "res.cloudinary.com" &&
          u.pathname.includes(DOSSIER)
        );
      } catch {
        return false;
      }
    })
    .slice(0, MAX_PHOTOS);
}

module.exports = {
  uploadReviewPhoto,
  filtrerPhotosAutorisees,
  validerImage,
  DOSSIER,
  TAILLE_MAX_MO,
  MAX_PHOTOS,
};
