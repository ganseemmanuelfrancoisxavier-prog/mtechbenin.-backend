-- AlterTable
ALTER TABLE "FamilyAccount" ADD COLUMN     "currentOrderId" TEXT;

-- AlterTable
ALTER TABLE "SubscriptionOrder" ADD COLUMN     "giftName" TEXT,
ADD COLUMN     "giftWhatsapp" TEXT,
ADD COLUMN     "isGift" BOOLEAN NOT NULL DEFAULT false;
