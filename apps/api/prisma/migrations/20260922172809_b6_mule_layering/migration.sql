-- CreateEnum
CREATE TYPE "MuleRuleCode" AS ENUM ('PASS_THROUGH', 'FAN_OUT', 'PEEL_CHAIN', 'FRESH_WALLET', 'TRX_DUST_USDT');

-- CreateTable
CREATE TABLE "MuleFlag" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "rule" "MuleRuleCode" NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "evidence" JSONB NOT NULL,
    "traceId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MuleFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddressCommunity" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "wccId" INTEGER NOT NULL,
    "louvainId" INTEGER NOT NULL,
    "degree" DOUBLE PRECISION NOT NULL,
    "betweenness" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddressCommunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedMuleFlag" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "caseCount" INTEGER NOT NULL,
    "caseIds" TEXT[],
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SharedMuleFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MuleFlag_chain_addr_idx" ON "MuleFlag"("chain", "addr");

-- CreateIndex
CREATE INDEX "MuleFlag_traceId_idx" ON "MuleFlag"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "MuleFlag_chain_addr_rule_key" ON "MuleFlag"("chain", "addr", "rule");

-- CreateIndex
CREATE INDEX "AddressCommunity_caseId_wccId_idx" ON "AddressCommunity"("caseId", "wccId");

-- CreateIndex
CREATE INDEX "AddressCommunity_caseId_louvainId_idx" ON "AddressCommunity"("caseId", "louvainId");

-- CreateIndex
CREATE UNIQUE INDEX "AddressCommunity_caseId_chain_addr_key" ON "AddressCommunity"("caseId", "chain", "addr");

-- CreateIndex
CREATE UNIQUE INDEX "SharedMuleFlag_chain_addr_key" ON "SharedMuleFlag"("chain", "addr");

-- AddForeignKey
ALTER TABLE "MuleFlag" ADD CONSTRAINT "MuleFlag_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "TraceJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AddressCommunity" ADD CONSTRAINT "AddressCommunity_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
