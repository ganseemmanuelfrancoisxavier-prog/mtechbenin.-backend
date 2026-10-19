-- Réserve de liens pour les abonnements link_access.
-- Strictement additif : une table créée, aucune colonne existante touchée.
-- La table démarre vide, donc le comportement actuel reste inchangé tant que
-- l'administrateur n'y dépose pas de lien.
CREATE TABLE "LinkAccessLink" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'disponible',
    "currentOrderId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkAccessLink_pkey" PRIMARY KEY ("id")
);

-- Sert la requête de réservation : les liens disponibles d'une formule.
CREATE INDEX "LinkAccessLink_planId_status_idx" ON "LinkAccessLink"("planId", "status");

ALTER TABLE "LinkAccessLink"
  ADD CONSTRAINT "LinkAccessLink_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
