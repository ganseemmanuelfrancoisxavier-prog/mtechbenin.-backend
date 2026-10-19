const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

async function listCharacteristics(req, res) {
  try {
    const characteristics = await prisma.characteristic.findMany({
      orderBy: { name: "asc" },
      include: {
        values: { orderBy: [{ sortOrder: "asc" }, { value: "asc" }] },
        _count: { select: { usedBy: true } },
      },
    });
    return res.json({ characteristics });
  } catch (err) {
    logger.error("Erreur listCharacteristics", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function createCharacteristic(req, res) {
  try {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Nom requis" });
    const characteristic = await prisma.characteristic.create({
      data: { name },
      include: { values: true, _count: { select: { usedBy: true } } },
    });
    return res.status(201).json({ characteristic });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Cette caractéristique existe déjà." });
    }
    logger.error("Erreur createCharacteristic", { err: err.message });
    return res.status(400).json({ error: "Création impossible" });
  }
}

// `ProductVariantType.name` est une copie figée au moment du rattachement (elle
// n'est pas dérivée dynamiquement de `Characteristic.name`). Sans propagation,
// renommer la caractéristique dans la bibliothèque laisserait les produits déjà
// rattachés afficher indéfiniment l'ancien nom. Les deux écritures doivent
// réussir ou échouer ensemble, d'où la transaction.
// On ne touche volontairement pas à `OrderItem.variants` : c'est un
// enregistrement historique du nom en vigueur au moment de l'achat.
async function updateCharacteristic(req, res) {
  try {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Nom requis" });

    const liens = await prisma.productVariantType.findMany({
      where: { characteristicId: req.params.id },
      select: { productId: true },
    });
    const produitsDistincts = new Set(liens.map((l) => l.productId)).size;

    const [characteristic] = await prisma.$transaction([
      prisma.characteristic.update({
        where: { id: req.params.id },
        data: { name },
        include: { values: true, _count: { select: { usedBy: true } } },
      }),
      prisma.productVariantType.updateMany({
        where: { characteristicId: req.params.id },
        data: { name },
      }),
    ]);

    return res.json({ characteristic, produitsMisAJour: produitsDistincts });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Ce nom est déjà pris." });
    }
    logger.error("Erreur updateCharacteristic", { err: err.message });
    return res.status(400).json({ error: "Modification impossible" });
  }
}

// Suppression refusée si des produits l'utilisent : la liste est renvoyée pour
// que l'administrateur sache où intervenir, plutôt que de subir un échec sec.
//
// Deux sources d'usage distinctes doivent être vérifiées :
//  1. ProductVariantType.characteristicId — le type de variante d'un produit
//     est directement rattaché à cette caractéristique.
//  2. ProductVariantOption.valueId — une option de variante pointe vers une
//     valeur de cette caractéristique. Rien ne garantit qu'une telle option
//     appartienne à un ProductVariantType déjà couvert par (1) : la contrainte
//     characteristicId → valueId n'est pas imposée en base. Comme
//     CharacteristicValue → Characteristic est en ON DELETE CASCADE, ignorer
//     cette source viderait silencieusement ces options si la suppression
//     passait.
// Le compte de produits annoncé est dédupliqué (un même produit peut apparaître
// via plusieurs lignes ProductVariantType/ProductVariantOption).
async function deleteCharacteristic(req, res) {
  try {
    const [typeLiens, optionLiens] = await Promise.all([
      prisma.productVariantType.findMany({
        where: { characteristicId: req.params.id },
        include: { product: { select: { name: true } } },
      }),
      prisma.productVariantOption.findMany({
        where: { libValue: { characteristicId: req.params.id } },
        include: { variantType: { include: { product: { select: { name: true } } } } },
      }),
    ]);

    const produits = new Set();
    typeLiens.forEach((l) => {
      if (l.product?.name) produits.add(l.product.name);
    });
    optionLiens.forEach((l) => {
      if (l.variantType?.product?.name) produits.add(l.variantType.product.name);
    });

    if (produits.size > 0) {
      return res.status(409).json({
        error: `Utilisée par ${produits.size} produit(s)`,
        produits: Array.from(produits),
      });
    }
    await prisma.characteristic.delete({ where: { id: req.params.id } });
    return res.json({ message: "Caractéristique supprimée" });
  } catch (err) {
    logger.error("Erreur deleteCharacteristic", { err: err.message });
    return res.status(400).json({ error: "Suppression impossible" });
  }
}

async function addValue(req, res) {
  try {
    const value = (req.body.value || "").trim();
    if (!value) return res.status(400).json({ error: "Valeur requise" });
    const created = await prisma.characteristicValue.create({
      data: {
        characteristicId: req.params.id,
        value,
        sortOrder: Number(req.body.sortOrder) || 0,
      },
    });
    return res.status(201).json({ value: created });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Cette valeur existe déjà." });
    }
    logger.error("Erreur addValue", { err: err.message });
    return res.status(400).json({ error: "Ajout impossible" });
  }
}

async function updateValue(req, res) {
  try {
    const data = {};
    if (req.body.value !== undefined) {
      const v = (req.body.value || "").trim();
      if (!v) return res.status(400).json({ error: "Valeur requise" });
      data.value = v;
    }
    if (req.body.sortOrder !== undefined) data.sortOrder = Number(req.body.sortOrder) || 0;
    const updated = await prisma.characteristicValue.update({
      where: { id: req.params.valueId },
      data,
    });
    return res.json({ value: updated });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Cette valeur existe déjà." });
    }
    logger.error("Erreur updateValue", { err: err.message });
    return res.status(400).json({ error: "Modification impossible" });
  }
}

async function deleteValue(req, res) {
  try {
    const liens = await prisma.productVariantOption.findMany({
      where: { valueId: req.params.valueId },
      include: { variantType: { include: { product: { select: { name: true } } } } },
    });
    if (liens.length > 0) {
      const produits = Array.from(
        new Set(liens.map((l) => l.variantType?.product?.name).filter(Boolean)),
      );
      return res.status(409).json({
        error: `Valeur utilisée par ${produits.length} produit(s) — la retirer d'abord de ces produits.`,
        produits,
      });
    }
    await prisma.characteristicValue.delete({ where: { id: req.params.valueId } });
    return res.json({ message: "Valeur supprimée" });
  } catch (err) {
    logger.error("Erreur deleteValue", { err: err.message });
    return res.status(400).json({ error: "Suppression impossible" });
  }
}

module.exports = {
  listCharacteristics,
  createCharacteristic,
  updateCharacteristic,
  deleteCharacteristic,
  addValue,
  updateValue,
  deleteValue,
};
