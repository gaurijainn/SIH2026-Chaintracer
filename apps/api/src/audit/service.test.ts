import { describe, expect, it } from 'vitest';
import { AuditService } from './service';

interface Row {
  id: string;
  seq: number;
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  meta: unknown;
  prevHash: string | null;
  hash: string | null;
  createdAt: Date;
}

function fakePrisma() {
  const rows: Row[] = [];
  let nextSeq = 1;
  let nextId = 1;
  return {
    prisma: {
      auditLog: {
        findFirst: async ({ orderBy }: { orderBy: { seq: 'desc' } }) => {
          if (rows.length === 0) return null;
          return orderBy.seq === 'desc' ? rows[rows.length - 1] : rows[0];
        },
        findMany: async ({ where, orderBy }: { where: { entity?: string; entityId?: string }; orderBy: { seq: 'asc' } }) => {
          let out = rows.filter((r) => (where.entity === undefined || r.entity === where.entity) && (where.entityId === undefined || r.entityId === where.entityId));
          out = [...out].sort((a, b) => (orderBy.seq === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          return out;
        },
        create: async ({ data }: { data: Omit<Row, 'id' | 'seq'> }) => {
          const row: Row = { id: `audit${nextId++}`, seq: nextSeq++, ...data, meta: data.meta ?? null };
          rows.push(row);
          return row;
        },
      },
    } as never,
    rows,
  };
}

describe('AuditService.record', () => {
  it('first entry has null prevHash', async () => {
    const { prisma } = fakePrisma();
    const service = new AuditService({ prisma });
    const first = await service.record({ action: 'evidence generated', entity: 'Report', entityId: 'r1' });
    expect(first.prevHash).toBeNull();
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("second entry's prevHash equals first's hash", async () => {
    const { prisma } = fakePrisma();
    const service = new AuditService({ prisma });
    const first = await service.record({ action: 'evidence generated', entity: 'Report', entityId: 'r1' });
    const second = await service.record({ action: 'evidence exported', entity: 'Report', entityId: 'r1' });
    expect(second.prevHash).toBe(first.hash);
  });

  it('different meta produces a different hash', async () => {
    const { prisma } = fakePrisma();
    const service = new AuditService({ prisma });
    const a = await service.record({ action: 'x', entity: 'Report', meta: { a: 1 } });
    const b = await service.record({ action: 'x', entity: 'Report', meta: { a: 2 } });
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('AuditService.verifyChain', () => {
  it('returns valid for an untampered chain', async () => {
    const { prisma } = fakePrisma();
    const service = new AuditService({ prisma });
    await service.record({ action: 'a', entity: 'Report', entityId: 'r1' });
    await service.record({ action: 'b', entity: 'Report', entityId: 'r1' });
    await service.record({ action: 'c', entity: 'Report', entityId: 'r1' });
    const result = await service.verifyChain('Report', 'r1');
    expect(result.valid).toBe(true);
  });

  it('detects tampering of a meta field', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new AuditService({ prisma });
    await service.record({ action: 'a', entity: 'Report', entityId: 'r1', meta: { x: 1 } });
    await service.record({ action: 'b', entity: 'Report', entityId: 'r1', meta: { x: 2 } });

    // tamper with the first row's meta after the fact, without recomputing its hash
    rows[0].meta = { x: 999 };

    const result = await service.verifyChain('Report', 'r1');
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.seq).toBe(rows[0].seq);
  });

  it('detects a broken prevHash link even if a single hash was recomputed to match its own row', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new AuditService({ prisma });
    await service.record({ action: 'a', entity: 'Report', entityId: 'r1' });
    await service.record({ action: 'b', entity: 'Report', entityId: 'r1' });
    // sever the chain link
    rows[1].prevHash = 'deadbeef';
    const result = await service.verifyChain('Report', 'r1');
    expect(result.valid).toBe(false);
  });

  it('an empty chain is valid', async () => {
    const { prisma } = fakePrisma();
    const service = new AuditService({ prisma });
    const result = await service.verifyChain('Nothing', 'nope');
    expect(result.valid).toBe(true);
  });
});
