import type { BootstrapLabelRow, ConflictResolver } from './types';

/**
 * Builds a ConflictResolver from an explicit source-priority list (highest-trust first). Resolves
 * a conflict only when every conflicting entry's source is named in `priority` and there is a
 * single, unambiguous highest-priority source among them; refuses (returns null, same as the
 * default no-resolver policy) otherwise. This is the only sanctioned way to auto-resolve a
 * conflict -- "explicitly compatible sources", never a fuzzy heuristic -- so a caller who wants,
 * say, an OFAC hit to override a heuristic manual-negative guess must say so by name.
 */
export function sourcePriorityResolver(priority: string[]): ConflictResolver {
  const rank = new Map(priority.map((s, i) => [s, i]));
  return (entries: BootstrapLabelRow[]): BootstrapLabelRow | null => {
    if (entries.some((e) => !rank.has(e.source))) return null;
    const bestRank = Math.min(...entries.map((e) => rank.get(e.source)!));
    const atBestRank = entries.filter((e) => rank.get(e.source) === bestRank);
    // more than one source shares the best rank and they disagree on the label: still ambiguous.
    if (new Set(atBestRank.map((e) => e.label)).size > 1) return null;
    return atBestRank[0];
  };
}
