import type { AccountMeta, Chain, Transfer } from '@ps26183/shared';
import { noisyOr } from './confidence';
import { detectDepositSweep, type KnownHotWallet } from './heuristics/depositSweep';
import { detectDirectLabelHit, type DirectLabelRow } from './heuristics/directLabel';
import { detectTronActivation, type KnownActivator } from './heuristics/tronActivation';
import type { AttributionCandidate, HeuristicResult } from './types';

export interface AttributeAddressInput {
  chain: Chain;
  addr: string;
  /** H1: transfers into/out of `addr`. Omit if not available (e.g. not yet fetched). */
  inflows?: Transfer[];
  outflows?: Transfer[];
  knownHotWallets?: KnownHotWallet[];
  /** H2 (TRON only). */
  accountMeta?: AccountMeta;
  knownActivators?: KnownActivator[];
  /** H4: labels already resolved for `addr` and (for BTC) its H3 cluster-mates. */
  directLabels?: DirectLabelRow[];
}

/**
 * Runs H1/H2/H4 against one address (H3 is a separate pre-step — see heuristics/btcClustering.ts —
 * that expands which addresses directLabels should cover) and combines every fired heuristic per
 * candidate VASP with noisy-OR into a ranked list of AttributionCandidate.
 */
export function attributeAddress(input: AttributeAddressInput): AttributionCandidate[] {
  const fired: HeuristicResult[] = [];

  if (input.inflows && input.outflows) {
    for (const m of detectDepositSweep(input.inflows, input.outflows, input.knownHotWallets ?? [])) {
      fired.push({ code: 'H1_DEPOSIT_SWEEP', vaspId: m.vaspId, vaspName: m.vaspName, confidence: m.confidence, evidence: m.evidence });
    }
  }
  if (input.accountMeta) {
    for (const m of detectTronActivation(input.accountMeta, input.knownActivators ?? [])) {
      fired.push({ code: 'H2_TRON_ACTIVATION', vaspId: m.vaspId, vaspName: m.vaspName, confidence: m.confidence, evidence: m.evidence });
    }
  }
  for (const m of detectDirectLabelHit(input.directLabels ?? [])) {
    fired.push({ code: 'H4_DIRECT_LABEL', vaspId: m.vaspId, vaspName: m.vaspName, confidence: m.confidence, evidence: m.evidence });
  }

  const byVasp = new Map<string, HeuristicResult[]>();
  for (const h of fired) byVasp.set(h.vaspId, [...(byVasp.get(h.vaspId) ?? []), h]);

  const candidates: AttributionCandidate[] = [...byVasp.entries()].map(([vaspId, heuristics]) => ({
    chain: input.chain,
    addr: input.addr,
    vaspId,
    vaspName: heuristics[0].vaspName,
    confidence: noisyOr(heuristics.map((h) => h.confidence)),
    heuristics,
  }));
  return candidates.sort((a, b) => b.confidence - a.confidence);
}
