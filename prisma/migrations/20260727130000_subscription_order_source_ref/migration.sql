-- Rattache une SubscriptionOrder à la commande panier (Order.reference) qui
-- l'a générée. Colonne nullable : les lignes existantes restent valides.
-- L'index unique (sourceOrderRef, planId) rend la réconciliation idempotente —
-- Postgres considérant les NULL comme distincts, l'historique n'entre pas en
-- conflit.
-- AlterTable
ALTER TABLE "SubscriptionOrder" ADD COLUMN "sourceOrderRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionOrder_sourceOrderRef_planId_key" ON "SubscriptionOrder"("sourceOrderRef", "planId");
