import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Chain } from '@ps26183/shared';
import { upsertLabels, type LabelPrisma } from '../labelStore';
import type { NormalizedLabel } from '../types';

/**
 * OFAC SDN digital-currency addresses (github.com/0xB10C/ofac-sanctioned-digital-currency-addresses,
 * `lists` branch). One plain-text file per asset, one address per line. Downloaded once (~37 KB
 * total across the 5 files below) into data/labels/ofac/raw/ rather than fetched live on every run.
 */
export interface OfacAsset {
  file: string;
  chain: Chain;
}

export const OFAC_ASSETS: OfacAsset[] = [
  { file: 'sanctioned_addresses_ETH.txt', chain: 'ETH' },
  { file: 'sanctioned_addresses_USDT.txt', chain: 'ETH' }, // USDT-ERC20 addresses are EVM (0x) format
  { file: 'sanctioned_addresses_BSC.txt', chain: 'BSC' },
  { file: 'sanctioned_addresses_TRX.txt', chain: 'TRON' },
  { file: 'sanctioned_addresses_XBT.txt', chain: 'BTC' },
];

export const DEFAULT_OFAC_DIR = fileURLToPath(new URL('../../../../../data/labels/ofac/raw', import.meta.url));

export function parseOfacAddresses(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function normalizeOfacAddresses(chain: Chain, addresses: string[], sourceFile: string): NormalizedLabel[] {
  return addresses.map((addr) => ({
    chain,
    addr,
    name: 'OFAC SDN',
    category: 'sanctioned',
    source: 'ofac',
    confidence: 1,
    evidence: { list: 'OFAC SDN digital-currency addresses', file: sourceFile, repo: 'github.com/0xB10C/ofac-sanctioned-digital-currency-addresses' },
  }));
}

/** Idempotent (labelStore upserts by the Label unique key); safe to rerun against the same files. */
export async function loadOfacDir(prisma: LabelPrisma, dir: string = DEFAULT_OFAC_DIR, assets: OfacAsset[] = OFAC_ASSETS): Promise<number> {
  let total = 0;
  for (const a of assets) {
    const p = path.join(dir, a.file);
    if (!existsSync(p)) continue;
    const text = await readFile(p, 'utf8');
    const labels = normalizeOfacAddresses(a.chain, parseOfacAddresses(text), a.file);
    await upsertLabels(prisma, labels);
    total += labels.length;
  }
  return total;
}
