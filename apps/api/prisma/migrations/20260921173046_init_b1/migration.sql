-- CreateEnum
CREATE TYPE "Role" AS ENUM ('INVESTIGATOR', 'SUPERVISOR', 'ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'TRACING', 'ATTRIBUTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TraceStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "TaintModel" AS ENUM ('HAIRCUT', 'FIFO');

-- CreateEnum
CREATE TYPE "VaspType" AS ENUM ('CENTRALISED_EXCHANGE', 'INSTANT_SWAP', 'OTC', 'P2P');

-- CreateEnum
CREATE TYPE "VaspAddressKind" AS ENUM ('HOT_WALLET', 'DEPOSIT');

-- CreateEnum
CREATE TYPE "RiskBand" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertRule" AS ENUM ('A1_MOVEMENT', 'A2_VASP_LANDING', 'A3_OBFUSCATION', 'A4_LINKAGE', 'A5_BLACKLIST');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'SNOOZED');

-- CreateEnum
CREATE TYPE "WatchTier" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "NoticeStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL,
    "ackNo" TEXT NOT NULL,
    "reportedAt" TIMESTAMPTZ(3) NOT NULL,
    "category" TEXT NOT NULL,
    "amountInr" DECIMAL(20,2) NOT NULL,
    "network" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caseId" TEXT,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplaintAddress" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT,

    CONSTRAINT "ComplaintAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "firNumber" TEXT,
    "ownerId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraceJob" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "seedChain" TEXT NOT NULL,
    "seedAddr" TEXT NOT NULL,
    "status" "TraceStatus" NOT NULL DEFAULT 'QUEUED',
    "taintModel" "TaintModel" NOT NULL DEFAULT 'HAIRCUT',
    "maxHops" INTEGER NOT NULL DEFAULT 6,
    "minValueUsd" DECIMAL(20,6) NOT NULL DEFAULT 10,
    "windowDays" INTEGER NOT NULL DEFAULT 30,
    "reportedAmount" DECIMAL(38,18) NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TraceJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hop" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "hopNo" INTEGER NOT NULL,
    "chain" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "idx" INTEGER NOT NULL DEFAULT 0,
    "fromAddr" TEXT NOT NULL,
    "toAddr" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "usd" DECIMAL(20,6),
    "ts" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Hop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddressProfile" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3),
    "activator" TEXT,
    "publicTag" TEXT,
    "flags" JSONB,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddressProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Label" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vaspId" TEXT,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vasp" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "VaspType" NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "fiuStatus" TEXT NOT NULL,
    "fiuStatusDate" TIMESTAMPTZ(3),
    "fiuSource" TEXT,
    "contactEmail" TEXT,
    "contactPortal" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vasp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VaspAddress" (
    "id" TEXT NOT NULL,
    "vaspId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "kind" "VaspAddressKind" NOT NULL DEFAULT 'HOT_WALLET',
    "source" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,

    CONSTRAINT "VaspAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskScore" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "band" "RiskBand" NOT NULL,
    "factors" JSONB NOT NULL,
    "overrides" TEXT[],
    "typology" TEXT,
    "typologyConfidence" DECIMAL(4,3),
    "modelVersion" TEXT NOT NULL,
    "traceId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "rule" "AlertRule" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'NEW',
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "amount" DECIMAL(38,18),
    "message" TEXT NOT NULL,
    "hopId" TEXT,
    "assigneeId" TEXT,
    "snoozedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "tier" "WatchTier" NOT NULL DEFAULT 'HOT',
    "addedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'evidence.v1',
    "sha256" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "pdfPath" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreezeNotice" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "vaspId" TEXT NOT NULL,
    "status" "NoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "legalProvision" TEXT,
    "legalCellReviewed" BOOLEAN NOT NULL DEFAULT false,
    "body" JSONB NOT NULL,
    "submissionId" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreezeNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "meta" JSONB,
    "prevHash" TEXT,
    "hash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_ackNo_key" ON "Complaint"("ackNo");

-- CreateIndex
CREATE INDEX "Complaint_caseId_idx" ON "Complaint"("caseId");

-- CreateIndex
CREATE INDEX "Complaint_reportedAt_idx" ON "Complaint"("reportedAt");

-- CreateIndex
CREATE INDEX "ComplaintAddress_chain_address_idx" ON "ComplaintAddress"("chain", "address");

-- CreateIndex
CREATE UNIQUE INDEX "ComplaintAddress_complaintId_address_key" ON "ComplaintAddress"("complaintId", "address");

-- CreateIndex
CREATE INDEX "Case_status_idx" ON "Case"("status");

-- CreateIndex
CREATE INDEX "Case_ownerId_idx" ON "Case"("ownerId");

-- CreateIndex
CREATE INDEX "TraceJob_caseId_idx" ON "TraceJob"("caseId");

-- CreateIndex
CREATE INDEX "TraceJob_status_idx" ON "TraceJob"("status");

-- CreateIndex
CREATE INDEX "Hop_traceId_hopNo_idx" ON "Hop"("traceId", "hopNo");

-- CreateIndex
CREATE INDEX "Hop_fromAddr_idx" ON "Hop"("fromAddr");

-- CreateIndex
CREATE INDEX "Hop_toAddr_idx" ON "Hop"("toAddr");

-- CreateIndex
CREATE INDEX "Hop_txHash_idx" ON "Hop"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "Hop_traceId_txHash_fromAddr_toAddr_key" ON "Hop"("traceId", "txHash", "fromAddr", "toAddr");

-- CreateIndex
CREATE UNIQUE INDEX "AddressProfile_chain_addr_key" ON "AddressProfile"("chain", "addr");

-- CreateIndex
CREATE INDEX "Label_chain_addr_idx" ON "Label"("chain", "addr");

-- CreateIndex
CREATE INDEX "Label_vaspId_idx" ON "Label"("vaspId");

-- CreateIndex
CREATE UNIQUE INDEX "Label_chain_addr_source_name_key" ON "Label"("chain", "addr", "source", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Vasp_name_key" ON "Vasp"("name");

-- CreateIndex
CREATE INDEX "VaspAddress_vaspId_idx" ON "VaspAddress"("vaspId");

-- CreateIndex
CREATE UNIQUE INDEX "VaspAddress_chain_addr_key" ON "VaspAddress"("chain", "addr");

-- CreateIndex
CREATE INDEX "RiskScore_chain_addr_createdAt_idx" ON "RiskScore"("chain", "addr", "createdAt");

-- CreateIndex
CREATE INDEX "RiskScore_traceId_idx" ON "RiskScore"("traceId");

-- CreateIndex
CREATE INDEX "Alert_caseId_createdAt_idx" ON "Alert"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_status_severity_idx" ON "Alert"("status", "severity");

-- CreateIndex
CREATE INDEX "Alert_chain_address_idx" ON "Alert"("chain", "address");

-- CreateIndex
CREATE INDEX "WatchlistItem_chain_addr_idx" ON "WatchlistItem"("chain", "addr");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_caseId_chain_addr_key" ON "WatchlistItem"("caseId", "chain", "addr");

-- CreateIndex
CREATE INDEX "Report_caseId_idx" ON "Report"("caseId");

-- CreateIndex
CREATE INDEX "Report_sha256_idx" ON "Report"("sha256");

-- CreateIndex
CREATE INDEX "FreezeNotice_caseId_idx" ON "FreezeNotice"("caseId");

-- CreateIndex
CREATE INDEX "FreezeNotice_vaspId_idx" ON "FreezeNotice"("vaspId");

-- CreateIndex
CREATE INDEX "FreezeNotice_status_idx" ON "FreezeNotice"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_seq_key" ON "AuditLog"("seq");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplaintAddress" ADD CONSTRAINT "ComplaintAddress_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceJob" ADD CONSTRAINT "TraceJob_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hop" ADD CONSTRAINT "Hop_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "TraceJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_vaspId_fkey" FOREIGN KEY ("vaspId") REFERENCES "Vasp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaspAddress" ADD CONSTRAINT "VaspAddress_vaspId_fkey" FOREIGN KEY ("vaspId") REFERENCES "Vasp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskScore" ADD CONSTRAINT "RiskScore_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "TraceJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_hopId_fkey" FOREIGN KEY ("hopId") REFERENCES "Hop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreezeNotice" ADD CONSTRAINT "FreezeNotice_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreezeNotice" ADD CONSTRAINT "FreezeNotice_vaspId_fkey" FOREIGN KEY ("vaspId") REFERENCES "Vasp"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreezeNotice" ADD CONSTRAINT "FreezeNotice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreezeNotice" ADD CONSTRAINT "FreezeNotice_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
