export interface DirectLabelRow {
  addr: string;
  vaspId: string | null;
  vaspName: string;
  confidence: number;
  source: string;
  name: string;
}

export interface DirectLabelMatch {
  vaspId: string;
  vaspName: string;
  confidence: number;
  evidence: { viaAddr: string; source: string; labelName: string };
}

/**
 * H4 (plan B5): a direct trusted label on the address itself, or on any address already known to
 * share its Bitcoin common-input cluster (H3). The caller resolves which addresses to check (the
 * target plus its cluster-mates) and passes in the labels already found for them.
 */
export function detectDirectLabelHit(labelsForAddrs: DirectLabelRow[]): DirectLabelMatch[] {
  return labelsForAddrs
    .filter((l): l is DirectLabelRow & { vaspId: string } => l.vaspId !== null)
    .map((l) => ({ vaspId: l.vaspId, vaspName: l.vaspName, confidence: l.confidence, evidence: { viaAddr: l.addr, source: l.source, labelName: l.name } }));
}
