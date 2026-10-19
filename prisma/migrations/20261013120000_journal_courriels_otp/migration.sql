-- Refonte du bot OTP (13/10/2026) : journal des mails traites, et garde
-- d'unicite sur le Message-ID. Table nouvelle, aucune donnee existante touchee.
CREATE TABLE "OtpCourriel" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "boite" TEXT NOT NULL,
    "adresseEcrite" TEXT,
    "expediteur" TEXT,
    "sujet" TEXT,
    "service" TEXT,
    "type" TEXT NOT NULL,
    "code" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'en-cours',
    "raison" TEXT,
    "destinataire" TEXT,
    "commandeId" TEXT,
    "recuLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCourriel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OtpCourriel_messageId_key" ON "OtpCourriel"("messageId");
CREATE INDEX "OtpCourriel_createdAt_idx" ON "OtpCourriel"("createdAt");
