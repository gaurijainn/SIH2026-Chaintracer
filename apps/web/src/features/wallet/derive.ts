import type { GNode, GraphModel } from '@/features/graph/model';

/** Everything here is computed from transfers the graph API already returned for this trace. Nothing is invented or fetched. */
export interface Transfer {
  id: string;
  direction: 'in' | 'out';
  counterparty: string;
  counterpartyChain: string;
  ts: number;
  usd: number | null;
  amount: string;
  token: string;
  txHash: string;
  crossChain: boolean;
}

const split = (id: string) => ({ chain: id.slice(0, id.indexOf(':')), addr: id.slice(id.indexOf(':') + 1) });

export function walletTransfers(graph: GraphModel, node: GNode): Transfer[] {
  const out: Transfer[] = [];
  for (const e of graph.edges) {
    if (e.source !== node.id && e.target !== node.id) continue;
    const direction = e.source === node.id ? 'out' : 'in';
    const other = split(direction === 'out' ? e.target : e.source);
    out.push({ id: e.id, direction, counterparty: other.addr, counterpartyChain: other.chain, ts: e.ts, usd: e.usd, amount: e.amount, token: e.token, txHash: e.txHash, crossChain: e.crossChain });
  }
  return out.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

export interface Counterparty {
  id: string;
  address: string;
  chain: string;
  label: string | null;
  inCount: number;
  outCount: number;
  inUsd: number;
  outUsd: number;
  transfers: number;
  latest: number;
}

/** One row per counterparty address, aggregated over this wallet's transfers in the trace. */
export function counterparties(graph: GraphModel, node: GNode): Counterparty[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const by = new Map<string, Counterparty>();
  for (const t of walletTransfers(graph, node)) {
    const id = `${t.counterpartyChain}:${t.counterparty}`;
    const row = by.get(id) ?? { id, address: t.counterparty, chain: t.counterpartyChain, label: nodes.get(id)?.label ?? null, inCount: 0, outCount: 0, inUsd: 0, outUsd: 0, transfers: 0, latest: 0 };
    if (t.direction === 'in') {
      row.inCount++;
      row.inUsd += t.usd ?? 0;
    } else {
      row.outCount++;
      row.outUsd += t.usd ?? 0;
    }
    row.transfers++;
    row.latest = Math.max(row.latest, t.ts);
    by.set(id, row);
  }
  return [...by.values()].sort((a, b) => b.inUsd + b.outUsd - (a.inUsd + a.outUsd) || a.id.localeCompare(b.id));
}

/** IST calendar day (yyyy-mm-dd) of an instant. */
export const istDay = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);

export interface DayBucket {
  day: string;
  inUsd: number;
  outUsd: number;
  inCount: number;
  outCount: number;
}

export function dailyActivity(transfers: Transfer[]): DayBucket[] {
  const by = new Map<string, DayBucket>();
  for (const t of transfers) {
    const day = istDay(t.ts);
    const b = by.get(day) ?? { day, inUsd: 0, outUsd: 0, inCount: 0, outCount: 0 };
    if (t.direction === 'in') {
      b.inUsd += t.usd ?? 0;
      b.inCount++;
    } else {
      b.outUsd += t.usd ?? 0;
      b.outCount++;
    }
    by.set(day, b);
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Bands as the app defines them (0-29 Low, 30-59 Medium, 60-79 High, 80-100 Critical), used only to draw the gauge scale. */
export const BAND_RANGES = [
  { band: 'LOW', from: 0, to: 29 },
  { band: 'MEDIUM', from: 30, to: 59 },
  { band: 'HIGH', from: 60, to: 79 },
  { band: 'CRITICAL', from: 80, to: 100 },
] as const;
