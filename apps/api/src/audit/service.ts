import type { Prisma, PrismaClient } from '@prisma/client';
import { canonicalize, sha256Hex } from '@ps26183/shared';

/** Arbitrary constant key for the Postgres advisory lock that serialises audit-chain appends. */
const AUDIT_CHAIN_LOCK = 26183001;

export interface RecordAuditInput {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface VerifyChainResult {
  valid: boolean;
  /** First entry (by seq) whose stored hash does not match the recomputed one, if any. */
  brokenAt?: { seq: number; id: string; expectedHash: string; actualHash: string | null };
}

export interface AuditServiceDeps {
  prisma: PrismaClient;
}

/**
 * B9 tamper-evident audit trail: every entry's hash covers its own fields plus the previous entry's
 * hash (`prevHash`), so altering any past row breaks every hash computed after it. `verifyChain`
 * recomputes the chain from scratch and reports the first row where the stored hash no longer
 * matches -- that is "tampering detected".
 *
 * The hashed material intentionally excludes `id`/`hash` themselves (hash cannot depend on its own
 * value) and `createdAt` is included so tests must control it explicitly for reproducibility -- see
 * service.test.ts.
 */
export class AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  async record(input: RecordAuditInput) {
    const { prisma } = this.deps;
    // B10 compatibility fix: with more audit sources (case views, exports, notices, labels) two requests can
    // record at once, and both would read the same "previous" row and fork the chain (verifyChain then reports
    // tampering). A transaction-scoped advisory lock serialises appends. Test fakes without $transaction skip it.
    if (typeof prisma.$transaction !== 'function') return this.append(prisma, input);
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`;
      return this.append(tx as unknown as PrismaClient, input);
    });
  }

  private async append(db: PrismaClient, input: RecordAuditInput) {
    const prev = await db.auditLog.findFirst({ orderBy: { seq: 'desc' } });
    const prevHash = prev?.hash ?? null;
    // seq is DB-assigned (autoincrement); we don't know it yet, so the hash covers prevHash (the actual
    // chain-integrity mechanism) rather than seq. We persist prevHash/hash and let the DB assign seq for ordering.
    const createdAt = new Date();
    const material = {
      actorId: input.actorId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      meta: input.meta ?? null,
      prevHash,
      createdAt: createdAt.toISOString(),
    };
    const hash = sha256Hex(canonicalize(material));

    return db.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        meta: (input.meta ?? undefined) as Prisma.InputJsonValue | undefined,
        prevHash,
        hash,
        createdAt,
      },
    });
  }

  /** Walks the chain in seq order (optionally scoped to one entity/entityId) and recomputes every hash. */
  async verifyChain(entity?: string, entityId?: string): Promise<VerifyChainResult> {
    const rows = await this.deps.prisma.auditLog.findMany({
      where: {
        entity: entity ?? undefined,
        entityId: entityId ?? undefined,
      },
      orderBy: { seq: 'asc' },
    });

    // B10 compatibility fix: a scoped walk (one entity) starts mid-chain, so each row's prevHash must be checked against
    // the globally preceding row rather than assuming the scope's first row is the start of the chain.
    const scoped = entity !== undefined || entityId !== undefined;
    let expectedPrevHash: string | null = null;
    for (const row of rows) {
      if (scoped) {
        const before = await this.deps.prisma.auditLog.findFirst({ where: { seq: { lt: row.seq } }, orderBy: { seq: 'desc' } });
        expectedPrevHash = before?.hash ?? null;
      }
      const material = {
        actorId: row.actorId ?? null,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId ?? null,
        meta: (row.meta as Record<string, unknown> | null) ?? null,
        prevHash: row.prevHash ?? null,
        createdAt: row.createdAt.toISOString(),
      };
      const expectedHash = sha256Hex(canonicalize(material));
      if (row.prevHash !== expectedPrevHash || row.hash !== expectedHash) {
        return { valid: false, brokenAt: { seq: row.seq, id: row.id, expectedHash, actualHash: row.hash } };
      }
      expectedPrevHash = row.hash;
    }
    return { valid: true };
  }
}
