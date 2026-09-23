import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { AlertNotFoundError, CaseNotFoundError, InvalidNoticeTransitionError, VaspNotFoundError } from './errors';
import { FreezeNoticeService } from './service';

function fakeDeps() {
  const cases: Record<string, { id: string }> = { c1: { id: 'c1' } };
  const vasps: Record<string, { id: string; name: string; jurisdiction: string; contactEmail: string | null; contactPortal: string | null; addresses: { addr: string }[] }> = {
    v1: { id: 'v1', name: 'Binance', jurisdiction: 'IN', contactEmail: 'legal@ex.com', contactPortal: null, addresses: [{ addr: 'TDeposit1' }] },
  };
  const alerts: Record<string, { id: string; caseId: string; metadata: Record<string, unknown> | null }> = {
    a1: { id: 'a1', caseId: 'c1', metadata: { vaspName: 'Binance', freezeWindowOpen: true, landingAddress: 'TDeposit1', txHash: 'tx1' } },
    aOther: { id: 'aOther', caseId: 'c2', metadata: {} },
  };
  const traces = [{ id: 't1', caseId: 'c1' }];
  const hops = [{ id: 'h1', traceId: 't1', chain: 'TRON', toAddr: 'TDeposit1', txHash: 'tx1', token: 'USDT', amount: new Prisma.Decimal('100'), usd: new Prisma.Decimal('100'), ts: new Date('2026-01-01T00:00:00Z') }];

  const notices: Record<string, { id: string; caseId: string; vaspId: string; status: string; legalProvision: string | null; body: unknown; submissionId: string | null; approvedById: string | null; approvedAt: Date | null; sentAt: Date | null }> = {};
  let nextId = 1;

  const auditCalls: { action: string }[] = [];

  const prisma = {
    case: { findUnique: async ({ where }: { where: { id: string } }) => cases[where.id] ?? null },
    vasp: { findUnique: async ({ where }: { where: { id: string } }) => vasps[where.id] ?? null },
    alert: { findUnique: async ({ where }: { where: { id: string } }) => alerts[where.id] ?? null },
    traceJob: { findMany: async ({ where }: { where: { caseId: string } }) => traces.filter((t) => t.caseId === where.caseId) },
    hop: { findMany: async ({ where }: { where: { toAddr: { in: string[] } } }) => hops.filter((h) => where.toAddr.in.includes(h.toAddr)) },
    freezeNotice: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `fn${nextId++}`, status: 'DRAFT', submissionId: null, approvedById: null, approvedAt: null, sentAt: null, ...data };
        notices[row.id as string] = row as never;
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => notices[where.id] ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(notices[where.id], data);
        return notices[where.id];
      }),
    },
  } as never;

  const audit = { record: vi.fn(async (input: { action: string }) => void auditCalls.push(input)) } as never;
  const sahyog = { submit: vi.fn(async (payload: Record<string, unknown>) => ({ submissionId: `sub-${JSON.stringify(payload).length}`, sandbox: true as const, mode: 'sandbox' })) };

  return { prisma, audit, sahyog, notices, auditCalls };
}

describe('FreezeNoticeService.draft', () => {
  it('builds a body with VASP contact, deposit addresses, tx hashes and amounts, status DRAFT, legalProvision null', async () => {
    const deps = fakeDeps();
    const service = new FreezeNoticeService(deps);
    const notice = await service.draft('c1', { vaspId: 'v1', alertId: 'a1', actorId: 'io1' });

    expect(notice.status).toBe('DRAFT');
    expect(notice.legalProvision).toBeNull();
    const body = notice.body as { vasp: { name: string }; depositAddresses: string[]; txHashes: string[]; amounts: unknown[] };
    expect(body.vasp.name).toBe('Binance');
    expect(body.depositAddresses).toEqual(['TDeposit1']);
    expect(body.txHashes).toEqual(['tx1']);
    expect(body.amounts).toHaveLength(1);
  });

  it('throws CaseNotFoundError for an unknown case', async () => {
    const deps = fakeDeps();
    const service = new FreezeNoticeService(deps);
    await expect(service.draft('nope', { vaspId: 'v1' })).rejects.toThrow(CaseNotFoundError);
  });

  it('throws VaspNotFoundError for an unknown VASP', async () => {
    const deps = fakeDeps();
    const service = new FreezeNoticeService(deps);
    await expect(service.draft('c1', { vaspId: 'nope' })).rejects.toThrow(VaspNotFoundError);
  });

  it('throws AlertNotFoundError when the alert does not belong to the case', async () => {
    const deps = fakeDeps();
    const service = new FreezeNoticeService(deps);
    await expect(service.draft('c1', { vaspId: 'v1', alertId: 'aOther' })).rejects.toThrow(AlertNotFoundError);
  });
});

describe('FreezeNoticeService state machine', () => {
  async function draftOne(deps: ReturnType<typeof fakeDeps>) {
    const service = new FreezeNoticeService(deps);
    return { service, notice: await service.draft('c1', { vaspId: 'v1', alertId: 'a1' }) };
  }

  it('DRAFT -> PENDING_APPROVAL -> APPROVED -> SENT happy path', async () => {
    const deps = fakeDeps();
    const { service, notice } = await draftOne(deps);

    const submitted = await service.submitForApproval(notice.id);
    expect(submitted.status).toBe('PENDING_APPROVAL');

    const approved = await service.approve(notice.id, { approvedById: 'sup1' });
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedById).toBe('sup1');

    const sent = await service.send(notice.id);
    expect(sent.status).toBe('SENT');
    expect(sent.submissionId).toBeTruthy();
    expect(deps.sahyog.submit).toHaveBeenCalledTimes(1);
  });

  it('rejects send() when the notice has not been approved (negative case)', async () => {
    const deps = fakeDeps();
    const { service, notice } = await draftOne(deps);
    await expect(service.send(notice.id)).rejects.toThrow(InvalidNoticeTransitionError);
    expect(deps.sahyog.submit).not.toHaveBeenCalled();

    await service.submitForApproval(notice.id);
    await expect(service.send(notice.id)).rejects.toThrow(InvalidNoticeTransitionError);
    expect(deps.sahyog.submit).not.toHaveBeenCalled();
  });

  it('rejects approve() when not PENDING_APPROVAL', async () => {
    const deps = fakeDeps();
    const { service, notice } = await draftOne(deps);
    await expect(service.approve(notice.id, {})).rejects.toThrow(InvalidNoticeTransitionError);
  });

  it('edit() only allowed while DRAFT/PENDING_APPROVAL', async () => {
    const deps = fakeDeps();
    const { service, notice } = await draftOne(deps);
    const edited = await service.edit(notice.id, { legalProvision: 'Sec 91 CrPC (example)' });
    expect(edited.legalProvision).toBe('Sec 91 CrPC (example)');

    await service.submitForApproval(notice.id);
    await service.approve(notice.id, {});
    await expect(service.edit(notice.id, { legalProvision: 'x' })).rejects.toThrow(InvalidNoticeTransitionError);
  });

  it('resending an already-SENT notice is idempotent (no duplicate submission)', async () => {
    const deps = fakeDeps();
    const { service, notice } = await draftOne(deps);
    await service.submitForApproval(notice.id);
    await service.approve(notice.id, {});
    const first = await service.send(notice.id);
    const second = await service.send(notice.id);
    expect(second.submissionId).toBe(first.submissionId);
    expect(deps.sahyog.submit).toHaveBeenCalledTimes(1);
  });
});
