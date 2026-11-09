-- Keep the WhatsApp conversation that explicitly requested the OTP.
-- The subscription number is used only to verify active access.
ALTER TABLE "OtpRequest" ADD COLUMN "demandeurJid" TEXT;
