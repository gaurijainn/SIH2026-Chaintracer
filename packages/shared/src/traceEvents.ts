import type { Chain } from './constants';

/** Redis pub/sub channel the trace worker publishes on; apps/api relays messages to Socket.IO rooms (`case:<caseId>`). */
export const TRACE_EVENTS_CHANNEL = 'trace:events';

export interface TraceProgressEvent {
  traceId: string;
  caseId: string;
  hopsDone: number;
  frontier: number;
  apiCalls: number;
}

export interface TraceHopEvent {
  traceId: string;
  caseId: string;
  edge: { chain: Chain; from: string; to: string; token: string; amount: string; usd: number | null; txHash: string; ts: number };
  fromNode: { chain: Chain; addr: string; hop: number };
  toNode: { chain: Chain; addr: string; hop: number };
}

export type TraceTerminalReason =
  | 'exchange'
  | 'mixer'
  | 'bridge_unresolved'
  | 'sanctioned'
  | 'max_hops'
  | 'high_degree_service';

export interface TraceTerminal {
  chain: Chain;
  addr: string;
  reason: TraceTerminalReason;
  label?: string;
}

export interface TraceCompletedEvent {
  traceId: string;
  caseId: string;
  terminals: TraceTerminal[];
  durationMs: number;
}

/** One envelope type published on TRACE_EVENTS_CHANNEL; apps/api discriminates on `event`. */
export type TraceEventEnvelope =
  | { event: 'trace.progress'; payload: TraceProgressEvent }
  | { event: 'trace.hop'; payload: TraceHopEvent }
  | { event: 'trace.completed'; payload: TraceCompletedEvent };
