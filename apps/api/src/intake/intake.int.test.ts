import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USDT_ERC20, USDT_TRC20, classifyIdentifier } from '@ps26183/shared';
import { createApp } from '../app';
import { createPrisma } from '../db/prisma';
import { createIntakeService, type IntakeService, type RowResult } from './service';
import { btcAddress, complaint, evmAddress, fakeProbe, RecordingQueue, tronAddress, txHash } from './testutil';

const run = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const ack = (n: string | number) => `${run}-${n}`;
const addr = (label: string) => tronAddress(`${run}-${label}`);
const checksummed = (a: string) => (classifyIdentifier(a) as { normalized: string }).normalized;
const DEFAULTS = { maxHops: 6, minValueUsd: 10, windowDays: 30, taintModel: 'HAIRCUT' as const };
const HEADER = 'ack_no,reported_at,category,amount_inr,network,addresses,tx_hashes,token_contract,fir_number';

let prisma: PrismaClient;
let queue: RecordingQueue;
let probe: ReturnType<typeof fakeProbe>;
let intake: IntakeService;
let server: Server;
let base: string;

function build(active: Parameters<typeof fakeProbe>[0] = {}, opts: Parameters<typeof fakeProbe>[1] = {}) {
  queue = new RecordingQueue();
  probe = fakeProbe(active, opts);
  intake = createIntakeService({ prisma, queue, probe: probe.probe, defaults: DEFAULTS });
  server?.close();
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { intake }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}

const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const upload = async (csv: string, query = '') => {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'complaints.csv');
  const res = await fetch(`${base}/complaints/import${query}`, { method: 'POST', body: fd });
  return { status: res.status, body: (await res.json()) as any };
};
const csvRow = (n: string | number, addresses: string, over: { network?: string; amount?: string; date?: string; tx?: string; token?: string } = {}) =>
  `${ack(n)},${over.date ?? '2026-09-01T10:00:00+05:30'},Investment fraud,${over.amount ?? '100000'},${over.network ?? 'TRC20'},${addresses},${over.tx ?? ''},${over.token ?? ''},`;

const stored = async () => {
  const where = { ackNo: { startsWith: run } };
  const complaints = await prisma.complaint.findMany({ where, select: { id: true, caseId: true } });
  const caseIds = [...new Set(complaints.map((c) => c.caseId).filter(Boolean) as string[])];
  return {
    complaints: complaints.length,
    cases: caseIds.length,
    entries: await prisma.complaintAddress.count({ where: { complaint: where } }),
    traces: await prisma.traceJob.count({ where: { caseId: { in: caseIds } } }),
  };
};

beforeAll(() => {
  prisma = createPrisma();
  build();
});
afterAll(async () => {
  const complaints = await prisma.complaint.findMany({ where: { ackNo: { startsWith: run } }, select: { caseId: true } });
  const caseIds = [...new Set(complaints.map((c) => c.caseId).filter(Boolean) as string[])];
  await prisma.complaint.deleteMany({ where: { ackNo: { startsWith: run } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } }); // cascades trace jobs
  server?.close();
  await prisma.$disconnect();
});

describe('JSON intake: POST /api/v1/complaints', () => {
  it('creates the complaint, its case, chain-tagged entries and a QUEUED trace job', async () => {
    build();
    const a = addr('json1');
    const { status, body } = await post('/complaints', complaint(ack('json1'), { addresses: [a], firNumber: 'FIR-77', amountInr: '5,00,000.50' }));
    expect(status).toBe(201);
    expect(body.complaint).toMatchObject({ status: 'CREATED', ackNo: ack('json1'), caseCreated: true });

    const c = await prisma.complaint.findUniqueOrThrow({ where: { ackNo: ack('json1') }, include: { addresses: true, case: { include: { traces: true } } } });
    expect(c.amountInr.toFixed(2)).toBe('500000.50'); // exact decimal
    expect(c.reportedAt.toISOString()).toBe('2026-09-01T03:00:00.000Z'); // IST input stored as UTC
    expect(c.network).toBe('TRC20');
    expect(c.case?.firNumber).toBe('FIR-77');
    expect(c.addresses).toHaveLength(1);
    expect(c.addresses[0]).toMatchObject({ address: a, chain: 'TRON', kind: 'ADDRESS', candidateChains: [], flags: [] });
    expect(c.case!.traces).toHaveLength(1);
    expect(c.case!.traces[0]).toMatchObject({ seedChain: 'TRON', seedAddr: a, status: 'QUEUED', maxHops: 6, windowDays: 30, taintModel: 'HAIRCUT' });
    expect(c.case!.traces[0].reportedAmount).toBeNull();
  });

  it('TRON fast path: no probing, USDT-TRC20 pre-selected, straight onto the trace-tron queue', async () => {
    build();
    const a = addr('fast');
    const { body } = await post('/complaints', complaint(ack('fast'), { addresses: [a] }));
    expect(probe.calls).toEqual([]);
    expect(body.complaint.traceJobs).toEqual([expect.objectContaining({ chain: 'TRON', seed: a, queue: 'trace-tron', reused: false })]);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ chain: 'TRON', seed: a, token: USDT_TRC20, source: 'intake', options: DEFAULTS });
    const row = await prisma.traceJob.findUniqueOrThrow({ where: { id: queue.jobs[0].traceId } });
    expect(row.seedAddr).toBe(a);
  });

  it('rejects invalid input with per-field errors and stores nothing', async () => {
    build();
    const before = await stored();
    const { status, body } = await post('/complaints', { ackNo: ack('bad1'), reportedAt: 'soon', category: '', amountInr: '-3', addresses: ['TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ0M'] });
    expect(status).toBe(422);
    expect(body.complaint.status).toBe('INVALID');
    expect(body.complaint.errors.map((e: any) => `${e.field}:${e.code}`)).toEqual(
      expect.arrayContaining(['reportedAt:INVALID_DATE', 'category:REQUIRED', 'amountInr:INVALID_AMOUNT', 'addresses[0]:INVALID_ADDRESS']),
    );
    expect(await stored()).toEqual(before);
    expect(queue.jobs).toHaveLength(0);
  });

  it('reports every missing required field', async () => {
    build();
    const { status, body } = await post('/complaints', {});
    expect(status).toBe(422);
    expect(body.complaint.errors.map((e: any) => e.code)).toEqual(expect.arrayContaining(['REQUIRED', 'NO_IDENTIFIERS']));
  });

  it('returns 400 for a malformed body (unknown field, wrong type, bad JSON)', async () => {
    build();
    expect((await post('/complaints', { ...complaint(ack('x')), victimName: 'no' })).status).toBe(400);
    expect((await post('/complaints', { ...complaint(ack('x')), addresses: [42] })).body.error).toBe('INVALID_BODY');
    const res = await fetch(`${base}/complaints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_JSON');
  });

  it('is idempotent: resubmitting the same complaint returns the original and adds nothing', async () => {
    build();
    const body = complaint(ack('idem'), { addresses: [addr('idem')] });
    const first = await post('/complaints', body);
    const before = await stored();
    for (let i = 0; i < 3; i++) {
      const again = await post('/complaints', body);
      expect(again.status).toBe(200);
      expect(again.body.complaint).toMatchObject({ status: 'DUPLICATE', duplicateOf: 'existing', complaintId: first.body.complaint.complaintId, caseId: first.body.complaint.caseId });
    }
    expect(await stored()).toEqual(before);
    // the same trace job id every time, so the queue can never hold two jobs for one seed
    expect(new Set(queue.jobs.map((j) => j.traceId)).size).toBe(1);
  });
});

describe('CSV intake: POST /api/v1/complaints/import', () => {
  it('imports a mixed file (3 TRON, 1 EVM, 1 BTC) and tags every chain', async () => {
    const ev = evmAddress(`${run}-mix-evm`);
    build({ ETH: [checksummed(ev)] });
    const csv = [
      HEADER,
      csvRow('mix1', addr('mix1')),
      csvRow('mix2', addr('mix2')),
      csvRow('mix3', addr('mix3'), { date: '13/09/2026 09:40' }),
      csvRow('mix4', ev, { network: '' }),
      csvRow('mix5', btcAddress(`${run}-mix5`), { network: '' }),
    ].join('\n');
    const { status, body } = await upload(csv);
    expect(status).toBe(200);
    expect(body.summary).toMatchObject({ total: 5, created: 5, duplicates: 0, invalid: 0, casesCreated: 5, traceJobsPrepared: 5, tronTraceJobs: 3, queued: 5 });
    const chains = body.rows.map((r: RowResult) => r.entries![0].chain);
    expect(chains).toEqual(['TRON', 'TRON', 'TRON', 'ETH', 'BTC']);
    expect(body.rows[3].entries[0].flags).toEqual(['CHAIN_PROBED']); // EVM resolved by probing
    // only the EVM address was probed; TRON and BTC never touch the network
    expect(probe.calls.length).toBeGreaterThan(0);
    expect(probe.calls.every((c) => c.endsWith(checksummed(ev)))).toBe(true);
  });

  it('enqueues TRON rows first even when they come last in the file', async () => {
    build();
    const csv = [HEADER, csvRow('ord1', btcAddress(`${run}-ord1`), { network: '' }), csvRow('ord2', evmAddress(`${run}-ord2`), { network: 'ERC20' }), csvRow('ord3', addr('ord3')), csvRow('ord4', addr('ord4'))].join('\n');
    const { body } = await upload(csv);
    expect(body.summary.created).toBe(4);
    expect(queue.batches).toHaveLength(1);
    expect(queue.batches[0].map((j) => j.chain)).toEqual(['TRON', 'TRON', 'BTC', 'ETH']);
    expect(body.rows.map((r: RowResult) => r.traceJobs![0].queue)).toEqual(['trace', 'trace', 'trace-tron', 'trace-tron']);
    // pre-selected official token per chain
    expect(queue.batches[0].map((j) => j.token)).toEqual([USDT_TRC20, USDT_TRC20, null, USDT_ERC20]);
  });

  it('accepts a raw text/csv body as well as multipart', async () => {
    build();
    const res = await fetch(`${base}/complaints/import`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: [HEADER, csvRow('raw1', addr('raw1'))].join('\n') });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { summary: { created: number } }).summary.created).toBe(1);
  });

  it('returns a per-row error report: valid rows import, invalid rows say why and where', async () => {
    build();
    const csv = [
      HEADER,
      csvRow('err1', addr('err1')),
      csvRow('err2', 'TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ0M'), // Base58 violation
      csvRow('err3', addr('err3'), { amount: 'lots' }),
      csvRow('err4', ''),
      csvRow('err5', addr('err5'), { network: 'SOLANA' }),
      csvRow('err6', addr('err6')),
    ].join('\n');
    const { status, body } = await upload(csv);
    expect(status).toBe(200);
    expect(body.summary).toMatchObject({ total: 6, created: 2, invalid: 4 });
    const bad = body.rows.filter((r: RowResult) => r.status === 'INVALID');
    expect(bad.map((r: RowResult) => r.row)).toEqual([3, 4, 5, 6]); // line numbers in the file
    expect(bad[0].errors[0]).toMatchObject({ code: 'INVALID_ADDRESS' });
    expect(bad[0].errors[0].message).toMatch(/Base58 alphabet/);
    expect(bad[1].errors[0]).toMatchObject({ field: 'amountInr', code: 'INVALID_AMOUNT' });
    expect(bad[2].errors[0]).toMatchObject({ code: 'NO_IDENTIFIERS' });
    expect(bad[3].errors[0]).toMatchObject({ code: 'INVALID_NETWORK' });
    expect((await stored()).complaints).toBeGreaterThanOrEqual(2);
    expect(await prisma.complaint.count({ where: { ackNo: { in: [ack('err2'), ack('err3'), ack('err4'), ack('err5')] } } })).toBe(0);

    // ?report=errors returns only the rows that need attention
    const onlyErrors = await upload(csv, '?report=errors');
    expect(onlyErrors.body.rows.map((r: RowResult) => r.status).sort()).toEqual(['DUPLICATE', 'DUPLICATE', 'INVALID', 'INVALID', 'INVALID', 'INVALID']);
  });

  it('rejects unusable uploads: missing column, empty file, wrong type, no file', async () => {
    build();
    expect(await upload('ack_no,category\nA,B\n')).toMatchObject({ status: 400, body: { error: 'INVALID_CSV' } });
    expect(await upload(`${HEADER}\n`)).toMatchObject({ status: 400, body: { error: 'EMPTY_CSV' } });
    const wrong = await fetch(`${base}/complaints/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(wrong.status).toBe(415);
    const empty = await fetch(`${base}/complaints/import`, { method: 'POST', body: new FormData() });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe('NO_FILE');
  });

  it('is idempotent: re-importing the same file creates nothing new', async () => {
    build();
    const csv = [HEADER, csvRow('re1', addr('re1')), csvRow('re2', addr('re2')), csvRow('re3', addr('re3'))].join('\n');
    expect((await upload(csv)).body.summary).toMatchObject({ created: 3, duplicates: 0 });
    const before = await stored();
    for (let i = 0; i < 2; i++) {
      const again = await upload(csv);
      expect(again.body.summary).toMatchObject({ created: 0, duplicates: 3, casesCreated: 0, traceJobsPrepared: 0 });
    }
    expect(await stored()).toEqual(before);
  });

  it('marks a repeated acknowledgement number inside one file as a duplicate of the first', async () => {
    build();
    const { body } = await upload([HEADER, csvRow('dup', addr('dup1')), csvRow('dup', addr('dup2'))].join('\n'));
    expect(body.rows.map((r: RowResult) => [r.status, r.duplicateOf])).toEqual([['CREATED', undefined], ['DUPLICATE', 'file']]);
  });

  it('two concurrent imports of the same complaint create it exactly once', async () => {
    build();
    const raw = complaint(ack('race'), { addresses: [addr('race')] });
    const [a, b] = await Promise.all([intake.ingest([{ row: 1, raw }]), intake.ingest([{ row: 1, raw }])]);
    expect([a.rows[0].status, b.rows[0].status].sort()).toEqual(['CREATED', 'DUPLICATE']);
    expect(await prisma.complaint.count({ where: { ackNo: ack('race') } })).toBe(1);
  });

  it('handles a 1,000-row file: validation under 2 s, per-row report, TRON rows queued first', async () => {
    build();
    const rows: string[] = [HEADER];
    for (let i = 0; i < 1000; i++) {
      const bad = i % 20 === 7; // 50 invalid rows
      const a = bad ? `${addr(`p${i}`).slice(0, 33)}0` : addr(`p${i}`);
      rows.push(csvRow(`p${i}`, a));
    }
    const t0 = performance.now();
    const { status, body } = await upload(rows.join('\n'));
    const wall = performance.now() - t0;
    expect(status).toBe(200);
    expect(body.summary).toMatchObject({ total: 1000, created: 950, invalid: 50, tronTraceJobs: 950, queued: 950 });
    expect(body.summary.timings.validationMs).toBeLessThan(2000);
    const failed = body.rows.filter((r: RowResult) => r.status === 'INVALID');
    expect(failed).toHaveLength(50);
    expect(failed.every((r: RowResult) => r.errors[0].code === 'INVALID_ADDRESS' && r.row >= 2)).toBe(true);
    expect(queue.jobs.every((j) => j.chain === 'TRON' && j.token === USDT_TRC20)).toBe(true);
    console.log(`1,000-row import: validation ${body.summary.timings.validationMs} ms, persist+enqueue ${body.summary.timings.persistMs} ms, HTTP round trip ${wall.toFixed(0)} ms`);
  });
});

describe('crime linkage: a shared wallet links complaints into one case', () => {
  it('puts a new complaint into the existing case and reuses its trace job', async () => {
    build();
    const shared = addr('link-shared');
    const first = (await post('/complaints', complaint(ack('link1'), { addresses: [shared, addr('link1-own')] }))).body.complaint;
    const second = (await post('/complaints', complaint(ack('link2'), { addresses: [shared, addr('link2-own')] }))).body.complaint;
    expect(second.status).toBe('CREATED');
    expect(second.caseId).toBe(first.caseId);
    expect(second.caseCreated).toBeUndefined();
    expect(second.linkedCaseIds).toEqual([first.caseId]);
    expect(second.linkedAckNos).toEqual([ack('link1')]);
    const sharedJob = second.traceJobs.find((t: any) => t.seed === shared);
    expect(sharedJob.reused).toBe(true);
    expect(sharedJob.id).toBe(first.traceJobs.find((t: any) => t.seed === shared).id);
    expect(await prisma.traceJob.count({ where: { caseId: first.caseId } })).toBe(3); // shared + 2 own, no duplicate seed
    expect(await prisma.complaint.count({ where: { caseId: first.caseId } })).toBe(2);
  });

  it('matches EVM addresses regardless of the case they were typed in', async () => {
    build({ ETH: [] });
    const e = evmAddress(`${run}-link-evm`);
    const first = (await post('/complaints', complaint(ack('evm1'), { addresses: [e], network: 'ERC20' }))).body.complaint;
    const second = (await post('/complaints', complaint(ack('evm2'), { addresses: [e.toUpperCase().replace('0X', '0X')], network: 'ERC20' }))).body.complaint;
    expect(second.caseId).toBe(first.caseId);
  });

  it('links complaints inside the same file and creates a single case for them', async () => {
    build();
    const shared = addr('inbatch');
    const { body } = await upload([HEADER, csvRow('ib1', `${shared};${addr('ib1')}`), csvRow('ib2', shared), csvRow('ib3', addr('ib3'))].join('\n'));
    expect(body.rows[0].caseId).toBe(body.rows[1].caseId);
    expect(body.rows[2].caseId).not.toBe(body.rows[0].caseId);
    expect(body.rows[1].linkedAckNos).toEqual([ack('ib1')]);
    expect(body.summary).toMatchObject({ created: 3, casesCreated: 2, linked: 1 });
  });

  it('does not link complaints that only share a transaction hash, or nothing at all', async () => {
    build();
    const h = txHash(`${run}-shared-tx`);
    const a = (await post('/complaints', complaint(ack('nl1'), { addresses: [addr('nl1')], txHashes: [h] }))).body.complaint;
    const b = (await post('/complaints', complaint(ack('nl2'), { addresses: [addr('nl2')], txHashes: [h] }))).body.complaint;
    expect(b.caseId).not.toBe(a.caseId);
    expect(b.linkedCaseIds).toBeUndefined();
  });

  it('joins the earliest case when a complaint touches two existing cases and reports both', async () => {
    build();
    const a1 = addr('two-a');
    const b1 = addr('two-b');
    const A = (await post('/complaints', complaint(ack('twoA'), { addresses: [a1] }))).body.complaint;
    await new Promise((r) => setTimeout(r, 15));
    const B = (await post('/complaints', complaint(ack('twoB'), { addresses: [b1] }))).body.complaint;
    expect(B.caseId).not.toBe(A.caseId);
    const C = (await post('/complaints', complaint(ack('twoC'), { addresses: [b1, a1] }))).body.complaint;
    expect(C.caseId).toBe(A.caseId);
    expect([...C.linkedCaseIds].sort()).toEqual([A.caseId, B.caseId].sort());
  });
});

describe('EVM ambiguity, tokens and hashes (persisted)', () => {
  it('keeps every active chain as a candidate, queues a trace per chain, and stores the ambiguity', async () => {
    const e = evmAddress(`${run}-amb`);
    build({ ETH: [checksummed(e)], POLYGON: [checksummed(e)] }); // the probe sees the EIP-55 form
    const { body } = await post('/complaints', complaint(ack('amb'), { addresses: [e], network: '' }));
    const entry = body.complaint.entries[0];
    expect(entry).toMatchObject({ chain: null, candidateChains: ['ETH', 'POLYGON'], flags: ['AMBIGUOUS_CHAIN'] });
    expect(body.complaint.warnings.map((w: any) => w.code)).toContain('AMBIGUOUS_CHAIN');
    expect(body.complaint.traceJobs.map((t: any) => t.chain)).toEqual(['ETH', 'POLYGON']);
    const row = await prisma.complaintAddress.findFirstOrThrow({ where: { complaint: { ackNo: ack('amb') } } });
    expect(row).toMatchObject({ chain: null, candidateChains: ['ETH', 'POLYGON'], flags: ['AMBIGUOUS_CHAIN'] });
    expect(probe.calls.filter((c) => c.startsWith('addr:')).map((c) => c.split(':')[1]).sort()).toEqual(['BSC', 'ETH', 'POLYGON']);
  });

  it('creates the complaint but queues nothing when the wallet has no activity anywhere', async () => {
    build();
    const { body } = await post('/complaints', complaint(ack('noact'), { addresses: [evmAddress(`${run}-noact`)], network: '' }));
    expect(body.complaint.status).toBe('CREATED');
    expect(body.complaint.entries[0].flags).toEqual(['NO_ACTIVITY']);
    expect(body.complaint.traceJobs).toEqual([]);
    expect(queue.jobs).toEqual([]);
  });

  it('a stated ERC20 network decides the chain without probing', async () => {
    build();
    const { body } = await post('/complaints', complaint(ack('erc'), { addresses: [evmAddress(`${run}-erc`)], network: 'ERC20' }));
    expect(probe.calls).toEqual([]);
    expect(body.complaint.entries[0].chain).toBe('ETH');
    expect(queue.jobs[0]).toMatchObject({ chain: 'ETH', token: USDT_ERC20 });
  });

  it('flags a look-alike token, stores the contract and the flag, but still traces the official USDT', async () => {
    build();
    const { body } = await post('/complaints', complaint(ack('fake'), { addresses: [addr('fake')], tokenContract: 'TKX4tuVb4ApiutoibSFugfFW9nBcXaMNDe' }));
    expect(body.complaint.warnings.map((w: any) => w.code)).toContain('UNTRUSTED_TOKEN');
    const c = await prisma.complaint.findUniqueOrThrow({ where: { ackNo: ack('fake') }, include: { addresses: true } });
    expect(c.tokenContract).toBe('TKX4tuVb4ApiutoibSFugfFW9nBcXaMNDe');
    expect(c.addresses[0].flags).toEqual(['UNTRUSTED_TOKEN']);
    expect(queue.jobs[0].token).toBe(USDT_TRC20);
  });

  it('accepts the official token without a flag', async () => {
    build();
    const { body } = await post('/complaints', complaint(ack('official'), { addresses: [addr('official')], tokenContract: USDT_TRC20 }));
    expect(body.complaint.warnings).toEqual([]);
    expect(body.complaint.entries[0].flags).toEqual([]);
  });

  it('stores transaction hashes as TX_HASH entries and never queues them as seeds', async () => {
    build();
    const h = txHash(`${run}-txonly`);
    const { body } = await post('/complaints', complaint(ack('txonly'), { addresses: [], txHashes: [h], network: 'TRC20' }));
    expect(body.complaint.status).toBe('CREATED');
    const row = await prisma.complaintAddress.findFirstOrThrow({ where: { complaint: { ackNo: ack('txonly') } } });
    expect(row).toMatchObject({ kind: 'TX_HASH', address: h, chain: 'TRON' });
    expect(body.complaint.traceJobs).toEqual([]);
  });
});

describe('queue outage recovery', () => {
  it('keeps the rows QUEUED when Redis is down and re-enqueues them on the next import', async () => {
    build();
    queue.fail = true;
    const raw = complaint(ack('outage'), { addresses: [addr('outage')] });
    const first = await intake.ingest([{ row: 1, raw }]);
    expect(first.rows[0].status).toBe('CREATED');
    expect(first.summary.queueError).toMatch(/redis down/);
    expect(first.summary.queued).toBe(0);
    const trace = await prisma.traceJob.findFirstOrThrow({ where: { seedAddr: addr('outage') } });
    expect(trace.status).toBe('QUEUED');

    queue.fail = false;
    const second = await intake.ingest([{ row: 1, raw }]);
    expect(second.rows[0].status).toBe('DUPLICATE');
    expect(queue.jobs.map((j) => j.traceId)).toContain(trace.id); // recovered without creating anything new
    expect(await prisma.traceJob.count({ where: { seedAddr: addr('outage') } })).toBe(1);
  });
});

describe('GET /api/v1/complaints', () => {
  it('lists and filters complaints', async () => {
    build();
    await upload([HEADER, csvRow('ls1', addr('ls1')), csvRow('ls2', evmAddress(`${run}-ls2`), { network: 'ERC20' }), csvRow('ls3', addr('ls3'))].join('\n'));
    const get = async (q: string) => (await (await fetch(`${base}/complaints?${q}`)).json()) as any;

    const one = await get(`ackNo=${ack('ls2')}`);
    expect(one.total).toBe(1);
    expect(one.items[0]).toMatchObject({ ackNo: ack('ls2'), amountInr: '100000', case: { status: 'OPEN' } });
    expect(one.items[0].addresses[0]).toMatchObject({ chain: 'ETH', kind: 'ADDRESS' });

    const tron = await get(`chain=TRON&category=investment&pageSize=200`);
    const mine = tron.items.filter((i: any) => i.ackNo.startsWith(run));
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.every((i: any) => i.addresses.some((a: any) => a.chain === 'TRON'))).toBe(true);

    const paged = await get(`caseId=${one.items[0].caseId}&page=1&pageSize=1`);
    expect(paged).toMatchObject({ total: 1, page: 1, pageSize: 1 });

    const dated = await get(`ackNo=${ack('ls1')}&from=2027-01-01`);
    expect(dated.total).toBe(0);
  });

  it('rejects an invalid query', async () => {
    build();
    const res = await fetch(`${base}/complaints?chain=SOLANA&page=0`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_QUERY');
  });
});
