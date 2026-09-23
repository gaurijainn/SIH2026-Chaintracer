import type { Chain } from './constants';

/**
 * B8 real-time monitoring. Redis pub/sub channel the monitor worker publishes alerts on; apps/api's
 * Socket.IO relay (realtime/socket.ts) subscribes on this alongside TRACE_EVENTS_CHANNEL and emits
 * into the same `case:<caseId>` room, so the dashboard receives both trace.* and alert.* events on
 * one connection.
 */
export const ALERT_EVENTS_CHANNEL = 'alert:events';

export type AlertRuleCode = 'A1_MOVEMENT' | 'A2_VASP_LANDING' | 'A3_OBFUSCATION' | 'A4_LINKAGE' | 'A5_BLACKLIST';
export type AlertSeverityCode = 'INFO' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** PDF Section 7 contract: Socket.IO event `alert.new`, payload `{id, rule, severity, caseId, address, amount}`. */
export interface AlertNewEvent {
  id: string;
  rule: AlertRuleCode;
  severity: AlertSeverityCode;
  caseId: string;
  chain: Chain;
  address: string;
  amount: string | null;
}

export type AlertEventEnvelope = { event: 'alert.new'; payload: AlertNewEvent };

/**
 * Normalised shape a monitor source (TRON poller, EVM/BTC subscriber) hands to the B8 rule engine --
 * chain-agnostic, mirrors the B3 `Transfer` shape so the same rule code works across every chain.
 */
export interface MonitorEvent {
  chain: Chain;
  addr: string; // the watched address this event is about
  direction: 'in' | 'out';
  counterparty: string;
  txHash: string;
  token: string;
  amount: string;
  usd: number | null;
  ts: number; // epoch ms
}
