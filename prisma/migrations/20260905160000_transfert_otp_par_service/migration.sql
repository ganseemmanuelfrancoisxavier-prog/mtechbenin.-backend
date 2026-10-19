-- Interrupteur de transfert des codes OTP, par service.
--
-- Ecrite a la main comme les precedentes : `migrate deploy` l'applique au
-- demarrage du conteneur.
--
-- `DEFAULT true` : tous les services existants continuent exactement comme
-- avant. Un defaut a `false` aurait coupe Netflix en silence a la migration,
-- et l'incident aurait ete l'inverse de celui qu'on corrige.
ALTER TABLE "SubscriptionService"
  ADD COLUMN IF NOT EXISTS "transfertOtp" BOOLEAN NOT NULL DEFAULT true;
