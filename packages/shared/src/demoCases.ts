import { createHash } from 'node:crypto';
import { USDT_TRC20 } from './constants';
import type { Transfer } from './chainTypes';

/**
 * B11 demo cases. Everything here is SYNTHETIC: addresses are checksum-valid TRON addresses derived from fixed
 * labels, the "victims" are fictitious, the exchanges are labelled "(synthetic)", and the acknowledgement/FIR
 * numbers carry a DEMO prefix. No real person, wallet or institution is represented.
 *
 * One golden case tells the whole story (complaint -> TRON trace -> VASP attribution -> risk -> monitoring alert ->
 * CRITICAL VASP landing -> freeze notice -> evidence report -> verification); two backups exercise different graph
 * shapes (fan-out/merge, longer layered chain) through the same pipeline so the demo survives a bad moment.
 *
 * The provider responses for these flows are recorded into fixtures/ (scripts/record-demo-fixtures.mts) and replayed
 * with DATA_MODE=replay, so the demo and its end-to-end test run with the network off.
 */

/** 2026-09-01 08:00 UTC: incident start; also the trace window start (TraceJob.createdAt is pinned to it in demos). */
export const DEMO_T0 = Date.UTC(2026, 8, 1, 8, 0, 0);
/** Fixed clock for the provider layer (pricing lookups) so recorded and replayed requests are identical. */
export const DEMO_CASE_NOW = DEMO_T0 + 2 * 86_400_000;

export interface DemoLeg {
  from: string;
  to: string;
  /** whole USDT units (decimals allowed) */
  usdt: number;
  /** minutes after DEMO_T0 */
  minute: number;
}

export interface DemoCase {
  key: 'golden' | 'backup-1' | 'backup-2';
  title: string;
  ackNo: string;
  firNumber: string;
  category: string;
  amountInr: string;
  reportedAt: string;
  victim: string;
  /** the address the (fictitious) victim names in the complaint: where the trace starts */
  seed: string;
  /** the last mule before the exchange; the address the analyst adds to the watchlist */
  watch: string;
  vasp: { name: string; type: 'CENTRALISED_EXCHANGE' | 'INSTANT_SWAP' | 'OTC' | 'P2P'; jurisdiction: string; fiuStatus: string; deposit: string; hotWallet: string };
  legs: DemoLeg[];
  /** addresses the trace must reach, in discovery order irrelevant */
  expectedAddresses: string[];
}

const A = {
  gVictim: 'TSGRWVhfi9CwEdh8vU7wU6WBFkkkpUyZPR',
  gM1: 'TGAUCNWRxH2XcHem63ME3yM3TYSPVUoicW',
  gM2: 'TSvDAxpQZkPvwafLzAjuZF3fsyTe3rH17T',
  gDep: 'THdbKZ9khHToEXDzLjudNhYJHmWb4fg3Ni',
  gHot: 'TQcCRAfkMD2dJHrJYXryexuJmxzCqDKvmL',
  gOther: 'TUKLs9Nw28SD98N8U96XoMiJhe5PmzCmDi', // an unrelated depositor: a real deposit address serves many senders
  b1Victim: 'TSxeRro7RU5EbMJiTwA2soDaF4fXvRASG2',
  b1M1: 'TJ9qwRoD4NQM9ccmdcEJzSU1YNwEX6jKym',
  b1M2a: 'TMF6aeQj3wxDbBCQmzScDiEB6qNZAUrsTr',
  b1M2b: 'TSaS1nmePkw45pzCLHMQgXnRKmy5Go2Ki5',
  b1Dep: 'TTjABErKzrceCQoj1i6eoPwescZx7RjQEZ',
  b1Hot: 'TMLaeEG5iwC5AdCh5NTP2QZjkmEZ8cJJmw',
  b2Victim: 'TStuKd1poN419vuBwo7Nrfk6hmKkJEFK3T',
  b2M1: 'TWPhFFMhMjgb8eXZtY97stLn8Ai5WRai5E',
  b2M2: 'TCkNivtWsa2mCGzUonBDAGpeEezwhEaa71',
  b2M3: 'TF8pNEmNuxfrqEmDRPPWRARxsoFjQWJsYr',
  b2Dep: 'TE44RZBm4wdHL9qUZFs41LUnnwZfx4bZ73',
  b2Hot: 'TV8eShq7QVeQKy7wNXd3zcGFBFq4F2nr4B',
  b2Other: 'TUXVoc4xN1XiST6wyVi25giaqyE5x9pv28',
} as const;

export const GOLDEN_CASE: DemoCase = {
  key: 'golden',
  title: 'DEMO golden case: investment fraud, funds land at a synthetic exchange',
  ackNo: 'DEMO-GOLDEN-0001',
  firNumber: 'DEMO/FIR/0001/2026',
  category: 'Investment fraud',
  amountInr: '500000.00',
  reportedAt: '2026-09-01T12:00:00.000Z',
  victim: A.gVictim,
  seed: A.gM1,
  watch: A.gM2,
  vasp: { name: 'Demo Exchange (synthetic)', type: 'CENTRALISED_EXCHANGE', jurisdiction: 'Demo', fiuStatus: 'REGISTERED', deposit: A.gDep, hotWallet: A.gHot },
  legs: [
    { from: A.gVictim, to: A.gM1, usdt: 5700, minute: 10 },
    { from: A.gM1, to: A.gM2, usdt: 5690.5, minute: 42 },
    { from: A.gOther, to: A.gDep, usdt: 1200, minute: 20 },
    { from: A.gM2, to: A.gDep, usdt: 5680.25, minute: 65 },
    { from: A.gDep, to: A.gHot, usdt: 6880.25, minute: 80 },
  ],
  expectedAddresses: [A.gM1, A.gM2, A.gDep],
};

export const BACKUP_CASE_1: DemoCase = {
  key: 'backup-1',
  title: 'DEMO backup 1: fan-out and merge into a synthetic instant-swap service',
  ackNo: 'DEMO-BACKUP-0001',
  firNumber: 'DEMO/FIR/0002/2026',
  category: 'Romance scam',
  amountInr: '700000.00',
  reportedAt: '2026-09-01T13:00:00.000Z',
  victim: A.b1Victim,
  seed: A.b1M1,
  watch: A.b1M2a,
  vasp: { name: 'Demo Instant Swap (synthetic)', type: 'INSTANT_SWAP', jurisdiction: 'Demo', fiuStatus: 'NOTICED', deposit: A.b1Dep, hotWallet: A.b1Hot },
  legs: [
    { from: A.b1Victim, to: A.b1M1, usdt: 8000, minute: 12 },
    { from: A.b1M1, to: A.b1M2a, usdt: 4800, minute: 30 },
    { from: A.b1M1, to: A.b1M2b, usdt: 3100, minute: 33 },
    { from: A.b1M2a, to: A.b1Dep, usdt: 4790, minute: 70 },
    { from: A.b1M2b, to: A.b1Dep, usdt: 3090, minute: 75 },
    { from: A.b1Dep, to: A.b1Hot, usdt: 7880, minute: 95 },
  ],
  expectedAddresses: [A.b1M1, A.b1M2a, A.b1M2b, A.b1Dep],
};

export const BACKUP_CASE_2: DemoCase = {
  key: 'backup-2',
  title: 'DEMO backup 2: longer layered chain into a synthetic OTC desk',
  ackNo: 'DEMO-BACKUP-0002',
  firNumber: 'DEMO/FIR/0003/2026',
  category: 'Job scam',
  amountInr: '220000.00',
  reportedAt: '2026-09-01T14:00:00.000Z',
  victim: A.b2Victim,
  seed: A.b2M1,
  watch: A.b2M3,
  vasp: { name: 'Demo OTC Desk (synthetic)', type: 'OTC', jurisdiction: 'Demo', fiuStatus: 'NOT_REGISTERED', deposit: A.b2Dep, hotWallet: A.b2Hot },
  legs: [
    { from: A.b2Victim, to: A.b2M1, usdt: 2500, minute: 15 },
    { from: A.b2M1, to: A.b2M2, usdt: 2480, minute: 40 },
    { from: A.b2M2, to: A.b2M3, usdt: 2460, minute: 90 },
    { from: A.b2Other, to: A.b2Dep, usdt: 800, minute: 100 },
    { from: A.b2M3, to: A.b2Dep, usdt: 2440, minute: 130 },
    { from: A.b2Dep, to: A.b2Hot, usdt: 3240, minute: 150 },
  ],
  expectedAddresses: [A.b2M1, A.b2M2, A.b2M3, A.b2Dep],
};

export const DEMO_CASES: DemoCase[] = [GOLDEN_CASE, BACKUP_CASE_1, BACKUP_CASE_2];

/** Deterministic 64-hex transaction hash for one leg. */
export const demoTxHash = (c: DemoCase, i: number): string => createHash('sha256').update(`ps26183-demo:${c.key}:${i}`).digest('hex');

/** The case's chain history as provider-agnostic transfers (USDT units, USD == USDT), in the shape the adapters return. */
export function demoTransfers(c: DemoCase): Transfer[] {
  return c.legs.map((l, i) => ({
    chain: 'TRON',
    txHash: demoTxHash(c, i),
    idx: 0,
    from: l.from,
    to: l.to,
    token: USDT_TRC20,
    amount: String(l.usdt), // token units, the adapters' normalised form (the provider's raw value is amount x 10^6)
    usd: l.usdt,
    ts: DEMO_T0 + l.minute * 60_000,
    block: 1_000_000 + i,
  })) as Transfer[];
}
