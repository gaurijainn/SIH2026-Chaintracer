-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "metadata" JSONB;

-- CreateTable
CREATE TABLE "MonitorCheckpoint" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastCursor" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MonitorCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonitorCheckpoint_chain_addr_key" ON "MonitorCheckpoint"("chain", "addr");
