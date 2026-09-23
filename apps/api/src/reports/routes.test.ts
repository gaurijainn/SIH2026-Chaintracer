import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}
import { createApp } from '../app';
import { CaseNotFoundError, EvidenceNotFoundError } from './errors';
import type { ReportService } from './service';

let server: Server;
let base: string;

const evidence = {
  schemaVersion: 'evidence.v1' as const,
  generatedAt: '2026-01-01T00:00:00.000Z',
  case: { id: 'case1', title: 'Case', status: 'OPEN', firNumber: null, ackNo: null },
  victimTransaction: null,
  hops: [],
  graph: { nodes: [], edges: [] },
  attribution: [],
  risk: [],
  sources: [],
  methodology: { taintModel: null, maxHops: null, minValueUsd: null, windowDays: null, description: 'x' },
  limitations: [],
};

const fakeService = {
  generate: async (caseId: string, input: { format: 'json' | 'pdf' }) => {
    if (caseId === 'missing') throw new CaseNotFoundError(caseId);
    if (input.format === 'pdf') {
      return { report: { id: 'r1', caseId, version: 'evidence.v1', sha256: 'abc123', pdfPath: '/tmp/r1.pdf', createdAt: new Date() }, json: evidence, pdfBuffer: Buffer.from('%PDF-1.4 fake') };
    }
    return { report: { id: 'r1', caseId, version: 'evidence.v1', sha256: 'abc123', pdfPath: null, createdAt: new Date() }, json: evidence };
  },
  verify: async (sha256: string) => {
    if (sha256 === 'unknown') throw new EvidenceNotFoundError(sha256);
    return { match: sha256 === 'abc123', report: { id: 'r1', caseId: 'case1', version: 'evidence.v1', sha256: 'abc123', createdAt: new Date() } };
  },
} as unknown as ReportService;

beforeAll(() => {
  const ok = async () => undefined;
  const deps = { mode: 'replay' as const, core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok }, probeProvider: ok, hasKey: () => false };
  server = createApp(deps, { reports: fakeService }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => server.close());

describe('POST /cases/:id/reports', () => {
  it('generates a JSON evidence report by default', async () => {
    const res = await fetch(`${base}/cases/case1/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.report.sha256).toBe('abc123');
    expect(body.evidence.schemaVersion).toBe('evidence.v1');
  });

  it('generates a PDF when format=pdf', async () => {
    const res = await fetch(`${base}/cases/case1/reports?format=pdf`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('x-report-sha256')).toBe('abc123');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('404s for an unknown case', async () => {
    const res = await fetch(`${base}/cases/missing/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('CASE_NOT_FOUND');
  });

  it('400s for an invalid format', async () => {
    const res = await fetch(`${base}/cases/case1/reports?format=xml`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });
});

describe('GET /verify/:hash', () => {
  it('reports a match for a known hash', async () => {
    const res = await fetch(`${base}/verify/abc123`);
    expect(res.status).toBe(200);
    expect((await json(res)).match).toBe(true);
  });

  it('reports no match when the requested hash does not equal the stored one', async () => {
    const res = await fetch(`${base}/verify/abc123differenthash`);
    expect(res.status).toBe(200);
    expect((await json(res)).match).toBe(false);
  });

  it('404s for an unknown hash', async () => {
    const res = await fetch(`${base}/verify/unknown`);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('EVIDENCE_NOT_FOUND');
  });
});
