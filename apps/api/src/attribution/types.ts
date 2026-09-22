import type { Chain } from '@ps26183/shared';

/** Neutral vocabulary only (plan B5): never "criminal", just what the source actually says. */
export type LabelCategory = 'exchange' | 'instant_swap' | 'otc' | 'p2p' | 'mixer' | 'bridge' | 'sanctioned' | 'reported' | 'high_risk' | 'exchange_associated' | 'scam';

export type LabelSource = 'eth-labels' | 'tronscan' | 'ofac' | 'chainabuse' | 'manual';

/** What every loader produces; labelStore.upsertLabel() is the only thing that writes a Label row. */
export interface NormalizedLabel {
  chain: Chain;
  addr: string;
  name: string;
  category: LabelCategory;
  source: LabelSource;
  confidence: number;
  /** Source reference: report URL, tx hash, raw flag payload, etc. JSON-serialisable. */
  evidence?: unknown;
  vaspId?: string;
}

export const HEURISTIC_CODES = ['H1_DEPOSIT_SWEEP', 'H2_TRON_ACTIVATION', 'H3_BTC_COMMON_INPUT', 'H4_DIRECT_LABEL'] as const;
export type HeuristicCode = (typeof HEURISTIC_CODES)[number];

export interface HeuristicResult {
  code: HeuristicCode;
  vaspId: string;
  vaspName: string;
  confidence: number;
  evidence: unknown;
}

export interface AttributionCandidate {
  chain: Chain;
  addr: string;
  vaspId: string;
  vaspName: string;
  /** noisy-OR combination of every fired heuristic's confidence for this VASP */
  confidence: number;
  heuristics: HeuristicResult[];
}
