import WebSocket from 'ws';
import type { Chain, MonitorEvent } from '@ps26183/shared';
import { backoffMs, FixtureReplaySubscriptionClient, type SubscriptionClient } from './subscriptionClient';

/** keccak256("Transfer(address,address,uint256)") -- ERC-20/TRC-20-style Transfer event topic0. */
export const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`;
}
function addressToTopic(addr: string): string {
  return `0x${addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/**
 * Real Alchemy WebSocket client: `eth_subscribe('logs', {address: usdtContract, topics: [TRANSFER_TOPIC0]})`.
 * Narrowing to specific watched wallets happens client-side on the decoded `from`/`to` (Alchemy's
 * `topics` filter only supports OR-within-position, and watching thousands of wallets as topic[1]/[2]
 * OR-lists is impractical at this scale) -- still a single subscription per chain, not one per wallet.
 * Reconnects with bounded exponential backoff (see backoffMs). Never constructed or connected except
 * when DATA_MODE==='live' (see createEvmSubscriptionClient below) -- no live calls happen in tests.
 */
export class AlchemyEvmSubscriptionClient implements SubscriptionClient {
  private ws: WebSocket | null = null;
  private handlers: ((e: MonitorEvent) => void)[] = [];
  private watched = new Set<string>();
  private reconnectAttempt = 0;
  private closed = false;

  constructor(
    private readonly wsUrl: string,
    private readonly chain: Chain,
    private readonly usdtContract: string,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.once('open', () => {
        this.reconnectAttempt = 0;
        resolve();
      });
      ws.once('error', (e) => reject(e));
      ws.on('close', () => {
        if (this.closed) return;
        const delay = backoffMs(this.reconnectAttempt++);
        setTimeout(() => void this.connect().then(() => this.subscribe([...this.watched])).catch((e) => console.error('evm ws reconnect failed', e)), delay);
      });
      ws.on('message', (data) => this.handleMessage(data.toString()));
    });
  }

  async subscribe(addresses: string[]): Promise<void> {
    this.watched = new Set(addresses.map((a) => a.toLowerCase()));
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: ['logs', { address: this.usdtContract, topics: [TRANSFER_TOPIC0] }],
      }),
    );
  }

  on(event: 'transfer', handler: (e: MonitorEvent) => void): void {
    if (event === 'transfer') this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ws?.close();
  }

  private handleMessage(raw: string): void {
    let msg: { params?: { result?: { topics: string[]; data: string; transactionHash: string } } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const log = msg.params?.result;
    if (!log || log.topics.length < 3) return;
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    const amount = BigInt(log.data).toString();
    const ts = Date.now(); // Alchemy logs subscription doesn't carry block time; caller may re-fetch block if exact ts matters
    if (this.watched.has(from.toLowerCase())) {
      this.emit({ chain: this.chain, addr: from, direction: 'out', counterparty: to, txHash: log.transactionHash, token: this.usdtContract, amount, usd: null, ts });
    }
    if (this.watched.has(to.toLowerCase())) {
      this.emit({ chain: this.chain, addr: to, direction: 'in', counterparty: from, txHash: log.transactionHash, token: this.usdtContract, amount, usd: null, ts });
    }
  }

  private emit(e: MonitorEvent): void {
    for (const h of this.handlers) h(e);
  }
}

export interface EvmSubscriptionEnv {
  DATA_MODE: 'live' | 'record' | 'replay';
  ALCHEMY_KEY?: string;
  FIXTURES_DIR: string;
}

/** addressToTopic is exported for tests that build synthetic Alchemy log fixtures. */
export { addressToTopic, topicToAddress };

export function createEvmSubscriptionClient(env: EvmSubscriptionEnv, chain: Chain, usdtContract: string): SubscriptionClient {
  if (env.DATA_MODE === 'live') {
    const wsUrl = `wss://${chain.toLowerCase()}-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;
    return new AlchemyEvmSubscriptionClient(wsUrl, chain, usdtContract);
  }
  return new FixtureReplaySubscriptionClient(`${env.FIXTURES_DIR}/monitor/evm-ws-fixture.json`);
}
