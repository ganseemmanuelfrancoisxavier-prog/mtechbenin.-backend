ALTER TABLE "LinkAccessClient" ADD COLUMN "subscriptionOrderId" TEXT;
CREATE INDEX "LinkAccessClient_subscriptionOrderId_idx" ON "LinkAccessClient"("subscriptionOrderId");
