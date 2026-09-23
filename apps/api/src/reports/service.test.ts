import { describe, expect, it, vi } from 'vitest';
import { canonicalize, sha256Hex } from '@ps26183/shared';
import { evidenceV1Schema, type EvidenceV1 } from './schema';
import { ReportService } from './service';
import { EvidenceNotFoundError } from './errors';

vi.mock('./collector', () => ({
  collectEvidence: vi.fn(async (_deps: unknown, caseId: string) => makeEvidence(caseId)),
}));

function makeEvidence(caseId: string): EvidenceV1 {
  return {
    schemaVersion: 'evidence.v1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    case: { id: caseId, title: 'Case', status: 'OPEN', firNumber: null, ackNo: null },
    victimTransaction: null,
    hops: [],
    graph: { nodes: [], edges: [] },
    attribution: [],
    risk: [],
    sources: [],
    methodology: { taintModel: null, maxHops: null, minValueUsd: null, windowDays: null, description: 'x' },
    limitations: [],
  };
}

function fakeDeps() {
  const reports: Record<string, { id: string; caseId: string; version: string; sha256: string; payload: unknown; pdfPath: string | null; createdAt: Date; createdById: string | null }> = {};
  let nextId = 1;
  const auditCalls: unknown[] = [];
  const prisma = {
    report: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `report${nextId++}`, pdfPath: null, createdAt: new Date(), ...data } as (typeof reports)[string];
        reports[row.id] = row;
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(reports[where.id], data);
        return reports[where.id];
      }),
      findFirst: vi.fn(async ({ where }: { where: { sha256: string } }) => Object.values(reports).find((r) => r.sha256 === where.sha256) ?? null),
    },
  } as never;
  const audit = { record: vi.fn(async (input: unknown) => void auditCalls.push(input)) } as never;
  return { prisma, driver: {} as never, audit, reports, auditCalls };
}

describe('ReportService.generate', () => {
  it('same evidence produces the same hash (determinism)', async () => {
    const deps1 = fakeDeps();
    const service1 = new ReportService(deps1);
    const r1 = await service1.generate('caseX', { format: 'json' });

    const deps2 = fakeDeps();
    const service2 = new ReportService(deps2);
    const r2 = await service2.generate('caseX', { format: 'json' });

    expect(r1.report.sha256).toBe(r2.report.sha256);
  });

  it('a different caseId (different evidence) produces a different hash', async () => {
    const deps = fakeDeps();
    const service = new ReportService(deps);
    const r1 = await service.generate('caseA', { format: 'json' });
    const r2 = await service.generate('caseB', { format: 'json' });
    expect(r1.report.sha256).not.toBe(r2.report.sha256);
  });

  it('the persisted sha256 matches canonicalize+sha256Hex of the returned evidence', async () => {
    const deps = fakeDeps();
    const service = new ReportService(deps);
    const r = await service.generate('caseX', { format: 'json' });
    expect(r.report.sha256).toBe(sha256Hex(canonicalize(evidenceV1Schema.parse(r.json))));
  });

  it('records audit entries for generation and export', async () => {
    const deps = fakeDeps();
    const service = new ReportService(deps);
    await service.generate('caseX', { format: 'json', actorId: 'io1' });
    const actions = deps.auditCalls.map((c) => (c as { action: string }).action);
    expect(actions).toContain('evidence generated');
    expect(actions).toContain('evidence exported');
  });
});

describe('ReportService.verify', () => {
  it('reports a match for an untampered report', async () => {
    const deps = fakeDeps();
    const service = new ReportService(deps);
    const generated = await service.generate('caseX', { format: 'json' });
    const result = await service.verify(generated.report.sha256);
    expect(result.match).toBe(true);
    expect(result.report?.id).toBe(generated.report.id);
  });

  it('reports a mismatch when the stored payload has been tampered with', async () => {
    const deps = fakeDeps();
    const service = new ReportService(deps);
    const generated = await service.generate('caseX', { format: 'json' });
    // tamper with the persisted payload directly, bypassing the service
    (deps.reports[generated.report.id].payload as { case: { title: string } }).case.title = 'TAMPERED';
    const result = await service.verify(generated.report.sha256);
    expect(result.match).toBe(false);
  });

  it('throws EvidenceNotFoundError for an unknown hash', async () => {
    const deps = fakeDeps();
    const service = new ReportService(deps);
    await expect(service.verify('deadbeef')).rejects.toThrow(EvidenceNotFoundError);
  });
});
