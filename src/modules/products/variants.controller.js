const prisma = require("../../services/prisma");
const logger = require("../../utils/logger");

// La colonne `priceDelta` est un entier 32 bits en base (Postgres `Int`).
// `Number.isInteger` seul laisse passer des valeurs hors de cette plage, qui
// échoueraient alors au niveau de Postgres — renvoyant un message technique
// brut (`err.message`, en anglais) au lieu d'un refus explicite en français.
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function validerPriceDelta(priceDelta) {
  const delta = Number(priceDelta);
  if (!Number.isInteger(delta)) {
    return { ok: false, error: "Le supplément doit être un nombre entier" };
  }
  if (delta < INT32_MIN || delta > INT32_MAX) {
    return { ok: false, error: "Le supplément dépasse la limite autorisée" };
  }
  return { ok: true, value: delta };
}

async function getVariants(req, res) {
  try {
    const variantTypes = await prisma.productVariantType.findMany({
      where: { productId: req.params.productId },
      include: { options: { orderBy: { sortOrder: "asc" } } },
      orderBy: { sortOrder: "asc" },
    });
    return res.json({ variantTypes });
  } catch (err) {
    logger.error("Erreur getVariants", { err: err.message });
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function createVariantType(req, res) {
  try {
    const { name, required = true, sortOrder = 0, characteristicId } = req.body;
    let libelle = (name || "").trim();

    // Rattachement à la bibliothèque : le nom est celui de la caractéristique,
    // pour que la fiche produit et les commandes restent lisibles telles quelles.
    if (characteristicId) {
      const c = await prisma.characteristic.findUnique({ where: { id: characteristicId } });
      if (!c) return res.status(400).json({ error: "Caractéristique introuvable" });

      // Un double rattachement (double-clic, formulaire renvoyé après une
      // réponse lente) créerait deux ProductVariantType pour la même
      // caractéristique — deux sélecteurs identiques sur la fiche produit,
      // sans moyen simple de savoir lequel retirer. Seules les
      // caractéristiques de bibliothèque sont concernées : deux types
      // propres au produit (characteristicId absent) restent légitimes.
      const dejaRattachee = await prisma.productVariantType.findFirst({
        where: { productId: req.params.productId, characteristicId },
      });
      if (dejaRattachee) {
        return res
          .status(409)
          .json({ error: "Cette caractéristique est déjà rattachée à ce produit" });
      }

      libelle = c.name;
    }
    if (!libelle) return res.status(400).json({ error: "Nom requis" });

    const variantType = await prisma.productVariantType.create({
      data: {
        productId: req.params.productId,
        name: libelle,
        required,
        sortOrder,
        characteristicId: characteristicId || null,
      },
      include: { options: { orderBy: { sortOrder: "asc" } } },
    });
    return res.status(201).json({ variantType });
  } catch (err) {
    logger.error("Erreur createVariantType", { err: err.message });
    return res.status(400).json({ error: "Création impossible" });
  }
}

async function updateVariantType(req, res) {
  try {
    const existant = await chargerTypeDuProduit(req.params.productId, req.params.typeId);
    if (!existant) {
      return res.status(400).json({ error: "Type de variante introuvable pour ce produit" });
    }

    const { name, required, sortOrder } = req.body;
    const variantType = await prisma.productVariantType.update({
      where: { id: req.params.typeId },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(required !== undefined && { required }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
      include: { options: { orderBy: { sortOrder: "asc" } } },
    });
    return res.json({ variantType });
  } catch (err) {
    logger.error("Erreur updateVariantType", { err: err.message });
    return res.status(400).json({ error: "Modification impossible" });
  }
}

async function deleteVariantType(req, res) {
  try {
    const existant = await chargerTypeDuProduit(req.params.productId, req.params.typeId);
    if (!existant) {
      return res.status(400).json({ error: "Type de variante introuvable pour ce produit" });
    }

    await prisma.productVariantType.delete({ where: { id: req.params.typeId } });
    return res.json({ message: "Type de variante supprimé" });
  } catch (err) {
    logger.error("Erreur deleteVariantType", { err: err.message });
    return res.status(400).json({ error: "Suppression impossible" });
  }
}

// Un `valueId` traverse une frontière de confiance : rien ne garantit côté
// client qu'il désigne bien une valeur de la caractéristique du type parent.
// Sans ce contrôle, on pourrait rattacher une valeur d'une autre
// caractéristique (ex. « 256 Go » de Stockage sous un type Couleur), ce qui
// rend la fiche produit incohérente et contourne la garde de suppression de
// la bibliothèque (`characteristics.controller.js`), qui suppose cette
// correspondance.
async function chargerTypeDuProduit(productId, typeId) {
  const type = await prisma.productVariantType.findUnique({ where: { id: typeId } });
  if (!type || type.productId !== productId) return null;
  return type;
}

async function chargerOptionDuProduit(productId, optionId) {
  const option = await prisma.productVariantOption.findUnique({
    where: { id: optionId },
    include: { variantType: true },
  });
  if (!option || option.variantType.productId !== productId) return null;
  return option;
}

async function createVariantOption(req, res) {
  try {
    const { value, sortOrder = 0, priceDelta = 0, valueId } = req.body;

    const type = await chargerTypeDuProduit(req.params.productId, req.params.typeId);
    if (!type) {
      return res.status(400).json({ error: "Type de variante introuvable pour ce produit" });
    }

    let libelle = (value || "").trim();

    if (valueId) {
      const v = await prisma.characteristicValue.findUnique({ where: { id: valueId } });
      if (!v) return res.status(400).json({ error: "Valeur introuvable" });
      if (v.characteristicId !== type.characteristicId) {
        return res
          .status(400)
          .json({ error: "Cette valeur n'appartient pas à la caractéristique de ce type" });
      }
      libelle = v.value;
    }
    if (!libelle) return res.status(400).json({ error: "Valeur requise" });

    const verifDelta = validerPriceDelta(priceDelta);
    if (!verifDelta.ok) return res.status(400).json({ error: verifDelta.error });

    const option = await prisma.productVariantOption.create({
      data: {
        typeId: req.params.typeId,
        value: libelle,
        sortOrder,
        priceDelta: verifDelta.value,
        valueId: valueId || null,
      },
    });
    return res.status(201).json({ option });
  } catch (err) {
    logger.error("Erreur createVariantOption", { err: err.message });
    return res.status(400).json({ error: "Création impossible" });
  }
}

async function updateVariantOption(req, res) {
  try {
    const { value, sortOrder, priceDelta, valueId } = req.body;

    const option = await chargerOptionDuProduit(req.params.productId, req.params.optionId);
    if (!option) {
      return res.status(400).json({ error: "Option introuvable pour ce produit" });
    }

    const data = {};
    if (value !== undefined) data.value = value.trim();
    if (sortOrder !== undefined) data.sortOrder = sortOrder;
    if (priceDelta !== undefined) {
      const verifDelta = validerPriceDelta(priceDelta);
      if (!verifDelta.ok) return res.status(400).json({ error: verifDelta.error });
      data.priceDelta = verifDelta.value;
    }
    if (valueId !== undefined) {
      if (valueId === null) {
        data.valueId = null;
      } else {
        const v = await prisma.characteristicValue.findUnique({ where: { id: valueId } });
        if (!v) return res.status(400).json({ error: "Valeur introuvable" });
        if (v.characteristicId !== option.variantType.characteristicId) {
          return res
            .status(400)
            .json({ error: "Cette valeur n'appartient pas à la caractéristique de ce type" });
        }
        data.valueId = valueId;
        if (value === undefined) data.value = v.value;
      }
    }

    const updated = await prisma.productVariantOption.update({
      where: { id: req.params.optionId },
      data,
    });
    return res.json({ option: updated });
  } catch (err) {
    logger.error("Erreur updateVariantOption", { err: err.message });
    return res.status(400).json({ error: "Modification impossible" });
  }
}

async function deleteVariantOption(req, res) {
  try {
    const option = await chargerOptionDuProduit(req.params.productId, req.params.optionId);
    if (!option) {
      return res.status(400).json({ error: "Option introuvable pour ce produit" });
    }
    await prisma.productVariantOption.delete({ where: { id: req.params.optionId } });
    return res.json({ message: "Option supprimée" });
  } catch (err) {
    logger.error("Erreur deleteVariantOption", { err: err.message });
    return res.status(400).json({ error: "Suppression impossible" });
  }
}

// Rattache une caractéristique de bibliothèque à un produit avec les valeurs
// retenues, en une seule opération. Évite au panel d'enchaîner une requête par
// valeur, et garantit qu'un rattachement partiel ne reste pas en base.
//
// Aucun contrôle d'appartenance supplémentaire n'est nécessaire ici : les
// valeurs retenues (`retenues`) sont filtrées depuis `c.values`, donc déjà
// garanties de partager `characteristicId === c.id`, la même caractéristique
// que celle du type créé.
async function attachFromLibrary(req, res) {
  try {
    const { characteristicId, required = true, valueIds = [] } = req.body;
    const c = await prisma.characteristic.findUnique({
      where: { id: characteristicId },
      include: { values: true },
    });
    if (!c) return res.status(400).json({ error: "Caractéristique introuvable" });

    // Voir le commentaire équivalent dans `createVariantType` : un double
    // rattachement (double-clic, renvoi de formulaire) créerait deux
    // sélecteurs identiques sur la fiche produit.
    const dejaRattachee = await prisma.productVariantType.findFirst({
      where: { productId: req.params.productId, characteristicId: c.id },
    });
    if (dejaRattachee) {
      return res
        .status(409)
        .json({ error: "Cette caractéristique est déjà rattachée à ce produit" });
    }

    const retenues = c.values.filter((v) => valueIds.includes(v.id));
    if (retenues.length === 0) {
      return res.status(400).json({ error: "Choisir au moins une valeur" });
    }

    const dernier = await prisma.productVariantType.findFirst({
      where: { productId: req.params.productId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    const variantType = await prisma.productVariantType.create({
      data: {
        productId: req.params.productId,
        name: c.name,
        required,
        sortOrder: (dernier?.sortOrder ?? -1) + 1,
        characteristicId: c.id,
        options: {
          create: retenues.map((v, i) => ({
            value: v.value,
            valueId: v.id,
            sortOrder: i,
            priceDelta: 0,
          })),
        },
      },
      include: { options: { orderBy: { sortOrder: "asc" } } },
    });
    return res.status(201).json({ variantType });
  } catch (err) {
    logger.error("Erreur attachFromLibrary", { err: err.message });
    return res.status(400).json({ error: "Rattachement impossible" });
  }
}

module.exports = {
  getVariants,
  createVariantType,
  updateVariantType,
  deleteVariantType,
  createVariantOption,
  updateVariantOption,
  deleteVariantOption,
  attachFromLibrary,
};
