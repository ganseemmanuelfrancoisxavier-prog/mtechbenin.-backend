ALTER TABLE "ClientTracker" ADD COLUMN "referralCode" TEXT;
CREATE UNIQUE INDEX "ClientTracker_referralCode_key" ON "ClientTracker"("referralCode");
ALTER TABLE "Order" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "SubscriptionOrder" ADD COLUMN "referralCode" TEXT;
CREATE TABLE "RewardEntry" (
  "id" TEXT NOT NULL,
  "clientWhatsapp" TEXT NOT NULL,
  "paymentId" TEXT,
  "withdrawalId" TEXT,
  "orderRef" TEXT,
  "type" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "details" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RewardEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RewardEntry_paymentId_clientWhatsapp_type_key" ON "RewardEntry"("paymentId", "clientWhatsapp", "type");
CREATE UNIQUE INDEX "RewardEntry_withdrawalId_type_key" ON "RewardEntry"("withdrawalId", "type");
CREATE INDEX "RewardEntry_clientWhatsapp_createdAt_idx" ON "RewardEntry"("clientWhatsapp", "createdAt");
ALTER TABLE "RewardEntry" ADD CONSTRAINT "RewardEntry_clientWhatsapp_fkey" FOREIGN KEY ("clientWhatsapp") REFERENCES "ClientTracker"("whatsapp") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "WithdrawalRequest" (
  "id" TEXT NOT NULL,
  "clientWhatsapp" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "payoutNumber" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "adminNote" TEXT,
  CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WithdrawalRequest_status_requestedAt_idx" ON "WithdrawalRequest"("status", "requestedAt");
CREATE INDEX "WithdrawalRequest_clientWhatsapp_requestedAt_idx" ON "WithdrawalRequest"("clientWhatsapp", "requestedAt");
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_clientWhatsapp_fkey" FOREIGN KEY ("clientWhatsapp") REFERENCES "ClientTracker"("whatsapp") ON DELETE CASCADE ON UPDATE CASCADE;
