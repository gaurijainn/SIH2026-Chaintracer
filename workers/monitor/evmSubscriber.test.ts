import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertEventEnvelope, MonitorEvent } from '@ps26183/shared';
import type { CreatedAlert } from './alerts';
import { handlePushMonitorEvent, type PushHandlerPrisma } from './pushHandler';

vi.mock('./subscriptionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subscriptionClient')>();
  // Fast, deterministic reconnect timing for tests -- the real exponential/capped math is already
  // covered by subscriptionClient.test.ts; here we only need reconnects to happen quickly.
  return { ...actual, backoffMs: vi.fn(() => 5) };
});

// Imported after the mock so AlchemyEvmSubscriptionClient picks up the mocked backoffMs.
const { AlchemyEvmSubscriptionClient, TRANSFER_TOPIC0, addressToTopic } = await import('./evmSubscriber');
const { backoffMs: mockedBackoffMs } = await import('./subscriptionClient');

const USDT_CONTRACT = '0xdac17f958d2ee523a2206206994597c13d831ec';
const WATCHED_FROM = `0x${'1'.repeat(36)}aaaa`;
const WATCHED_TO = `0x${'2'.repeat(36)}bbbb`;

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

function transferLogMessage(from: string, to: string, amount: bigint, txHash: string) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'eth_subscription',
    params: {
      subscription: '0xmocksubid',
      result: {
        topics: [TRANSFER_TOPIC0, addressToTopic(from), addressToTopic(to)],
        data: `0x${amount.toString(16).padStart(64, '0')}`,
        transactionHash: txHash,
      },
    },
  });
}

beforeEach(async () => {
  await startServer();
  vi.mocked(mockedBackoffMs).mockClear();
});

afterEach(async () => {
  await stopServer();
});

describe('AlchemyEvmSubscriptionClient (mock WebSocket wire protocol)', () => {
  it('establishes a connection to the given wsUrl', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    await client.connect();
    await waitFor(() => serverSockets.length === 1);
    expect(serverSockets).toHaveLength(1);
    await client.close();
  });

  it('sends a well-formed eth_subscribe(logs) request with the USDT contract and Transfer topic0', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    await client.connect();
    await client.subscribe([WATCHED_FROM]);
    await waitFor(() => receivedMessages.length === 1);

    const req = JSON.parse(receivedMessages[0].raw);
    expect(req.method).toBe('eth_subscribe');
    expect(req.params[0]).toBe('logs');
    expect(req.params[1].address).toBe(USDT_CONTRACT);
    expect(req.params[1].topics).toEqual([TRANSFER_TOPIC0]);
    await client.close();
  });

  it('handles an eth_subscribe confirmation response (no params.result) without crashing or emitting', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_FROM]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xmocksubid' }));
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toHaveLength(0);
    await client.close();
  });

  it('parses a USDT Transfer log event and emits a MonitorEvent for the watched sender (direction out)', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_FROM]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(transferLogMessage(WATCHED_FROM, WATCHED_TO, 1_000_000n, '0xtx1'));
    await waitFor(() => received.length === 1);

    expect(received[0]).toMatchObject({ chain: 'ETH', addr: WATCHED_FROM, direction: 'out', counterparty: WATCHED_TO, txHash: '0xtx1', amount: '1000000', token: USDT_CONTRACT });
    await client.close();
  });

  it('parses the same log event for the watched receiver (direction in) when only `to` is watched', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_TO]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(transferLogMessage(WATCHED_FROM, WATCHED_TO, 500n, '0xtx2'));
    await waitFor(() => received.length === 1);

    expect(received[0]).toMatchObject({ addr: WATCHED_TO, direction: 'in', counterparty: WATCHED_FROM, amount: '500' });
    await client.close();
  });

  it('emits nothing when neither side of the transfer is watched (server-independent client-side filtering)', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe(['0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead']);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(transferLogMessage(WATCHED_FROM, WATCHED_TO, 500n, '0xtx3'));
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toHaveLength(0);
    await client.close();
  });

  it('emits two MonitorEvents (out + in) when a transfer moves between two watched addresses', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_FROM, WATCHED_TO]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(transferLogMessage(WATCHED_FROM, WATCHED_TO, 500n, '0xtx4'));
    await waitFor(() => received.length === 2);

    expect(received.map((e) => e.direction).sort()).toEqual(['in', 'out']);
    await client.close();
  });

  it('malformed JSON on the wire is ignored, not thrown, and does not stop later valid messages', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_FROM]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send('{ this is not valid json');
    serverSockets[0].send(transferLogMessage(WATCHED_FROM, WATCHED_TO, 1n, '0xtx5'));
    await waitFor(() => received.length === 1);

    expect(received[0].txHash).toBe('0xtx5');
    await client.close();
  });

  it('a log with fewer than 3 topics (malformed/incomplete Transfer log) is ignored', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_FROM]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { result: { topics: [TRANSFER_TOPIC0], data: '0x0', transactionHash: '0xbad' } } }));
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toHaveLength(0);
    await client.close();
  });

  it('reconnects with bounded backoff after the server closes the connection, and restores the subscription (watched addresses still filtered correctly)', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_FROM]);
    await waitFor(() => serverSockets.length === 1);
    await waitFor(() => receivedMessages.length === 1); // first eth_subscribe

    serverSockets[0].close();
    await waitFor(() => serverSockets.length === 2, 3000); // reconnected

    expect(mockedBackoffMs).toHaveBeenCalledWith(0);
    await waitFor(() => receivedMessages.length === 2, 3000); // subscription restored on the new connection
    const restored = JSON.parse(receivedMessages[1].raw);
    expect(restored.params[1].address).toBe(USDT_CONTRACT);

    serverSockets[1].send(transferLogMessage(WATCHED_FROM, WATCHED_TO, 42n, '0xtx6'));
    await waitFor(() => received.length === 1);
    expect(received[0].txHash).toBe('0xtx6');

    await client.close();
  }, 10_000);

  it('backoff attempt counter grows across consecutive drops and resets to 0 after a successful reconnect', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    await client.connect();
    await client.subscribe([WATCHED_FROM]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].close();
    await waitFor(() => serverSockets.length === 2, 3000);
    expect(mockedBackoffMs).toHaveBeenNthCalledWith(1, 0);

    serverSockets[1].close();
    await waitFor(() => serverSockets.length === 3, 3000);
    expect(mockedBackoffMs).toHaveBeenNthCalledWith(2, 0); // reset to 0 after the first successful reconnect's 'open'

    await client.close();
  }, 10_000);

  it('the same event delivered twice on the wire (duplicate log) is emitted twice by the client -- dedup is the pipeline layer\'s job, not the client\'s', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.connect();
    await client.subscribe([WATCHED_FROM]);
    await waitFor(() => serverSockets.length === 1);

    const msg = transferLogMessage(WATCHED_FROM, WATCHED_TO, 7n, '0xtxdup');
    serverSockets[0].send(msg);
    serverSockets[0].send(msg);
    await waitFor(() => received.length === 2);

    expect(received[0].txHash).toBe('0xtxdup');
    expect(received[1].txHash).toBe('0xtxdup');
    await client.close();
  });

  it('close() stops reconnect attempts (no further connection after an intentional close)', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    await client.connect();
    await waitFor(() => serverSockets.length === 1);

    await client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(serverSockets).toHaveLength(1); // no reconnect after an intentional close
  });

  it('a transfer received over the real (mocked-wire) client reaches the B8 monitoring pipeline and produces an alert', async () => {
    const client = new AlchemyEvmSubscriptionClient(`ws://127.0.0.1:${port}`, 'ETH', USDT_CONTRACT);
    const alerts: (CreatedAlert & { metadata?: unknown })[] = [];
    let idSeq = 0;
    const prisma: PushHandlerPrisma = {
      watchlistItem: { findMany: async ({ where }) => (where.chain === 'ETH' && where.addr === WATCHED_FROM ? [{ caseId: 'case-evm' }] : []) },
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

    // The Alchemy client never populates MonitorEvent.usd (Alchemy's logs subscription carries no
    // price), so A1's USD-threshold check cannot fire off a real push -- see the B8 report's known
    // limitations. A2 (VASP landing) has no USD dependency, so it's what a live EVM push CAN trigger
    // end to end today.
    client.on('transfer', (e) =>
      void handlePushMonitorEvent(
        { prisma, publish, ruleCtx: { findVasp: async (_chain, addr) => (addr === WATCHED_TO ? { name: 'Fixture Exchange' } : null), findObfuscation: async () => null }, stateCtx: { getSharedMule: async () => null, getBlacklistState: async () => null, a4AlreadyFired: async () => false, a5AlreadyFired: async () => false }, isNewEvent },
        e,
      ),
    );

    await client.connect();
    await client.subscribe([WATCHED_FROM]);
    await waitFor(() => serverSockets.length === 1);

    serverSockets[0].send(transferLogMessage(WATCHED_FROM, WATCHED_TO, 20_000_000_000n, '0xtxpipeline'));
    await waitFor(() => alerts.length === 1);

    expect(alerts[0].rule).toBe('A2_VASP_LANDING');
    expect(alerts[0].caseId).toBe('case-evm');
    expect(published).toHaveLength(1);
    expect(published[0].event).toBe('alert.new');

    await client.close();
  });
});
