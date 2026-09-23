import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}
import { createApp } from '../app';
import { CaseNotFoundError, FreezeNoticeNotFoundError, InvalidNoticeTransitionError, VaspNotFoundError } from './errors';
import type { FreezeNoticeService } from './service';

let server: Server;
let base: string;

const notices: Record<string, { id: string; status: string; legalProvision: string | null; body: unknown; submissionId: string | null }> = {
  fn1: { id: 'fn1', status: 'DRAFT', legalProvision: null, body: {}, submissionId: null },
  fn2: { id: 'fn2', status: 'PENDING_APPROVAL', legalProvision: null, body: {}, submissionId: null },
  fn3: { id: 'fn3', status: 'APPROVED', legalProvision: null, body: {}, submissionId: null },
};

const fakeService = {
  draft: async (caseId: string, input: { vaspId: string }) => {
    if (caseId === 'missing') throw new CaseNotFoundError(caseId);
    if (input.vaspId === 'missing') throw new VaspNotFoundError(input.vaspId);
    return { id: 'new1', status: 'DRAFT', caseId, vaspId: input.vaspId, legalProvision: null, body: {} };
  },
  edit: async (id: string, input: { legalProvision?: string }) => {
    const n = notices[id];
    if (!n) throw new FreezeNoticeNotFoundError(id);
    if (n.status === 'APPROVED') throw new InvalidNoticeTransitionError('cannot edit an approved notice');
    return { ...n, legalProvision: input.legalProvision ?? n.legalProvision };
  },
  submitForApproval: async (id: string) => {
    const n = notices[id];
    if (!n) throw new FreezeNoticeNotFoundError(id);
    return { ...n, status: 'PENDING_APPROVAL' };
  },
  approve: async (id: string) => {
    const n = notices[id];
    if (!n) throw new FreezeNoticeNotFoundError(id);
    if (n.status !== 'PENDING_APPROVAL') throw new InvalidNoticeTransitionError('not pending approval');
    return { ...n, status: 'APPROVED' };
  },
  send: async (id: string) => {
    const n = notices[id];
    if (!n) throw new FreezeNoticeNotFoundError(id);
    if (n.status !== 'APPROVED') throw new InvalidNoticeTransitionError('freeze notice must be APPROVED to send');
    return { ...n, status: 'SENT', submissionId: 'sub-1' };
  },
} as unknown as FreezeNoticeService;

beforeAll(() => {
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { freezeNotices: fakeService }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => server.close());

describe('POST /cases/:id/freeze-notices', () => {
  it('drafts a freeze notice', async () => {
    const res = await fetch(`${base}/cases/case1/freeze-notices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vaspId: 'v1' }) });
    expect(res.status).toBe(201);
    expect((await json(res)).freezeNotice.status).toBe('DRAFT');
  });

  it('404s for an unknown case', async () => {
    const res = await fetch(`${base}/cases/missing/freeze-notices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vaspId: 'v1' }) });
    expect(res.status).toBe(404);
  });

  it('400s when vaspId is missing', async () => {
    const res = await fetch(`${base}/cases/case1/freeze-notices`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });
});

describe('freeze-notice state-machine routes', () => {
  it('PATCH edits a DRAFT notice', async () => {
    const res = await fetch(`${base}/freeze-notices/fn1`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ legalProvision: 'Sec X' }) });
    expect(res.status).toBe(200);
    expect((await json(res)).freezeNotice.legalProvision).toBe('Sec X');
  });

  it('POST /approve rejects a DRAFT notice (not yet submitted for approval)', async () => {
    const res = await fetch(`${base}/freeze-notices/fn1/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('INVALID_TRANSITION');
  });

  it('POST /approve approves a PENDING_APPROVAL notice', async () => {
    const res = await fetch(`${base}/freeze-notices/fn2/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    expect((await json(res)).freezeNotice.status).toBe('APPROVED');
  });

  it('POST /send rejects a DRAFT notice (unapproved notice cannot be submitted -- negative case)', async () => {
    const res = await fetch(`${base}/freeze-notices/fn1/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('INVALID_TRANSITION');
  });

  it('POST /send succeeds for an APPROVED notice', async () => {
    const res = await fetch(`${base}/freeze-notices/fn3/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.freezeNotice.status).toBe('SENT');
    expect(body.freezeNotice.submissionId).toBe('sub-1');
  });

  it('404s for an unknown notice id', async () => {
    const res = await fetch(`${base}/freeze-notices/nope/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });
});
