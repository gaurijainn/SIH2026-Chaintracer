import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertEventEnvelope, MonitorEvent } from '@ps26183/shared';
import type { CreatedAlert } from './alerts';
import { handlePushMonitorEvent, type PushHandlerPrisma } from './pushHandler';

vi.mock('./subscriptionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subscriptionClient')>();
  return { ...actual, backoffMs: vi.fn(() => 5) };
});

const { MempoolBtcSubscriptionClient } = await import('./btcSubscriber');
const { backoffMs: mockedBackoffMs } = await import('./subscriptionClient');

const WATCHED_ADDR = 'bc1qwatchedaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNWATCHED_ADDR = 'bc1qother1111111111111111111111111111111111';

let server: WebSocketServer;
let port: number;
let serverSockets: WsSocket[];
let receivedMessages: { socket: WsSocket; raw: string }[];

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = new WebSocketServer({ port: 0 });
    serverSockets = [];
    receivedMessages = [];
    server.on('connection', (ws) => {
      serverSockets.push(ws);
      ws.on('message', (data) => receivedMessages.push({ socket: ws, raw: data.toString() }));
    });
    server.once('listening', () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
}
function stopServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function addressTxMessage(opts: { txid: string; inAddr: string; outAddr: string; outValue: number; inValue?: number; blockTime?: number }) {
  return JSON.stringify({
    'address-transactions': [
      {
        txid: opts.txid,
        vin: [{ prevout: { scriptpubkey_address: opts.inAddr, value: opts.inValue ?? 100_000 } }],
        vout: [{ scriptpubkey_address: opts.outAddr, value: opts.outValue }],
        status: { block_time: opts.blockTime },
      },
    ],
  });
}

beforeEach(async () => {
  await startServer();
  vi.mocked(mockedBackoffMs).mockClear();
});
afterEach(async () => {
  await stopServer();
});

describe('MempoolBtcSubscriptionClient (mock WebSocket wire protocol)', () => {
  it('establishes a connection', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    await waitFor(() => serverSockets.length === 1);
    expect(serverSockets).toHaveLength(1);
    await client.close();
  });

  it('sends a well-formed {"track-addresses": [...]} subscription request', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    await client.subscribe([WATCHED_ADDR, UNWATCHED_ADDR]);
    await waitFor(() => receivedMessages.length === 1);

    const req = JSON.parse(receivedMessages[0].raw);
    expect(req['track-addresses']).toEqual([WATCHED_ADDR, UNWATCHED_ADDR]);
    await client.close();
  });

  it('parses an address-transactions push for a watched output address (direction in)', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_ADDR]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(addressTxMessage({ txid: 'tx1', inAddr: 'bc1qsender', outAddr: WATCHED_ADDR, outValue: 50_000, blockTime: 1_700_000_000 }));
    await waitFor(() => received.length === 1);

    expect(received[0]).toMatchObject({ chain: 'BTC', addr: WATCHED_ADDR, direction: 'in', counterparty: 'bc1qsender', txHash: 'tx1', amount: '50000', token: 'BTC' });
    expect(received[0].ts).toBe(1_700_000_000_000);
    await client.close();
  });

  it('parses a push where the watched address is the input (direction out)', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_ADDR]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(addressTxMessage({ txid: 'tx2', inAddr: WATCHED_ADDR, outAddr: 'bc1qrecipient', outValue: 30_000, inValue: 40_000 }));
    await waitFor(() => received.length === 1);

    expect(received[0]).toMatchObject({ addr: WATCHED_ADDR, direction: 'out', counterparty: 'bc1qrecipient', amount: '40000' });
    await client.close();
  });

  it('ignores address-transactions for addresses that are not watched (watched-address filtering)', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_ADDR]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(addressTxMessage({ txid: 'tx3', inAddr: 'bc1qsender', outAddr: UNWATCHED_ADDR, outValue: 1_000 }));
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toHaveLength(0);
    await client.close();
  });

  it('malformed JSON on the wire is ignored, not thrown', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_ADDR]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send('not json at all {{{');
    serverSockets[0].send(addressTxMessage({ txid: 'tx4', inAddr: 'bc1qsender', outAddr: WATCHED_ADDR, outValue: 1 }));
    await waitFor(() => received.length === 1);

    expect(received[0].txHash).toBe('tx4');
    await client.close();
  });

  it('a well-formed message with no matching keys (e.g. block-transactions only) is a no-op', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_ADDR]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(JSON.stringify({ 'block-transactions': [] }));
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toHaveLength(0);
    await client.close();
  });

  it('reconnects with bounded backoff after a disconnect and restores address tracking', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_ADDR]);
    await waitFor(() => serverSockets.length === 1);
    await waitFor(() => receivedMessages.length === 1);

    serverSockets[0].close();
    await waitFor(() => serverSockets.length === 2, 3000);
    expect(mockedBackoffMs).toHaveBeenCalledWith(0);

    await waitFor(() => receivedMessages.length === 2, 3000);
    const restored = JSON.parse(receivedMessages[1].raw);
    expect(restored['track-addresses']).toEqual([WATCHED_ADDR]);

    // continued monitoring after reconnect: a push on the new connection is still handled correctly.
    serverSockets[1].send(addressTxMessage({ txid: 'tx5', inAddr: 'bc1qsender', outAddr: WATCHED_ADDR, outValue: 999 }));
    await waitFor(() => received.length === 1);
    expect(received[0].txHash).toBe('tx5');

    await client.close();
  }, 10_000);

  it('the same push delivered twice (e.g. a reconnect racing an in-flight message) is emitted twice by the client -- dedup is the pipeline layer\'s job', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_ADDR]);
    await waitFor(() => serverSockets.length === 1);

    const msg = addressTxMessage({ txid: 'txdup', inAddr: 'bc1qsender', outAddr: WATCHED_ADDR, outValue: 5 });
    serverSockets[0].send(msg);
    serverSockets[0].send(msg);
    await waitFor(() => received.length === 2);

    expect(received[0].txHash).toBe('txdup');
    expect(received[1].txHash).toBe('txdup');
    await client.close();
  });

  it('close() stops reconnect attempts', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    await waitFor(() => serverSockets.length === 1);

    await client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(serverSockets).toHaveLength(1);
  });

  it('a transaction received over the real (mocked-wire) client reaches the B8 monitoring pipeline and produces an alert', async () => {
    const client = new MempoolBtcSubscriptionClient(`ws://127.0.0.1:${port}`);
    const alerts: (CreatedAlert & { metadata?: unknown })[] = [];
    let idSeq = 0;
    const prisma: PushHandlerPrisma = {
      watchlistItem: { findMany: async ({ where }) => (where.chain === 'BTC' && where.addr === WATCHED_ADDR ? [{ caseId: 'case-btc' }] : []) },
      alert: {
        create: async ({ data }) => {
          const created = { id: `alert${++idSeq}`, caseId: data.caseId as string, rule: data.rule as never, severity: data.severity as never, chain: data.chain as string, address: data.address as string, amount: (data.amount as string) ?? null, metadata: data.metadata } as CreatedAlert & { metadata?: unknown };
          alerts.push(created);
          return created;
        },
      },
    };
    const published: AlertEventEnvelope[] = [];
    const publish = async (e: AlertEventEnvelope) => {
      published.push(e);
    };
    const seen = new Set<string>();
    const isNewEvent = async (key: string) => (seen.has(key) ? false : (seen.add(key), true));

    // The mempool.space address-transactions push never populates MonitorEvent.usd either, so this
    // exercises A5 (blacklist), which -- like A2 -- has no USD dependency, rather than A1.
    client.on('transfer', (e) =>
      void handlePushMonitorEvent(
        { prisma, publish, ruleCtx: { findVasp: async () => null, findObfuscation: async () => null }, stateCtx: { getSharedMule: async () => null, getBlacklistState: async () => ({ sanctioned: true, stablecoinBlacklisted: false }), a4AlreadyFired: async () => false, a5AlreadyFired: async () => false }, isNewEvent },
        e,
      ),
    );

    await client.connect();
    await client.subscribe([WATCHED_ADDR]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(addressTxMessage({ txid: 'tx-pipeline', inAddr: 'bc1qsender', outAddr: WATCHED_ADDR, outValue: 12_345 }));
    await waitFor(() => alerts.length === 1);

    expect(alerts[0].rule).toBe('A5_BLACKLIST');
    expect(alerts[0].caseId).toBe('case-btc');
    expect(published).toHaveLength(1);
    expect(published[0].event).toBe('alert.new');

    await client.close();
  });
});
