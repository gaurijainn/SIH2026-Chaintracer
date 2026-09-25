import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BlacklistEvent } from '@ps26183/workers/adapters';
import type { BootstrapLabelRow } from '../training/types';
import { blacklistEventsToLabelRows, loadOfacTronLabelRows, mergeHighRiskLabelRows } from './highRisk';

const T0 = '2026-09-20T00:00:00.000Z';
const ADDR_A = 'TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ8M';
const ADDR_B = 'TAsspXacEqxsGAo8zbxwhJrZ7Jmhj9C33U';

describe('blacklistEventsToLabelRows', () => {
  it('groups multiple events for the same address into one high_risk row, keeping every event as evidence', () => {
    const events: BlacklistEvent[] = [
      { address: ADDR_A, txHash: 'a'.repeat(64), blockNumber: 1, blockTimestampMs: 100 },
      { address: ADDR_A, txHash: 'b'.repeat(64), blockNumber: 2, blockTimestampMs: 200 },
      { address: ADDR_B, txHash: 'c'.repeat(64), blockNumber: 3, blockTimestampMs: 300 },
    ];
    const rows = blacklistEventsToLabelRows(events, T0);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.label === 'high_risk' && r.source === 'usdt_blacklist')).toBe(true);
    const a = rows.find((r) => r.address === ADDR_A)!;
    expect((a.evidence as { eventCount: number }).eventCount).toBe(2);
  });

  it('is deterministic regardless of input order (sorted by address)', () => {
    const events: BlacklistEvent[] = [
      { address: ADDR_B, txHash: 'c'.repeat(64), blockNumber: 3, blockTimestampMs: 300 },
      { address: ADDR_A, txHash: 'a'.repeat(64), blockNumber: 1, blockTimestampMs: 100 },
    ];
    const rows = blacklistEventsToLabelRows(events, T0);
    expect(rows.map((r) => r.address)).toEqual([ADDR_A, ADDR_B].sort());
  });
});

describe('loadOfacTronLabelRows (0 network calls, local file only)', () => {
  it('reuses parseOfacAddresses/normalizeOfacAddresses to load the TRON OFAC file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ofac-test-'));
    await writeFile(path.join(dir, 'sanctioned_addresses_TRX.txt'), `${ADDR_A}\n${ADDR_B}\n`);
    const rows = await loadOfacTronLabelRows(T0, dir);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.label === 'high_risk' && r.source === 'ofac' && r.confidence === 1)).toBe(true);
    expect(rows.map((r) => r.address)).toEqual([ADDR_A, ADDR_B].sort());
  });

  it('returns an empty list when the local OFAC dir/file is absent (never fails, never fetches live)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ofac-empty-'));
    const rows = await loadOfacTronLabelRows(T0, dir);
    expect(rows).toEqual([]);
  });

  it('loads the real shipped data/labels/ofac/raw/sanctioned_addresses_TRX.txt with 0 network calls', async () => {
    const rows = await loadOfacTronLabelRows(T0);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.every((r) => r.chain === 'TRON' && r.label === 'high_risk')).toBe(true);
  });
});

describe('mergeHighRiskLabelRows', () => {
  const row = (over: Partial<BootstrapLabelRow>): BootstrapLabelRow => ({ address: ADDR_A, chain: 'TRON', label: 'high_risk', source: 'usdt_blacklist', fetchedAt: T0, confidence: 0.9, ...over });

  it('keeps a single-source row untouched', () => {
    const { rows, counts } = mergeHighRiskLabelRows([row({})]);
    expect(rows).toEqual([row({})]);
    expect(counts.agreeingAddresses).toBe(0);
  });

  it('combines confidence via noisy-OR when two sources agree on the same address, keeping both sources evidence', () => {
    const a = row({ source: 'usdt_blacklist', confidence: 0.9 });
    const b = row({ source: 'ofac', confidence: 0.8, evidence: { list: 'SDN' } });
    const { rows, counts } = mergeHighRiskLabelRows([a], [b]);
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBeCloseTo(1 - (1 - 0.9) * (1 - 0.8), 5);
    expect(rows[0].source).toBe('ofac+usdt_blacklist');
    expect(counts.agreeingAddresses).toBe(1);
    expect(counts.mergedAddresses).toBe(1);
  });

  it('is deterministic and sorted by (chain, address)', () => {
    const rows1 = mergeHighRiskLabelRows([row({ address: 'TZZZ00000000000000000000000000000' }), row({ address: ADDR_A })]).rows;
    expect(rows1.map((r) => r.address)).toEqual([ADDR_A, 'TZZZ00000000000000000000000000000']);
  });
});
