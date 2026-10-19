-- Emplacements publicitaires de la page d'accueil.
-- Strictement additif : une table créée, aucune table existante touchée.
-- Elle démarre vide, donc la page d'accueil reste inchangée tant qu'aucune
-- annonce n'y est ajoutée.
CREATE TABLE "Advertisement" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'image',
    "url" TEXT NOT NULL,
    "advertiser" TEXT NOT NULL,
    "caption" TEXT,
    "href" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Advertisement_pkey" PRIMARY KEY ("id")
);

-- Sert la requête publique : les annonces actives, dans l'ordre d'affichage.
CREATE INDEX "Advertisement_active_order_idx" ON "Advertisement"("active", "order");
