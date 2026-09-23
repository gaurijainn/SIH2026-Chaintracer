import type { Prisma, PrismaClient } from '@prisma/client';
import { canonicalize, sha256Hex } from '@ps26183/shared';

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
    const prev = await this.deps.prisma.auditLog.findFirst({ orderBy: { seq: 'desc' } });
    const prevHash = prev?.hash ?? null;
    // seq is DB-assigned (autoincrement); we don't know it yet, so hash over a synthetic "next seq"
    // placeholder derived from the previous row instead of the real seq. This keeps the hash
    // computable before insert while still binding each entry to its position in the chain via
    // prevHash (the actual chain-integrity mechanism). We persist prevHash/hash and let the DB
    // assign seq for ordering only.
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

    return this.deps.prisma.auditLog.create({
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

    let expectedPrevHash: string | null = null;
    for (const row of rows) {
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
