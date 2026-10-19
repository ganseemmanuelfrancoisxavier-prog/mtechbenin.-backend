const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

// ── Parse images stockées en JSON string ou array ─────────────────────────────
function parseImages(images) {
  if (!images) return [];
  try {
    const parsed = typeof images === "string" ? JSON.parse(images) : images;
    return Array.isArray(parsed)
      ? parsed.filter(Boolean)
      : [parsed].filter(Boolean);
  } catch {
    // C'est déjà une URL simple
    return typeof images === "string" && images.startsWith("http")
      ? [images]
      : [];
  }
}

// ── Normalise un produit avant envoi au frontend ──────────────────────────────
// `includeVariantTypes` distingue deux usages :
//  - fiche produit (getProductBySlug) : le détail complet (options, valeurs,
//    suppléments) est nécessaire au sélecteur de caractéristiques → conservé.
//  - listes (getProducts, searchProducts) : ces endpoints servent le catalogue
//    entier (103 produits) et ne doivent pas alourdir la réponse avec les
//    valeurs/suppléments de chaque caractéristique. On ne renvoie que
//    `hasRequiredVariants`, l'unique information dont une vignette a besoin
//    pour savoir si le produit est commandable en un clic ou non.
function normalizeProduct(p, { includeVariantTypes = true } = {}) {
  const imgs = parseImages(p.images);
  const { variantTypes, ...rest } = p;
  const normalized = {
    ...rest,
    images: imgs,
    image: imgs[0] || null,
    videoUrl: p.videoUrl || null,
  };
  if (includeVariantTypes) {
    if (variantTypes !== undefined) normalized.variantTypes = variantTypes;
  } else if (variantTypes !== undefined) {
    normalized.hasRequiredVariants = variantTypes.length > 0;
  }
  return normalized;
}

async function getProducts(req, res) {
  try {
    const { category, featured, active = "true", search, includeInactive } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    // Plafond de sécurité côté serveur : il borne ce qu'un appelant peut
    // demander, quelle que soit la valeur envoyée. Le frontend charge le
    // catalogue en une fois, il doit donc rester au-dessus du nombre réel de
    // produits, sinon une partie du catalogue devient invisible sans erreur.
    // Plafond de sécurité : il borne ce qu'un appelant peut demander, quelle
    // que soit la valeur envoyée. Le panel admin et la boutique chargent le
    // catalogue en une fois — il doit donc rester au-dessus du nombre réel de
    // produits, sinon les derniers disparaissent de l'écran sans aucune erreur.
    // Déjà porté de 100 à 250 le 28/07 pour cette raison (deux produits actifs
    // étaient devenus invisibles) ; porté à 500 pour reprendre de la marge.
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 24));

    const where = {};

    if (!includeInactive || includeInactive === "false") {
      where.active = active === "true";
    }

    if (category) where.categorySlug = category;
    if (featured) where.featured = featured === "true";
    if (search)
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        // Léger à dessein : seul l'id des caractéristiques obligatoires est
        // chargé (pas les valeurs, pas les suppléments) pour permettre aux
        // vignettes de savoir si le produit nécessite un choix avant achat.
        include: {
          variantTypes: {
            where: { required: true },
            select: { id: true },
          },
        },
      }),
      prisma.product.count({ where }),
    ]);

    return res.json({
      products: products.map((p) => normalizeProduct(p, { includeVariantTypes: false })),
      total,
      page,
      limit,
    });
  } catch (err) {
    logger.error("Erreur getProducts", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function searchProducts(req, res) {
  try {
    const { q } = req.query;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    if (!q?.trim()) return res.json({ products: [] });

    const products = await prisma.product.findMany({
      where: {
        active: true,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
          { categorySlug: { contains: q, mode: "insensitive" } },
        ],
      },
      take: limit,
      orderBy: { salesCount: "desc" },
      include: {
        variantTypes: {
          where: { required: true },
          select: { id: true },
        },
      },
    });

    return res.json({
      products: products.map((p) => normalizeProduct(p, { includeVariantTypes: false })),
      total: products.length,
    });
  } catch (err) {
    logger.error("Erreur searchProducts", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function getProductBySlug(req, res) {
  try {
    const product = await prisma.product.findUnique({
      where: { slug: req.params.slug },
      include: {
        reviews: { where: { approved: true }, orderBy: { createdAt: "desc" } },
        variantTypes: {
          orderBy: { sortOrder: "asc" },
          include: { options: { orderBy: { sortOrder: "asc" } } },
        },
      },
    });
    if (!product) return res.status(404).json({ error: "Produit introuvable" });
    return res.json({ product: normalizeProduct(product) });
  } catch (err) {
    logger.error("Erreur getProductBySlug", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

function sanitizeProductData(body) {
  const {
    name, slug, description, price, comparePrice, stock,
    categorySlug, images, videoUrl, featured, active, status, specs,
  } = body;
  return {
    ...(name !== undefined && { name }),
    ...(slug !== undefined && { slug }),
    ...(description !== undefined && { description }),
    ...(price !== undefined && { price: Number(price) }),
    ...(comparePrice !== undefined && { comparePrice: comparePrice ? Number(comparePrice) : null }),
    ...(stock !== undefined && { stock: Number(stock) }),
    ...(status !== undefined && { status }),
    ...(categorySlug !== undefined && { categorySlug }),
    ...(images !== undefined && { images }),
    ...(videoUrl !== undefined && { videoUrl: videoUrl || null }),
    ...(featured !== undefined && { featured: Boolean(featured) }),
    ...(active !== undefined && { active: Boolean(active) }),
    ...(specs !== undefined && { specs }),
  };
}

async function createProduct(req, res) {
  try {
    const data = sanitizeProductData(req.body);
    const product = await prisma.product.create({ data });
    return res.status(201).json({ product: normalizeProduct(product) });
  } catch (err) {
    logger.error("Erreur createProduct", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function updateProduct(req, res) {
  try {
    const data = sanitizeProductData(req.body);
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data,
    });
    return res.json({ product: normalizeProduct(product) });
  } catch (err) {
    logger.error("Erreur updateProduct", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

async function deleteProduct(req, res) {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    return res.json({ message: "Produit supprimé" });
  } catch (err) {
    logger.error("Erreur deleteProduct", { err: err.message });
    return res.status(400).json({ error: err.message });
  }
}

module.exports = {
  getProducts,
  searchProducts,
  getProductBySlug,
  createProduct,
  updateProduct,
  deleteProduct,
};
