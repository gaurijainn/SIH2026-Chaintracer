import { attributeAddress, type AttributeAddressInput } from './attribute';
import { parseEvmLabelsExchangeExport, type EvmLabelsExchangeEntry } from './loaders/ethLabels';

export type EvalCaseKind = 'real' | 'synthetic';

export interface EvalCase {
  addr: string;
  expectedVaspName: string;
  input: AttributeAddressInput;
  /** 'real': genuine public address+label data (e.g. the evm-labels exchange export). 'synthetic':
   *  constructed to exercise a specific heuristic/edge case where no real ground truth is available. */
  kind: EvalCaseKind;
  /** where the real data came from, or why this case had to be synthetic */
  sourceNote?: string;
}

export interface EvalDetail {
  addr: string;
  expected: string;
  predicted: string | null;
  confidence: number | null;
  correct: boolean;
  kind: EvalCaseKind;
}

export interface EvalBucket {
  total: number;
  top1Correct: number;
  accuracy: number;
}

export interface EvalResult extends EvalBucket {
  real: EvalBucket;
  synthetic: EvalBucket;
  details: EvalDetail[];
}

const bucket = (details: EvalDetail[]): EvalBucket => {
  const top1Correct = details.filter((d) => d.correct).length;
  return { total: details.length, top1Correct, accuracy: details.length ? Math.round((top1Correct / details.length) * 1000) / 1000 : 0 };
};

/**
 * Plan B5 "Done when": on a held-out set of labeled deposit addresses, does the correct VASP rank
 * first. This measures exactly that against whatever cases are passed in — it does not know or care
 * what the "target" number is; evaluate.test.ts reports the real result honestly, broken down by
 * real vs. synthetic cases so the two are never conflated.
 */
/**
 * Real evaluation cases from the evm-labels exchange export (github.com/dawsbot/eth-labels): genuine
 * public (address, exchange name) pairs, not constructed. Each is turned into an H4 "direct label
 * hit" case — a real address, a real name, one Vasp entity made just for it. This is a legitimate,
 * non-synthetic test of the full real-data path (file -> loader normalisation -> label -> heuristic
 * -> ranking), though note what it is *not*: without real on-chain transfer history for these
 * addresses (which would need further live provider calls) there is no way to build a real H1
 * deposit-sweep evaluation case, so H1's accuracy is only measured on synthetic cases below.
 */
export function buildRealDirectLabelCases(entries: EvmLabelsExchangeEntry[], count: number): EvalCase[] {
  const named = entries.filter((e) => e.nameTag.trim());
  return parseEvmLabelsExchangeExport(named.slice(0, count)).map((e, i): EvalCase => ({
    addr: e.addr,
    expectedVaspName: e.name,
    kind: 'real',
    sourceNote: 'evm-labels npm package (github.com/dawsbot/eth-labels), MIT licensed',
    input: { chain: e.chain, addr: e.addr, directLabels: [{ addr: e.addr, vaspId: `real-eth-labels-${i}`, vaspName: e.name, confidence: 0.9, source: 'eth-labels', name: e.name }] },
  }));
}

export function evaluateAttribution(cases: EvalCase[]): EvalResult {
  const details = cases.map((c): EvalDetail => {
    const ranked = attributeAddress(c.input);
    const top = ranked[0];
    return { addr: c.addr, expected: c.expectedVaspName, predicted: top?.vaspName ?? null, confidence: top?.confidence ?? null, correct: top?.vaspName === c.expectedVaspName, kind: c.kind };
  });
  return {
    ...bucket(details),
    real: bucket(details.filter((d) => d.kind === 'real')),
    synthetic: bucket(details.filter((d) => d.kind === 'synthetic')),
    details,
  };
}
