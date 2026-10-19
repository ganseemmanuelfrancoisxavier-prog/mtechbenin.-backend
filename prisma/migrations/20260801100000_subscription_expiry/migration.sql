ALTER TABLE "SubscriptionOrder" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "SubscriptionOrder" ADD COLUMN "reminderSentAt" TIMESTAMP(3);

-- Sert la requête de la vérification périodique : les abonnements confirmés
-- qui expirent bientôt et n'ont pas encore été prévenus.
CREATE INDEX "SubscriptionOrder_expiresAt_idx" ON "SubscriptionOrder"("expiresAt");
