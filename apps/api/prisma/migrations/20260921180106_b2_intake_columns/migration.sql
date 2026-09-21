-- CreateEnum
CREATE TYPE "ComplaintEntryKind" AS ENUM ('ADDRESS', 'TX_HASH');

-- AlterTable
ALTER TABLE "Complaint" ADD COLUMN     "tokenContract" TEXT;

-- AlterTable
ALTER TABLE "ComplaintAddress" ADD COLUMN     "candidateChains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "kind" "ComplaintEntryKind" NOT NULL DEFAULT 'ADDRESS';

-- AlterTable
ALTER TABLE "TraceJob" ALTER COLUMN "reportedAmount" DROP NOT NULL;
