-- Add grouped Apple Music invitation links with five reusable slots per account.
CREATE TABLE "LinkAccessAccount" (
  "id" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LinkAccessAccount_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LinkAccessLink"
  ADD COLUMN "accountId" TEXT,
  ADD COLUMN "slotNumber" INTEGER;

CREATE UNIQUE INDEX "LinkAccessAccount_planId_email_key"
  ON "LinkAccessAccount"("planId", "email");
CREATE INDEX "LinkAccessAccount_planId_idx"
  ON "LinkAccessAccount"("planId");
CREATE UNIQUE INDEX "LinkAccessLink_accountId_slotNumber_key"
  ON "LinkAccessLink"("accountId", "slotNumber");
CREATE INDEX "LinkAccessLink_accountId_idx"
  ON "LinkAccessLink"("accountId");

ALTER TABLE "LinkAccessAccount"
  ADD CONSTRAINT "LinkAccessAccount_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LinkAccessLink"
  ADD CONSTRAINT "LinkAccessLink_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "LinkAccessAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "LinkAccessLink_account_slot_check"
  CHECK (("accountId" IS NULL AND "slotNumber" IS NULL) OR
         ("accountId" IS NOT NULL AND "slotNumber" BETWEEN 1 AND 5));
