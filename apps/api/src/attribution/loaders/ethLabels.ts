import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { evmChecksum, type Chain } from '@ps26183/shared';
import { upsertLabels, type LabelPrisma } from '../labelStore';
import type { LabelCategory, NormalizedLabel } from '../types';

/**
 * eth-labels (github.com/dawsbot/eth-labels). The project's own dataset ships as a ~40 MB SQLite
 * export with no small per-category file at a stable path, but it also publishes the same "exchange"
 * category as its npm package `evm-labels` (MIT licensed): 372 real, named Ethereum exchange
 * addresses at lib/esm/mainnet/exchange/all.json, ~40 KB. That file — not the SQLite dump — is what
 * is downloaded here (data/labels/eth-labels/raw/exchange_all.json, plus its LICENSE), which keeps
 * to the "no large automatic downloads" rule while still being real, public, named data.
 */
export interface EthLabelEntry {
  chain: Chain;
  addr: string;
  name: string;
  category: LabelCategory;
  evidence?: unknown;
}

/** The evm-labels npm package's raw export shape: [{address, nameTag}]. nameTag is "" for a handful of entries. */
export interface EvmLabelsExchangeEntry {
  address: string;
  nameTag: string;
}

export const DEFAULT_ETH_LABELS_FILE = fileURLToPath(new URL('../../../../../data/labels/eth-labels/raw/exchange_all.json', import.meta.url));

export function normalizeEthLabels(entries: EthLabelEntry[]): NormalizedLabel[] {
  return entries.map((e) => ({
    chain: e.chain,
    addr: e.addr,
    name: e.name,
    category: e.category,
    source: 'eth-labels',
    confidence: 0.9,
    evidence: e.evidence ?? { source: 'eth-labels' },
  }));
}

/** Converts the real evm-labels export into our generic EthLabelEntry shape (all "exchange", chain ETH). */
export function parseEvmLabelsExchangeExport(raw: EvmLabelsExchangeEntry[]): EthLabelEntry[] {
  return raw.map((r) => ({
    chain: 'ETH',
    addr: evmChecksum(r.address),
    name: r.nameTag.trim() || 'Unnamed exchange address (evm-labels)',
    category: 'exchange',
    evidence: { source: 'evm-labels npm package (github.com/dawsbot/eth-labels)', rawAddress: r.address },
  }));
}

export async function loadEthLabelsFile(prisma: LabelPrisma, file: string = DEFAULT_ETH_LABELS_FILE): Promise<number> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as EvmLabelsExchangeEntry[];
  const labels = normalizeEthLabels(parseEvmLabelsExchangeExport(raw));
  await upsertLabels(prisma, labels);
  return labels.length;
}
