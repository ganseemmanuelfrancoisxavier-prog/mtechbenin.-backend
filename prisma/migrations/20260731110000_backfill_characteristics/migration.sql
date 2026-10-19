-- Une caractéristique par nom distinct déjà utilisé
INSERT INTO "Characteristic" ("id", "name", "createdAt")
SELECT gen_random_uuid()::text, t."name", CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "name" FROM "ProductVariantType") t
ON CONFLICT ("name") DO NOTHING;

-- Le vivier reçoit l'union des valeurs rencontrées pour ce nom
INSERT INTO "CharacteristicValue" ("id", "characteristicId", "value", "sortOrder", "createdAt")
SELECT DISTINCT gen_random_uuid()::text, c."id", o."value", 0, CURRENT_TIMESTAMP
FROM "ProductVariantOption" o
JOIN "ProductVariantType" t ON o."typeId" = t."id"
JOIN "Characteristic"     c ON c."name"   = t."name"
ON CONFLICT ("characteristicId", "value") DO NOTHING;

-- Rattachement des définitions produit
UPDATE "ProductVariantType" t
SET "characteristicId" = c."id"
FROM "Characteristic" c
WHERE c."name" = t."name" AND t."characteristicId" IS NULL;

UPDATE "ProductVariantOption" o
SET "valueId" = v."id"
FROM "CharacteristicValue" v, "ProductVariantType" t
WHERE o."typeId" = t."id"
  AND v."characteristicId" = t."characteristicId"
  AND v."value" = o."value"
  AND o."valueId" IS NULL;
