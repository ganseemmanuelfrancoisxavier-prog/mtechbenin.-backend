-- Service de réparation d'appareils.
--
-- Écrite à la main comme les précédentes : `prisma migrate dev` exigerait une
-- connexion à la base de PRODUCTION depuis un poste de développement, plus une
-- base fantôme. `migrate deploy` l'applique au démarrage du conteneur.
--
-- Purement additive : aucune table existante n'est réécrite, la seule colonne
-- ajoutée hors des nouvelles tables est `Payment.repairOrderId`, nullable.

CREATE TYPE "RepairSpace"  AS ENUM ('ANDROID', 'APPLE', 'PC');
CREATE TYPE "RepairKind"   AS ENUM ('REPARATION', 'DIAGNOSTIC');
CREATE TYPE "RepairStatus" AS ENUM (
  'EN_ATTENTE', 'PAYEE', 'A_RECUPERER', 'RECUPEREE',
  'EN_ATELIER', 'REPAREE', 'A_RENDRE', 'RENDUE', 'ANNULEE'
);

CREATE TABLE "RepairFamily" (
  "id"        TEXT NOT NULL,
  "space"     "RepairSpace" NOT NULL,
  "name"      TEXT NOT NULL,
  "slug"      TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepairFamily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RepairFamily_slug_key" ON "RepairFamily"("slug");
CREATE INDEX "RepairFamily_space_active_idx" ON "RepairFamily"("space", "active");

CREATE TABLE "RepairModel" (
  "id"        TEXT NOT NULL,
  "familyId"  TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "slug"      TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepairModel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RepairModel_slug_key" ON "RepairModel"("slug");
CREATE INDEX "RepairModel_familyId_active_idx" ON "RepairModel"("familyId", "active");
ALTER TABLE "RepairModel" ADD CONSTRAINT "RepairModel_familyId_fkey"
  FOREIGN KEY ("familyId") REFERENCES "RepairFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RepairJob" (
  "id"        TEXT NOT NULL,
  "modelId"   TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "delay"     TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepairJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RepairJob_modelId_active_idx" ON "RepairJob"("modelId", "active");
ALTER TABLE "RepairJob" ADD CONSTRAINT "RepairJob_modelId_fkey"
  FOREIGN KEY ("modelId") REFERENCES "RepairModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RepairOption" (
  "id"        TEXT NOT NULL,
  "jobId"     TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  "price"     INTEGER NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepairOption_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RepairOption_jobId_active_idx" ON "RepairOption"("jobId", "active");
ALTER TABLE "RepairOption" ADD CONSTRAINT "RepairOption_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "RepairJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RepairOrder" (
  "id"                 TEXT NOT NULL,
  "reference"          TEXT NOT NULL,
  "kind"               "RepairKind" NOT NULL DEFAULT 'REPARATION',
  "parentId"           TEXT,
  "clientName"         TEXT NOT NULL,
  "clientWhatsapp"     TEXT NOT NULL,
  "clientEmail"        TEXT,
  "space"              "RepairSpace" NOT NULL,
  "familyName"         TEXT NOT NULL,
  "modelName"          TEXT NOT NULL,
  "problemDescription" TEXT,
  "city"               TEXT,
  "neighborhood"       TEXT,
  "instructions"       TEXT,
  "pickupSlot"         TEXT,
  "pickupLat"          DOUBLE PRECISION,
  "pickupLng"          DOUBLE PRECISION,
  "zoneName"           TEXT,
  "subtotal"           INTEGER NOT NULL DEFAULT 0,
  "discount"           INTEGER NOT NULL DEFAULT 0,
  "pickupFee"          INTEGER NOT NULL DEFAULT 0,
  "feeAmount"          INTEGER NOT NULL DEFAULT 0,
  "total"              INTEGER NOT NULL,
  "couponCode"         TEXT,
  "status"             "RepairStatus" NOT NULL DEFAULT 'EN_ATTENTE',
  "returnDate"         TIMESTAMP(3),
  "cancelledRetained"  INTEGER,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RepairOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RepairOrder_reference_key" ON "RepairOrder"("reference");
CREATE INDEX "RepairOrder_status_idx"         ON "RepairOrder"("status");
CREATE INDEX "RepairOrder_clientWhatsapp_idx" ON "RepairOrder"("clientWhatsapp");
CREATE INDEX "RepairOrder_createdAt_idx"      ON "RepairOrder"("createdAt");
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "RepairOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_couponCode_fkey"
  FOREIGN KEY ("couponCode") REFERENCES "Coupon"("code") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RepairOrderItem" (
  "id"            TEXT NOT NULL,
  "orderId"       TEXT NOT NULL,
  "jobName"       TEXT NOT NULL,
  "optionLabel"   TEXT NOT NULL,
  "unitPrice"     INTEGER NOT NULL,
  "delay"         TEXT,
  "jobId"         TEXT,
  "optionId"      TEXT,
  "horsCatalogue" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "RepairOrderItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RepairOrderItem_orderId_idx" ON "RepairOrderItem"("orderId");
ALTER TABLE "RepairOrderItem" ADD CONSTRAINT "RepairOrderItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "RepairOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Troisième rattachement possible d'un paiement, à côté de `orderId` et
-- `subOrderId`. Nullable : les paiements existants ne bougent pas.
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "repairOrderId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_repairOrderId_key" ON "Payment"("repairOrderId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_repairOrderId_fkey"
  FOREIGN KEY ("repairOrderId") REFERENCES "RepairOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
