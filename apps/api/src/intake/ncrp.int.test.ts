import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import { createMockNcrp } from '../../../../mocks/mock-server/src/app';
import { createPrisma } from '../db/prisma';
import { createHttpNcrpFeed, pollNcrp } from './ncrp';
import { createHttpProbe } from './probe';
import { createIntakeService } from './service';
import { RecordingQueue, tronAddress } from './testutil';

const repoFixtures = fileURLToPath(new URL('../../../../fixtures', import.meta.url));
const run = `n${Date.now().toString(36)}`;
const DEFAULTS = { maxHops: 6, minValueUsd: 10, windowDays: 30, taintModel: 'HAIRCUT' as const };

let prisma: PrismaClient;
beforeAll(() => {
  prisma = createPrisma();
});
afterAll(async () => {
  for (const where of [{ ackNo: { startsWith: run } }, { ackNo: { startsWith: 'NCRP-MOCK-' } }]) {
    const cs = await prisma.complaint.findMany({ where, select: { caseId: true } });
    const caseIds = [...new Set(cs.map((c) => c.caseId).filter(Boolean) as string[])];
    await prisma.complaint.deleteMany({ where });
    await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  }
  await prisma.$disconnect();
});

describe('mock NCRP poller (record, then replay offline)', () => {
  const records = [
    { acknowledgementNumber: `${run}-1`, incidentDateTime: '2026-09-01T08:30:00+05:30', categoryOfComplaint: 'Phishing', amountLost: '5000', paymentNetwork: 'TRC20', walletAddresses: [tronAddress(`${run}-a`)] },
    { acknowledgementNumber: `${run}-2`, incidentDateTime: '02/09/2026 10:00', categoryOfComplaint: 'Sextortion', amountLost: 9000, paymentNetwork: 'TRC20', walletAddresses: [tronAddress(`${run}-a`), tronAddress(`${run}-b`)] },
    { acknowledgementNumber: `${run}-3`, incidentDateTime: '2026-09-03', categoryOfComplaint: 'Investment fraud', amountLost: '70000', paymentNetwork: 'TRC20', walletAddresses: ['TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ0M'] },
  ];

  it('polls the mock server, ingests, links, and a second poll is a no-op', async () => {
    const fixturesDir = await mkdtemp(path.join(tmpdir(), 'ncrp-fx-'));
    const server = createMockNcrp({ records }).listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const env = { ...loadEnv({ DATA_MODE: 'record', NCRP_BASE_URL: `http://127.0.0.1:${port}` }), FIXTURES_DIR: fixturesDir };
      const queue = new RecordingQueue();
      const svc = createIntakeService({ prisma, queue, probe: null, defaults: DEFAULTS });

      const first = await pollNcrp(createHttpNcrpFeed(env), svc);
      expect(first).toMatchObject({ pages: 1, fetched: 3 });
      expect(first.ingest!.summary).toMatchObject({ created: 2, invalid: 1, duplicates: 0, linked: 1 });
      expect(first.ingest!.rows.find((r) => r.status === 'INVALID')!.errors[0].code).toBe('INVALID_ADDRESS');
      // -2 shares a wallet with -1, so they are one investigation
      const [c1, c2] = await Promise.all([1, 2].map((n) => prisma.complaint.findUniqueOrThrow({ where: { ackNo: `${run}-${n}` } })));
      expect(c2.caseId).toBe(c1.caseId);
      expect(queue.jobs.every((j) => j.chain === 'TRON')).toBe(true);

      const stateAfterFirst = await Promise.all([prisma.complaint.count({ where: { ackNo: { startsWith: run } } }), prisma.traceJob.count({ where: { caseId: c1.caseId! } })]);
      for (let i = 0; i < 2; i++) {
        const again = await pollNcrp(createHttpNcrpFeed(env), svc);
        expect(again.ingest!.summary).toMatchObject({ created: 0, duplicates: 2, invalid: 1, casesCreated: 0, traceJobsPrepared: 0 });
      }
      expect(await Promise.all([prisma.complaint.count({ where: { ackNo: { startsWith: run } } }), prisma.traceJob.count({ where: { caseId: c1.caseId! } })])).toEqual(stateAfterFirst);

      // the recorder saved the feed page as a fixture
      expect(await readdir(path.join(fixturesDir, 'ncrp'))).toHaveLength(1);
    } finally {
      server.close();
    }

    // server is now closed: the same feed keeps working from the recorded fixture, offline
    const offlineEnv = { ...loadEnv({ DATA_MODE: 'replay', NCRP_BASE_URL: 'http://127.0.0.1:1' }), FIXTURES_DIR: fixturesDir };
    const offline = await pollNcrp(createHttpNcrpFeed(offlineEnv), createIntakeService({ prisma, queue: new RecordingQueue(), probe: null, defaults: DEFAULTS }));
    expect(offline.error).toBeUndefined();
    expect(offline.ingest!.summary).toMatchObject({ created: 0, duplicates: 2, invalid: 1 });
  });
});

describe('shipped replay fixtures: mock NCRP feed + EVM probes, fully offline', () => {
  it('ingests the whole mock feed with no network, resolving the ambiguous EVM wallet from fixtures', async () => {
    const env = { ...loadEnv({ DATA_MODE: 'replay' }), FIXTURES_DIR: repoFixtures };
    const queue = new RecordingQueue();
    const svc = createIntakeService({ prisma, queue, probe: createHttpProbe(env), defaults: DEFAULTS });
    const r = await pollNcrp(createHttpNcrpFeed(env), svc);
    expect(r.error).toBeUndefined();
    const s = r.ingest!.summary;
    expect(s.total).toBe(7);
    expect(s.invalid).toBe(1);
    expect(s.created + s.duplicates).toBe(6);
    expect(r.ingest!.rows.filter((x) => x.status === 'INVALID')[0].ackNo).toBe('NCRP-MOCK-0007');

    // whether created just now or by an earlier run, the stored state is the same
    const get = (n: number) => prisma.complaint.findUniqueOrThrow({ where: { ackNo: `NCRP-MOCK-000${n}` }, include: { addresses: true } });
    const [c1, c2, c4, c5, c6] = await Promise.all([1, 2, 4, 5, 6].map(get));
    expect(c2.caseId).toBe(c1.caseId); // share a TRON wallet
    expect(c2.addresses.every((a) => a.flags.includes('UNTRUSTED_TOKEN'))).toBe(true); // look-alike token
    expect(c4.addresses[0].chain).toBe('ETH'); // stated ERC20
    expect(c5.addresses[0].chain).toBe('BTC');
    expect(c6.addresses[0]).toMatchObject({ chain: 'ETH', flags: ['CHAIN_PROBED'] }); // no network: probed from fixtures
    expect(c1.tokenContract).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');

    const again = await pollNcrp(createHttpNcrpFeed(env), svc);
    expect(again.ingest!.summary).toMatchObject({ created: 0, duplicates: 6, invalid: 1 });
  });
});
