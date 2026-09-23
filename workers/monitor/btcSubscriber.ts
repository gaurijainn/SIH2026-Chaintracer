import WebSocket from 'ws';
import type { MonitorEvent } from '@ps26183/shared';
import { backoffMs, FixtureReplaySubscriptionClient, type SubscriptionClient } from './subscriptionClient';

interface MempoolAddressTx {
  txid: string;
  vin: { prevout?: { scriptpubkey_address?: string; value: number } }[];
  vout: { scriptpubkey_address?: string; value: number }[];
  status: { block_time?: number };
}

/**
 * Real mempool.space WebSocket client: `{"track-addresses": [...]}` (mempool.space's address-tracking
 * protocol), receiving `{address-transactions: [...]}` push messages. Reconnects with bounded
 * exponential backoff. Never constructed or connected except when DATA_MODE==='live' -- no live calls
 * happen in tests.
 */
export class MempoolBtcSubscriptionClient implements SubscriptionClient {
  private ws: WebSocket | null = null;
  private handlers: ((e: MonitorEvent) => void)[] = [];
  private watched = new Set<string>();
  private reconnectAttempt = 0;
  private closed = false;

  constructor(private readonly wsUrl: string) {}

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
        setTimeout(() => void this.connect().then(() => this.subscribe([...this.watched])).catch((e) => console.error('btc ws reconnect failed', e)), delay);
      });
      ws.on('message', (data) => this.handleMessage(data.toString()));
    });
  }

  async subscribe(addresses: string[]): Promise<void> {
    this.watched = new Set(addresses);
    if (!this.ws) return;
    this.ws.send(JSON.stringify({ 'track-addresses': addresses }));
  }

  on(event: 'transfer', handler: (e: MonitorEvent) => void): void {
    if (event === 'transfer') this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ws?.close();
  }

  private handleMessage(raw: string): void {
    let msg: { 'address-transactions'?: MempoolAddressTx[]; 'block-transactions'?: MempoolAddressTx[] };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const txs = msg['address-transactions'] ?? [];
    for (const tx of txs) {
      const ts = (tx.status.block_time ?? Math.floor(Date.now() / 1000)) * 1000;
      for (const out of tx.vout) {
        const addr = out.scriptpubkey_address;
        if (addr && this.watched.has(addr)) {
          const fromAddr = tx.vin[0]?.prevout?.scriptpubkey_address ?? 'unknown';
          this.emit({ chain: 'BTC', addr, direction: 'in', counterparty: fromAddr, txHash: tx.txid, token: 'BTC', amount: String(out.value), usd: null, ts });
        }
      }
      for (const inp of tx.vin) {
        const addr = inp.prevout?.scriptpubkey_address;
        if (addr && this.watched.has(addr)) {
          const toAddr = tx.vout[0]?.scriptpubkey_address ?? 'unknown';
          this.emit({ chain: 'BTC', addr, direction: 'out', counterparty: toAddr, txHash: tx.txid, token: 'BTC', amount: String(inp.prevout?.value ?? 0), usd: null, ts });
        }
      }
    }
  }

  private emit(e: MonitorEvent): void {
    for (const h of this.handlers) h(e);
  }
}

export interface BtcSubscriptionEnv {
  DATA_MODE: 'live' | 'record' | 'replay';
  FIXTURES_DIR: string;
}

export function createBtcSubscriptionClient(env: BtcSubscriptionEnv): SubscriptionClient {
  if (env.DATA_MODE === 'live') {
    return new MempoolBtcSubscriptionClient('wss://mempool.space/api/v1/ws');
  }
  return new FixtureReplaySubscriptionClient(`${env.FIXTURES_DIR}/monitor/btc-ws-fixture.json`);
}
