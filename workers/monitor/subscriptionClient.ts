import { readFileSync } from 'node:fs';
import type { MonitorEvent } from '@ps26183/shared';

/**
 * Swappable WebSocket-subscription client interface for B8's EVM (Alchemy `eth_subscribe('logs')`)
 * and BTC (mempool.space address tracking) push monitoring. HTTP polling (TRON) does not need this --
 * it reuses the existing B3 `ChainAdapter.getTransfers` incremental-poll support directly.
 */
export interface SubscriptionClient {
  connect(): Promise<void>;
  /** Narrows server-side filtering to exactly these watched addresses (topic filter / address list). */
  subscribe(addresses: string[]): Promise<void>;
  on(event: 'transfer', handler: (e: MonitorEvent) => void): void;
  close(): Promise<void>;
}

/**
 * Replay/fixture implementation: reads a small JSON fixture of pre-normalised MonitorEvent objects
 * (parsing a provider's raw wire format is the *live* client's job, not the fixture's) and emits the
 * ones matching the subscribed address set, once, asynchronously (not synchronously inside
 * `subscribe()`, so callers that attach `.on('transfer', ...)` after calling `subscribe()` still see
 * every event -- mirrors how a real async WS message would arrive after the subscribe confirmation).
 * Selected via DATA_MODE (live/record/replay), consistent with the rest of the codebase's provider
 * layer; never opens a socket, so it is always safe to construct and use in tests.
 */
export class FixtureReplaySubscriptionClient implements SubscriptionClient {
  private handlers: ((e: MonitorEvent) => void)[] = [];
  private events: MonitorEvent[];
  private timer: NodeJS.Timeout | null = null;

  constructor(fixturePath: string, private readonly delayMs = 0) {
    const raw = readFileSync(fixturePath, 'utf8');
    this.events = JSON.parse(raw) as MonitorEvent[];
  }

  async connect(): Promise<void> {
    // no-op: no network in replay mode
  }

  async subscribe(addresses: string[]): Promise<void> {
    const watched = new Set(addresses);
    const matching = this.events.filter((e) => watched.has(e.addr));
    const emit = () => {
      for (const e of matching) for (const h of this.handlers) h(e);
    };
    if (this.delayMs > 0) this.timer = setTimeout(emit, this.delayMs);
    else setImmediate(emit);
  }

  on(event: 'transfer', handler: (e: MonitorEvent) => void): void {
    if (event === 'transfer') this.handlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.handlers = [];
  }
}

/** Bounded exponential backoff for real WS reconnects: 1s, 2s, 4s, ... capped at 30s. */
export function backoffMs(attempt: number, capMs = 30_000): number {
  return Math.min(1000 * 2 ** attempt, capMs);
}
