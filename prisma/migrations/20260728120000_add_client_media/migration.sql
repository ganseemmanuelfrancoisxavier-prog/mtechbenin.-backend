-- CreateTable
CREATE TABLE "ClientMedia" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'image',
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientMedia_active_order_idx" ON "ClientMedia"("active", "order");
