-- Add selectable link stock modes while preserving Apple Music's grouped accounts.
ALTER TABLE "SubscriptionPlan"
  ADD COLUMN "linkAccessMode" TEXT NOT NULL DEFAULT 'single';

UPDATE "SubscriptionPlan" AS plan
SET "linkAccessMode" = 'account_slots'
FROM "SubscriptionService" AS service
WHERE plan."serviceId" = service."id"
  AND (service."slug" = 'apple-music' OR lower(service."name") = 'apple music');
