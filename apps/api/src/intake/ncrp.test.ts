import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import { NCRP_PAGE_SIZE, NcrpPoller, createHttpNcrpFeed, fromNcrpRecord, pollNcrp, type NcrpFeed, type NcrpRecord } from './ncrp';
import { normalizeComplaint } from './normalize';
import { createHttpProbe } from './probe';
import type { IngestInput, IntakeService } from './service';

const fixturesDir = fileURLToPath(new URL('../../../../fixtures', import.meta.url));
const replayEnv = { ...loadEnv({ DATA_MODE: 'replay' }), FIXTURES_DIR: fixturesDir };

const service = () => {
  const seen: IngestInput[][] = [];
  return { seen, ingest: vi.fn(async (inputs: IngestInput[]) => (seen.push(inputs), { rows: [], summary: { created: inputs.length, duplicates: 0, invalid: 0 } as never })) } as unknown as IntakeService & { seen: IngestInput[][] };
};
const rec = (n: number): NcrpRecord => ({ acknowledgementNumber: `R-${n}`, incidentDateTime: '2026-09-01', categoryOfComplaint: 'x', amountLost: 1, walletAddresses: [] });

afterEach(() => vi.restoreAllMocks());

describe('NCRP record mapping', () => {
  it('maps NCRP-style field names to the intake shape', () => {
    expect(fromNcrpRecord({ acknowledgementNumber: 'A', incidentDateTime: 'D', categoryOfComplaint: 'C', amountLost: '5', paymentNetwork: 'TRC20', walletAddresses: ['w'], transactionHashes: ['h'], tokenContract: 't', firNumber: 'F' })).toEqual({
      ackNo: 'A', reportedAt: 'D', category: 'C', amountInr: '5', network: 'TRC20', addresses: ['w'], txHashes: ['h'], tokenContract: 't', firNumber: 'F',
    });
  });
});

describe('pollNcrp', () => {
  it('drains every page and ingests all records once, with stable row numbers', async () => {
    const pages = [Array.from({ length: NCRP_PAGE_SIZE }, (_, i) => rec(i)), [rec(1000), rec(1001)]];
    const feed: NcrpFeed = { fetchPage: async (p) => ({ records: pages[p - 1], hasMore: p < pages.length }) };
    const svc = service();
    const r = await pollNcrp(feed, svc);
    expect(r).toMatchObject({ pages: 2, fetched: NCRP_PAGE_SIZE + 2 });
    expect(svc.seen).toHaveLength(1);
    expect(svc.seen[0].map((i) => i.row).slice(-2)).toEqual([NCRP_PAGE_SIZE + 1, NCRP_PAGE_SIZE + 2]);
  });

  it('returns the error instead of throwing when the feed is unreachable, and ingests nothing', async () => {
    const svc = service();
    const r = await pollNcrp({ fetchPage: async () => { throw new Error('ECONNREFUSED'); } }, svc);
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(svc.ingest).not.toHaveBeenCalled();
  });

  it('does nothing when the feed is empty', async () => {
    const svc = service();
    const r = await pollNcrp({ fetchPage: async () => ({ records: [], hasMore: false }) }, svc);
    expect(r.ingest).toBeNull();
    expect(svc.ingest).not.toHaveBeenCalled();
  });
});

describe('NcrpPoller', () => {
  it('never runs two polls at once', async () => {
    let release!: () => void;
    const feed: NcrpFeed = { fetchPage: () => new Promise((r) => (release = () => r({ records: [rec(1)], hasMore: false }))) };
    const poller = new NcrpPoller(feed, service(), 0, () => undefined);
    const first = poller.pollOnce();
    expect(await poller.pollOnce()).toBeNull(); // skipped: one is already running
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect((await first)?.fetched).toBe(1);
  });

  it('is disabled when the interval is 0', () => {
    const feed = { fetchPage: vi.fn() };
    const poller = new NcrpPoller(feed, service(), 0, () => undefined);
    poller.start();
    expect(feed.fetchPage).not.toHaveBeenCalled();
  });

  it('survives an ingest failure and reports it', async () => {
    const svc = { ingest: vi.fn(async () => { throw new Error('db down'); }) } as unknown as IntakeService;
    const poller = new NcrpPoller({ fetchPage: async () => ({ records: [rec(1)], hasMore: false }) }, svc, 0, () => undefined);
    expect((await poller.pollOnce())?.error).toMatch(/db down/);
  });
});

describe('replay / offline operation', () => {
  it('serves the mock NCRP feed from recorded fixtures without any network access', async () => {
    const net = [vi.spyOn(http, 'request'), vi.spyOn(https, 'request'), vi.spyOn(http, 'get'), vi.spyOn(https, 'get')];
    const feed = createHttpNcrpFeed(replayEnv);
    const { records, hasMore } = await feed.fetchPage(1);
    expect(hasMore).toBe(false);
    expect(records.length).toBeGreaterThanOrEqual(7);
    expect(net.every((s) => s.mock.calls.length === 0)).toBe(true);
  });

  it('the shipped feed contains valid, ambiguous, look-alike-token and invalid complaints', async () => {
    const { records } = await createHttpNcrpFeed(replayEnv).fetchPage(1);
    const results = records.map((r) => normalizeComplaint(fromNcrpRecord(r), new Date('2026-09-20T00:00:00Z')));
    expect(results.filter((r) => r.value)).toHaveLength(6);
    const bad = results.filter((r) => !r.value);
    expect(bad).toHaveLength(1);
    expect(bad[0].errors[0].code).toBe('INVALID_ADDRESS');
  });

  it('fails cleanly (no crash, no hang) when a fixture is missing in replay mode', async () => {
    const feed = createHttpNcrpFeed({ ...replayEnv, FIXTURES_DIR: fixturesDir + '-missing' });
    const r = await pollNcrp(feed, service());
    expect(r.error).toMatch(/replay fixture missing/);
  });

  it('answers EVM chain probes from fixtures offline', async () => {
    const net = [vi.spyOn(http, 'request'), vi.spyOn(https, 'request')];
    const probe = createHttpProbe(replayEnv);
    const a = '0x8Ea58f742011C8808fc43D04d5951E7d3f7e693F';
    expect(await probe.addressActive('ETH', a)).toBe(true);
    expect(await probe.addressActive('POLYGON', a)).toBe(false);
    expect(await probe.addressActive('BSC', a)).toBe(false);
    await expect(probe.addressActive('ETH', '0x0000000000000000000000000000000000000001')).rejects.toThrow(/replay fixture missing/);
    expect(net.every((s) => s.mock.calls.length === 0)).toBe(true);
  });
});
