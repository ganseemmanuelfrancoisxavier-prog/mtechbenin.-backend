-- Bibliothèque de caractéristiques
CREATE TABLE "Characteristic" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Characteristic_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Characteristic_name_key" ON "Characteristic"("name");

CREATE TABLE "CharacteristicValue" (
    "id" TEXT NOT NULL,
    "characteristicId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CharacteristicValue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CharacteristicValue_characteristicId_value_key"
    ON "CharacteristicValue"("characteristicId", "value");
CREATE INDEX "CharacteristicValue_characteristicId_idx"
    ON "CharacteristicValue"("characteristicId");

ALTER TABLE "CharacteristicValue" ADD CONSTRAINT "CharacteristicValue_characteristicId_fkey"
    FOREIGN KEY ("characteristicId") REFERENCES "Characteristic"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Rattachement des tables existantes à la bibliothèque
ALTER TABLE "ProductVariantType"   ADD COLUMN "characteristicId" TEXT;
ALTER TABLE "ProductVariantOption" ADD COLUMN "valueId" TEXT;
ALTER TABLE "ProductVariantOption" ADD COLUMN "priceDelta" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ProductVariantType" ADD CONSTRAINT "ProductVariantType_characteristicId_fkey"
    FOREIGN KEY ("characteristicId") REFERENCES "Characteristic"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ProductVariantOption" ADD CONSTRAINT "ProductVariantOption_valueId_fkey"
    FOREIGN KEY ("valueId") REFERENCES "CharacteristicValue"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ProductVariantType_characteristicId_idx"   ON "ProductVariantType"("characteristicId");
CREATE INDEX "ProductVariantOption_valueId_idx"          ON "ProductVariantOption"("valueId");
