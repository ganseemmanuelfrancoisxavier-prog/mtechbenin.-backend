-- Avantages d'une formule d'abonnement, une entrée par puce affichée au client.
-- Additif et sans reprise : les formules existantes démarrent avec une liste
-- vide, ce qui reproduit exactement le comportement actuel (aucune ligne
-- affichée sous le nom de la formule).
ALTER TABLE "SubscriptionPlan"
  ADD COLUMN "description" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
