-- Relie prudemment les anciennes fiches client aux commandes confirmées du
-- même forfait et du même numéro, créées dans une fenêtre d'un jour.
-- Les cas ambigus sont laissés sans association et restent supprimables à la main.
WITH candidats AS (
  SELECT
    client.id AS client_id,
    commande.id AS order_id,
    COUNT(*) OVER (PARTITION BY client.id) AS nombre_commandes
  FROM "LinkAccessClient" AS client
  JOIN "SubscriptionOrder" AS commande
    ON commande."planId" = client."planId"
   AND commande."clientWhatsapp" = client.whatsapp
   AND commande.status = 'CONFIRMED'
   AND commande."createdAt" BETWEEN client."paidAt" - INTERVAL '24 hours'
                                AND client."paidAt" + INTERVAL '24 hours'
  WHERE client."subscriptionOrderId" IS NULL
),
correspondances_uniques AS (
  SELECT client_id, order_id
  FROM candidats
  WHERE nombre_commandes = 1
)
UPDATE "LinkAccessClient" AS client
SET "subscriptionOrderId" = correspondance.order_id
FROM correspondances_uniques AS correspondance
WHERE client.id = correspondance.client_id;

-- Les envois manuels plus anciens n'enregistraient pas la commande sur le lien.
-- Rattache les liens déjà envoyés à la fiche client maintenant reliée à la commande.
UPDATE "LinkAccessLink" AS lien
SET "currentOrderId" = client."subscriptionOrderId"
FROM "LinkAccessClient" AS client
WHERE lien."planId" = client."planId"
  AND lien.link = client.link
  AND lien.status = 'envoyé'
  AND lien."currentOrderId" IS NULL
  AND client.status = 'envoyé'
  AND client."subscriptionOrderId" IS NOT NULL;
