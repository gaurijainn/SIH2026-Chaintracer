import type { Chain } from '@ps26183/shared';
import { upsertLabel, type LabelPrisma } from '../labelStore';
import type { LabelCategory, NormalizedLabel } from '../types';

export interface ManualLabelInput {
  chain: Chain;
  addr: string;
  name: string;
  category: LabelCategory;
  /** An investigator's own confidence, 0-1. Defaults to 1 (a human directly asserted this). */
  confidence?: number;
  evidence?: unknown;
}

/** A manual label is still just a Label row (source: 'manual'); the unique key keeps a rerun idempotent. */
export async function insertManualLabel(prisma: LabelPrisma, input: ManualLabelInput): Promise<void> {
  const label: NormalizedLabel = {
    chain: input.chain,
    addr: input.addr,
    name: input.name,
    category: input.category,
    source: 'manual',
    confidence: input.confidence ?? 1,
    evidence: input.evidence,
  };
  await upsertLabel(prisma, label);
}
