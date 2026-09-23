import type { AddressInfo } from 'node:net';
import http, { type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MlHttpError, MlResponseError, MlTimeoutError, MlUnavailableError } from './errors';
import { HttpMlClient, type RawFeatureVector } from './mlClient';

const rawFeatures: RawFeatureVector = {
  dwell_median_min: 12,
  fan_out_1h: 8,
  fan_in_unique: 15,
  passthrough_ratio: 0.98,
  age_at_taint_days: 2,
  activator_label: 'TSomeActivator123',
  trx_dust_usdt: true,
  round_amount_ratio: 0.7,
  burst_tx_per_hour: 20,
  hops_from_victim: null,
  hops_to_vasp: null,
  sanction_exposure: null,
  external_flags: ['high_risk', 'reported'],
  shared_mule_cps: 4,
  cross_case_count: 0,
};

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('HttpMlClient.score', () => {
  it('posts to /score and returns a validated, parsed response', async () => {
    const body = [
      {
        addr: 'TAddr1',
        score: 62,
        band: 'High',
        factors: [{ feature: 'fan_out_1h', impact: 0.31, reason: 'high fan-out within 1 hour' }],
        overrides: [],
        modelVersion: 'tron-xgb-v1',
        mlProbability: 0.61,
        ruleScore: 55,
        explanationStatus: 'ok',
        datasetVersion: 'tron-bootstrap-v1',
      },
    ];
    let receivedPath = '';
    let receivedBody: unknown;
    const base = await listen((req, res) => {
      receivedPath = req.url ?? '';
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });

    const client = new HttpMlClient(base);
    const result = await client.score([{ chain: 'TRON', addr: 'TAddr1', features: rawFeatures, sanctioned: undefined, stablecoinBlacklisted: undefined }]);

    expect(receivedPath).toBe('/score');
    expect(receivedBody).toEqual({ addresses: [{ chain: 'TRON', addr: 'TAddr1', features: rawFeatures, sanctioned: undefined, stablecoinBlacklisted: undefined }] });
    expect(result).toEqual(body);
  });

  it('throws MlTimeoutError when the ML service does not respond in time', async () => {
    const base = await listen((_req, res) => {
      setTimeout(() => res.end('{}'), 500);
    });
    const client = new HttpMlClient(base, 50);
    await expect(client.score([{ chain: 'TRON', addr: 'A', features: rawFeatures }])).rejects.toBeInstanceOf(MlTimeoutError);
  });

  it('throws MlUnavailableError when the ML service is unreachable', async () => {
    // nothing listening on this port
    const client = new HttpMlClient('http://127.0.0.1:1');
    await expect(client.score([{ chain: 'TRON', addr: 'A', features: rawFeatures }])).rejects.toBeInstanceOf(MlUnavailableError);
  });

  it('throws MlHttpError with the status code when the ML service returns a non-2xx status', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'model artifact error' }));
    });
    const client = new HttpMlClient(base);
    await expect(client.score([{ chain: 'TRON', addr: 'A', features: rawFeatures }])).rejects.toMatchObject({
      constructor: MlHttpError,
      status: 500,
    });
  });

  it('throws MlResponseError when the ML service returns 200 with a malformed body', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ addr: 'A', score: 'not-a-number' }]));
    });
    const client = new HttpMlClient(base);
    await expect(client.score([{ chain: 'TRON', addr: 'A', features: rawFeatures }])).rejects.toBeInstanceOf(MlResponseError);
  });

  it('throws MlResponseError when the ML service returns a non-array body for /score', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ not: 'an array' }));
    });
    const client = new HttpMlClient(base);
    await expect(client.score([{ chain: 'TRON', addr: 'A', features: rawFeatures }])).rejects.toBeInstanceOf(MlResponseError);
  });
});

describe('HttpMlClient.typology', () => {
  it('posts to /typology and returns a validated, parsed response', async () => {
    const body = { label: 'pig_butchering', confidence: 0.72, signals: ['escalating deposits from the same victim over days or weeks'] };
    let receivedPath = '';
    const base = await listen((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    const client = new HttpMlClient(base);
    const result = await client.typology({ caseFeatures: { escalating_deposits: true }, complaintCategory: 'Investment or trading fraud' });
    expect(receivedPath).toBe('/typology');
    expect(result).toEqual(body);
  });

  it('throws MlResponseError on a malformed typology response', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ label: 'x' })); // missing confidence/signals
    });
    const client = new HttpMlClient(base);
    await expect(client.typology({})).rejects.toBeInstanceOf(MlResponseError);
  });
});
