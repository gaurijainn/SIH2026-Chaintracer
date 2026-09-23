import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../audit/service';
import { FIR_PII_CONTEXT, type PiiCipher } from '../auth/pii';
import { CaseNotFoundError } from './errors';

export interface CaseServiceDeps {
  prisma: PrismaClient;
  audit: AuditService;
  pii?: PiiCipher;
}

/**
 * Case detail read. Every call is recorded in the hash-chained audit log with the authenticated actor
 * (B10: "audit every case view"), so the log doubles as chain of custody for who looked at which case.
 */
export class CaseService {
  constructor(private readonly deps: CaseServiceDeps) {}

  async view(caseId: string, actorId: string) {
    const kase = await this.deps.prisma.case.findUnique({
      where: { id: caseId },
      include: {
        owner: { select: { id: true, name: true } },
        complaints: { include: { addresses: true }, orderBy: { reportedAt: 'asc' } },
        traces: { select: { id: true, status: true, seedChain: true, seedAddr: true, createdAt: true, finishedAt: true }, orderBy: { createdAt: 'asc' } },
        _count: { select: { alerts: true, watchlistItems: true, reports: true, freezeNotices: true } },
      },
    });
    if (!kase) throw new CaseNotFoundError(caseId);

    await this.deps.audit.record({ actorId, action: 'case viewed', entity: 'Case', entityId: caseId });

    return {
      ...kase,
      firNumber: this.deps.pii ? this.deps.pii.decryptNullable(kase.firNumber, FIR_PII_CONTEXT) : kase.firNumber,
      complaints: kase.complaints.map((c) => ({ ...c, amountInr: c.amountInr.toString() })),
    };
  }
}
