-- AlterTable
ALTER TABLE "Label" ADD COLUMN     "evidence" JSONB;

-- CreateTable
CREATE TABLE "Attribution" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "vaspId" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "heuristics" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Attribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attribution_chain_addr_idx" ON "Attribution"("chain", "addr");

-- CreateIndex
CREATE UNIQUE INDEX "Attribution_chain_addr_vaspId_key" ON "Attribution"("chain", "addr", "vaspId");

-- AddForeignKey
ALTER TABLE "Attribution" ADD CONSTRAINT "Attribution_vaspId_fkey" FOREIGN KEY ("vaspId") REFERENCES "Vasp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
