-- Étape 1 du partage de profils Family.
--
-- Strictement additive : deux tables créées, deux colonnes ajoutées, aucune
-- colonne existante touchée. `FamilyAccount.email`, `passwordEncrypted`,
-- `planId`, `currentOrderId` et `status` restent en place et continuent d'être
-- écrits — leur suppression fait l'objet d'une migration ultérieure, après
-- vérification en production.

-- Le compte streaming physique. Il n'existait pas : chaque profil recopiait
-- l'adresse et le mot de passe, ce qui rendait impossible tout plafond au
-- niveau du compte.
CREATE TABLE "StreamingAccount" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "maxFluxSimultanes" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreamingAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StreamingAccount_serviceId_email_key"
  ON "StreamingAccount"("serviceId", "email");

ALTER TABLE "StreamingAccount"
  ADD CONSTRAINT "StreamingAccount_serviceId_fkey"
  FOREIGN KEY ("serviceId") REFERENCES "SubscriptionService"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- `accountId` est nullable pendant toute l'étape 1 : la recopie le remplit,
-- et il ne deviendra obligatoire qu'à la migration destructive.
ALTER TABLE "FamilyAccount" ADD COLUMN "accountId" TEXT;
ALTER TABLE "FamilyAccount" ADD COLUMN "capacite" INTEGER NOT NULL DEFAULT 1;

-- `planId` devient facultatif. Un profil appartient désormais à un compte, et
-- un compte à un service : la formule (la durée) est une propriété de l'achat,
-- pas du profil. La colonne reste en place pour ne rien casser, mais les
-- profils créés à partir de maintenant n'en portent plus. Relâcher une
-- contrainte ne détruit aucune donnée et reste réversible.
ALTER TABLE "FamilyAccount" ALTER COLUMN "planId" DROP NOT NULL;

ALTER TABLE "FamilyAccount"
  ADD CONSTRAINT "FamilyAccount_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "StreamingAccount"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "FamilyAccount_accountId_idx" ON "FamilyAccount"("accountId");

-- Une occupation = une personne dans un profil, sur une période. Jamais
-- supprimée : c'est elle qui porte l'historique.
CREATE TABLE "ProfileOccupancy" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "occupantName" TEXT NOT NULL,
    "occupantWhatsapp" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileOccupancy_pkey" PRIMARY KEY ("id")
);

-- Une commande n'occupe qu'une seule place ACTIVE — règle déjà appliquée
-- aujourd'hui par setFamilyAccountClient, ici garantie par la base.
--
-- L'unicité est partielle et non pleine : déplacer un client d'un profil à
-- l'autre clôt son occupation et en ouvre une nouvelle sur la même commande.
-- Une unicité pleine interdirait ce déplacement, ou obligerait à effacer le
-- séjour précédent — c'est-à-dire à mentir sur l'historique.
CREATE UNIQUE INDEX "ProfileOccupancy_orderId_active_key"
  ON "ProfileOccupancy"("orderId") WHERE "releasedAt" IS NULL;

CREATE INDEX "ProfileOccupancy_orderId_idx" ON "ProfileOccupancy"("orderId");

-- Sert la question posée à chaque attribution et à chaque code reçu :
-- « qui occupe ce profil en ce moment ? »
CREATE INDEX "ProfileOccupancy_profileId_releasedAt_idx"
  ON "ProfileOccupancy"("profileId", "releasedAt");

ALTER TABLE "ProfileOccupancy"
  ADD CONSTRAINT "ProfileOccupancy_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "FamilyAccount"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProfileOccupancy"
  ADD CONSTRAINT "ProfileOccupancy_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "SubscriptionOrder"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
