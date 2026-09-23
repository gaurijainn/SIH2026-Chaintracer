import { describe, expect, it, vi } from 'vitest';
import { AlertNotFoundError, InvalidAlertTransitionError } from './errors';
import { AlertService } from './service';

function fakePrisma(seed: { id: string; caseId: string; severity: string; status: string }[]) {
  const rows = seed.map((s) => ({ ...s }));
  return {
    prisma: {
      alert: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          rows.filter((r) => (where.caseId === undefined || r.caseId === where.caseId) && (where.severity === undefined || r.severity === where.severity) && (where.status === undefined || r.status === where.status)),
        ),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === where.id);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return row;
        }),
      },
    } as never,
    rows,
  };
}

describe('AlertService.list', () => {
  it('filters by caseId, severity and status', async () => {
    const { prisma } = fakePrisma([
      { id: 'a1', caseId: 'case1', severity: 'HIGH', status: 'NEW' },
      { id: 'a2', caseId: 'case1', severity: 'CRITICAL', status: 'NEW' },
      { id: 'a3', caseId: 'case2', severity: 'HIGH', status: 'ACKNOWLEDGED' },
    ]);
    const service = new AlertService({ prisma });
    expect(await service.list({ caseId: 'case1' })).toHaveLength(2);
    expect(await service.list({ severity: 'CRITICAL' as never })).toHaveLength(1);
    expect(await service.list({ status: 'ACKNOWLEDGED' as never })).toHaveLength(1);
    expect(await service.list({})).toHaveLength(3);
  });
});

describe('AlertService.update', () => {
  it('acknowledge sets status to ACKNOWLEDGED', async () => {
    const { prisma } = fakePrisma([{ id: 'a1', caseId: 'case1', severity: 'HIGH', status: 'NEW' }]);
    const service = new AlertService({ prisma });
    const updated = await service.update('a1', { action: 'acknowledge' });
    expect(updated.status).toBe('ACKNOWLEDGED');
  });

  it('assign requires assigneeId and sets status to ASSIGNED', async () => {
    const { prisma } = fakePrisma([{ id: 'a1', caseId: 'case1', severity: 'HIGH', status: 'NEW' }]);
    const service = new AlertService({ prisma });
    await expect(service.update('a1', { action: 'assign' })).rejects.toThrow(InvalidAlertTransitionError);
    const updated = await service.update('a1', { action: 'assign', assigneeId: 'user1' });
    expect(updated.status).toBe('ASSIGNED');
    expect((updated as { assigneeId?: string }).assigneeId).toBe('user1');
  });

  it('snooze requires a valid snoozedUntil and sets status to SNOOZED', async () => {
    const { prisma } = fakePrisma([{ id: 'a1', caseId: 'case1', severity: 'HIGH', status: 'NEW' }]);
    const service = new AlertService({ prisma });
    await expect(service.update('a1', { action: 'snooze' })).rejects.toThrow(InvalidAlertTransitionError);
    await expect(service.update('a1', { action: 'snooze', snoozedUntil: 'not-a-date' })).rejects.toThrow(InvalidAlertTransitionError);
    const updated = await service.update('a1', { action: 'snooze', snoozedUntil: '2026-10-01T00:00:00Z' });
    expect(updated.status).toBe('SNOOZED');
  });

  it('throws AlertNotFoundError for an unknown id', async () => {
    const { prisma } = fakePrisma([]);
    const service = new AlertService({ prisma });
    await expect(service.update('nope', { action: 'acknowledge' })).rejects.toThrow(AlertNotFoundError);
  });
});
