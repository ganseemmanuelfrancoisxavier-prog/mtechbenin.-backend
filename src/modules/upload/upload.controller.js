const cloudinary = require("../../services/cloudinary");
const logger = require("../../utils/logger");

async function uploadMedia(req, res) {
  try {
    const { image, folder = "mtechbenin/products" } = req.body;

    if (!image)
      return res.status(400).json({ error: "Fichier requis (base64 ou URL)" });

    // Détecte si c'est une vidéo
    const isVideo =
      image.startsWith("data:video") || /\.(mp4|mov|avi|webm)$/i.test(image);

    const options = isVideo
      ? {
          folder,
          resource_type: "video",
          transformation: [{ quality: "auto" }, { width: 1280, crop: "limit" }],
        }
      : {
          folder,
          resource_type: "image",
          transformation: [
            { quality: "auto", fetch_format: "webp" },
            { width: 1200, crop: "limit" },
          ],
        };

    const result = await cloudinary.uploader.upload(image, options);

    return res.json({
      url: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type, // "image" ou "video"
      width: result.width,
      height: result.height,
      duration: result.duration || null, // pour les vidéos
      format: result.format,
    });
  } catch (err) {
    logger.error("Erreur upload Cloudinary", { err: err.message });
    return res.status(500).json({ error: "Erreur upload média" });
  }
}

async function deleteMedia(req, res) {
  try {
    const { publicId, resourceType = "image" } = req.body;
    if (!publicId) return res.status(400).json({ error: "publicId requis" });

    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });
    return res.json({ message: "Média supprimé" });
  } catch (err) {
    logger.error("Erreur delete Cloudinary", { err: err.message });
    return res.status(500).json({ error: "Erreur suppression média" });
  }
}

module.exports = { uploadMedia, deleteMedia };
