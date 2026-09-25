import type { Chain } from '@ps26183/shared';
import { noisyOr } from '../../attribution/confidence';
import { computeMuleFeatures } from '../features';
import { normalizeAddressForChain } from './normalize';
import type { BootstrapLabelRow, ConfidenceTier, ConflictResolver, JoinReport, LabelConflict, TracedAddressProvider, TronTrainingRow } from './types';

const addrKey = (chain: string, addr: string): string => `${chain}:${addr}`;
function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

function confidenceTier(c: number): ConfidenceTier {
  if (c >= 0.8) return 'strong';
  if (c >= 0.5) return 'moderate';
  return 'weak';
}

/** Combines two or more label entries that already agree on the label value: never drops a source's
 * evidence, combines confidence the same way B5 combines independent heuristic evidence (noisy-OR),
 * and keeps the earliest fetchedAt (the first source to confirm it is the ground-truth moment). */
function combineAgreeing(entries: BootstrapLabelRow[]): BootstrapLabelRow {
  if (entries.length === 1) return entries[0];
  const [first] = entries;
  return {
    ...first,
    source: [...new Set(entries.map((e) => e.source))].sort().join('+'),
    confidence: noisyOr(entries.map((e) => e.confidence)),
    evidence: entries.map((e) => ({ source: e.source, evidence: e.evidence ?? null, confidence: e.confidence })),
    fetchedAt: [...entries].map((e) => e.fetchedAt).sort()[0],
  };
}

/**
 * Joins TRON bootstrap labels with B6's real, already-computed feature vectors for the same
 * address (plan B7.4 flow: bootstrap label -> normalize -> match traced address ->
 * computeMuleFeatures() -> training row). Never invents a label or a feature: an address with a
 * label but no trace data is reported in `unmatchedLabels`; a traced address with no confirmed
 * label is reported in `untracedAddresses`; neither ever appears in `rows`. Contradictory labels
 * for the same address are rejected into `conflicts` unless `resolveConflict` explicitly resolves
 * them (default: reject everything -- see conflict.ts's sourcePriorityResolver for the only
 * sanctioned way to opt in). Deterministic: every report list is sorted by (chain, address), so
 * re-running the join on the same input always produces byte-identical output.
 */
export function joinBootstrapLabels(
  labels: BootstrapLabelRow[],
  provider: TracedAddressProvider,
  opts: { resolveConflict?: ConflictResolver; chains?: Chain[] } = {},
): JoinReport {
  const resolveConflict = opts.resolveConflict ?? (() => null);
  const chains = opts.chains ?? ['TRON'];

  const invalidAddresses: BootstrapLabelRow[] = [];
  const byKey = new Map<string, BootstrapLabelRow[]>();

  for (const l of labels) {
    const normalized = normalizeAddressForChain(l.chain, l.address);
    if (normalized === null) {
      invalidAddresses.push(l);
      continue;
    }
    const key = addrKey(l.chain, normalized);
    byKey.set(key, [...(byKey.get(key) ?? []), { ...l, address: normalized }]);
  }

  const rows: TronTrainingRow[] = [];
  const conflicts: LabelConflict[] = [];
  const unmatchedLabels: BootstrapLabelRow[] = [];
  const matchedKeys = new Set<string>();

  for (const [key, entries] of byKey) {
    const [chain, address] = splitKey(key);
    const distinctLabels = new Set(entries.map((e) => e.label));

    let resolved: BootstrapLabelRow;
    if (distinctLabels.size === 1) {
      resolved = combineAgreeing(entries);
    } else {
      const attempt = resolveConflict(entries);
      if (attempt === null) {
        conflicts.push({ chain: chain as Chain, address, entries });
        continue;
      }
      resolved = attempt;
    }

    const inputs = provider.getFeatureInputs(chain as Chain, address);
    if (inputs === null) {
      unmatchedLabels.push(resolved);
      continue;
    }

    matchedKeys.add(key);
    rows.push({
      identifier: address,
      chain: chain as Chain,
      label: resolved.label,
      source: resolved.source,
      confidence: resolved.confidence,
      confidenceTier: confidenceTier(resolved.confidence),
      evidence: resolved.evidence ?? null,
      timestamp: resolved.fetchedAt,
      features: computeMuleFeatures(inputs), // B6's own production function; never reimplemented here
    });
  }

  const untracedAddresses: { chain: Chain; address: string }[] = [];
  for (const chain of chains) {
    for (const addr of provider.listTracedAddresses(chain)) {
      if (!matchedKeys.has(addrKey(chain, addr))) untracedAddresses.push({ chain, address: addr });
    }
  }

  const byChainAddr = <T extends { chain: Chain }>(getAddr: (t: T) => string) => (a: T, b: T) =>
    a.chain === b.chain ? getAddr(a).localeCompare(getAddr(b)) : a.chain.localeCompare(b.chain);

  rows.sort(byChainAddr((r) => r.identifier));
  unmatchedLabels.sort(byChainAddr((r) => r.address));
  invalidAddresses.sort(byChainAddr((r) => r.address));
  untracedAddresses.sort(byChainAddr((r) => r.address));
  conflicts.sort(byChainAddr((r) => r.address));

  return { rows, unmatchedLabels, untracedAddresses, conflicts, invalidAddresses };
}
