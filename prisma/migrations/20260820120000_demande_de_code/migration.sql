-- Étape 2 du partage de profils : la demande de code en libre-service.
--
-- Strictement additive : une table créée, aucune colonne existante touchée.
-- La table démarre vide, donc le routage OTP garde exactement le comportement
-- de l'étape 1 tant qu'aucun client n'a formulé de demande.

-- Une demande = un occupant qui annonce attendre un code, sur un compte donné,
-- pendant une fenêtre courte. Elle n'est jamais supprimée : `servedAt` la clôt
-- et le journal permet de trancher un litige.
CREATE TABLE "OtpRequest" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "occupancyId" TEXT NOT NULL,
    "canal" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "servedAt" TIMESTAMP(3),
    "otpLogId" TEXT,

    CONSTRAINT "OtpRequest_pkey" PRIMARY KEY ("id")
);

-- Sert la question posée à chaque code reçu : « quelqu'un attend-il un code
-- sur ce compte en ce moment ? »
CREATE INDEX "OtpRequest_accountId_servedAt_idx"
  ON "OtpRequest"("accountId", "servedAt");

-- Sert la règle « une demande ouverte par occupation » et le journal.
CREATE INDEX "OtpRequest_occupancyId_idx" ON "OtpRequest"("occupancyId");

ALTER TABLE "OtpRequest"
  ADD CONSTRAINT "OtpRequest_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "StreamingAccount"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OtpRequest"
  ADD CONSTRAINT "OtpRequest_occupancyId_fkey"
  FOREIGN KEY ("occupancyId") REFERENCES "ProfileOccupancy"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
