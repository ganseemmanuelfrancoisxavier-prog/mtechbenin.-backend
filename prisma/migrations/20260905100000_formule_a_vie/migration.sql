-- Formule d'abonnement sans echeance (« a vie »).
--
-- Ecrite a la main plutot que generee, comme les precedentes : `prisma migrate
-- dev` exigerait une connexion a la base de PRODUCTION depuis un poste de
-- developpement, plus une base fantome. `migrate deploy` l'applique au
-- demarrage du conteneur.
--
-- `DEFAULT false` : toute formule existante garde exactement le comportement
-- d'avant. Aucune ligne n'est reecrite, la colonne est seulement ajoutee — sur
-- PostgreSQL 11+ l'operation ne pose pas de verrou long.
ALTER TABLE "SubscriptionPlan"
  ADD COLUMN IF NOT EXISTS "aVie" BOOLEAN NOT NULL DEFAULT false;
