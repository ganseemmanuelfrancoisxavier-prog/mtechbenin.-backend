-- Photos jointes à un avis client (jusqu'à 3 URLs Cloudinary).
-- Colonne nullable : les avis existants restent valides, aucune reprise de
-- données nécessaire.
-- AlterTable
ALTER TABLE "Review" ADD COLUMN "photos" JSONB;
