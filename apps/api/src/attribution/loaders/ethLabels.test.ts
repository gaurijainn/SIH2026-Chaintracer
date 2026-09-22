import { describe, expect, it } from 'vitest';
import { evmChecksum } from '@ps26183/shared';
import type { LabelPrisma } from '../labelStore';
import { DEFAULT_ETH_LABELS_FILE, loadEthLabelsFile, normalizeEthLabels, parseEvmLabelsExchangeExport } from './ethLabels';

describe('normalizeEthLabels', () => {
  it('maps entries to Label rows with source eth-labels and a fixed confidence', () => {
    const labels = normalizeEthLabels([{ chain: 'ETH', addr: '0xE1', name: 'Big Exchange', category: 'exchange' }]);
    expect(labels).toEqual([{ chain: 'ETH', addr: '0xE1', name: 'Big Exchange', category: 'exchange', source: 'eth-labels', confidence: 0.9, evidence: { source: 'eth-labels' } }]);
  });
});

describe('parseEvmLabelsExchangeExport', () => {
  it('checksums the address and tags every entry as an ETH exchange', () => {
    const [e] = parseEvmLabelsExchangeExport([{ address: '0x2ddd202174a72514ed522e77972b461b03155525', nameTag: 'Alcumex Exchange' }]);
    expect(e).toMatchObject({ chain: 'ETH', addr: evmChecksum('0x2ddd202174a72514ed522e77972b461b03155525'), name: 'Alcumex Exchange', category: 'exchange' });
  });

  it('gives an entry with no nameTag a clear placeholder name instead of an empty string', () => {
    const [e] = parseEvmLabelsExchangeExport([{ address: '0x1ccbdff6336b1027995a27a77b41fa87eb6608a3', nameTag: '' }]);
    expect(e.name).toBe('Unnamed exchange address (evm-labels)');
  });
});

function fakeLabelPrisma() {
  const rows: Record<string, unknown>[] = [];
  const prisma: LabelPrisma = { label: { async upsert({ create }) { rows.push(create); return create; } } };
  return { prisma, rows };
}

describe('loadEthLabelsFile', () => {
  it('loads the real, committed evm-labels exchange export (372 named Ethereum exchange addresses)', async () => {
    const { prisma, rows } = fakeLabelPrisma();
    const n = await loadEthLabelsFile(prisma, DEFAULT_ETH_LABELS_FILE);
    expect(n).toBe(372);
    expect(rows.every((r) => r.source === 'eth-labels' && r.category === 'exchange' && r.chain === 'ETH')).toBe(true);
    expect(rows.some((r) => r.name === 'Alcumex Exchange')).toBe(true);
  });
});
