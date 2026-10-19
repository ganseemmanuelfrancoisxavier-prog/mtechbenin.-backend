-- Capacite d'un profil, declaree au niveau de la FORMULE.
--
-- Ecrite a la main plutot que generee : `prisma migrate dev` aurait exige une
-- connexion a la base de PRODUCTION depuis un poste de developpement, et une
-- base fantome par-dessus. `migrate deploy` l'appliquera au demarrage.
--
-- `DEFAULT 1` : toute formule existante conserve le comportement d'avant, un
-- profil pour une personne. Aucune ligne n'est modifiee, la colonne est
-- simplement ajoutee — l'operation ne pose pas de verrou long sur Postgres 11+.
ALTER TABLE "SubscriptionPlan"
  ADD COLUMN IF NOT EXISTS "capaciteProfil" INTEGER NOT NULL DEFAULT 1;
