import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LabelPrisma } from '../labelStore';
import { DEFAULT_OFAC_DIR, loadOfacDir, normalizeOfacAddresses, OFAC_ASSETS, parseOfacAddresses } from './ofac';

describe('parseOfacAddresses', () => {
  it('splits into trimmed, non-empty lines', () => {
    expect(parseOfacAddresses('0xAAA\n0xBBB\n\n  0xCCC  \n')).toEqual(['0xAAA', '0xBBB', '0xCCC']);
  });
  it('returns an empty list for empty input', () => {
    expect(parseOfacAddresses('')).toEqual([]);
  });
});

describe('normalizeOfacAddresses', () => {
  it('labels every address "sanctioned" with source ofac and full confidence, keeping source-file evidence', () => {
    const labels = normalizeOfacAddresses('ETH', ['0xAAA', '0xBBB'], 'sanctioned_addresses_ETH.txt');
    expect(labels).toEqual([
      { chain: 'ETH', addr: '0xAAA', name: 'OFAC SDN', category: 'sanctioned', source: 'ofac', confidence: 1, evidence: expect.objectContaining({ file: 'sanctioned_addresses_ETH.txt' }) },
      { chain: 'ETH', addr: '0xBBB', name: 'OFAC SDN', category: 'sanctioned', source: 'ofac', confidence: 1, evidence: expect.objectContaining({ file: 'sanctioned_addresses_ETH.txt' }) },
    ]);
  });
});

function fakeLabelPrisma() {
  const rows: Record<string, unknown>[] = [];
  const prisma: LabelPrisma = { label: { async upsert({ create }) { rows.push(create); return create; } } };
  return { prisma, rows };
}

describe('loadOfacDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ofac-test-'));
    await writeFile(path.join(dir, 'sanctioned_addresses_ETH.txt'), '0xE1\n0xE2\n');
    await writeFile(path.join(dir, 'sanctioned_addresses_TRX.txt'), 'TAAA\n');
    // BSC/USDT/XBT deliberately missing, to prove missing files are skipped rather than erroring
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads every present asset file and skips missing ones without error', async () => {
    const { prisma, rows } = fakeLabelPrisma();
    const n = await loadOfacDir(prisma, dir, OFAC_ASSETS);
    expect(n).toBe(3);
    expect(rows.map((r) => r.addr).sort()).toEqual(['0xE1', '0xE2', 'TAAA']);
    expect(rows.every((r) => r.source === 'ofac' && r.category === 'sanctioned')).toBe(true);
  });

  it('is safe to rerun: the loader itself makes no assumption about prior state (upsert idempotency is labelStore\'s job)', async () => {
    const { prisma, rows } = fakeLabelPrisma();
    await loadOfacDir(prisma, dir, OFAC_ASSETS);
    await loadOfacDir(prisma, dir, OFAC_ASSETS);
    expect(rows).toHaveLength(6); // this fake just records every upsert call; a real Prisma client would dedupe by the unique key
  });
});

describe('DEFAULT_OFAC_DIR (the real, committed data/labels/ofac/raw snapshot)', () => {
  it('loads the real downloaded OFAC files without error', async () => {
    const { prisma, rows } = fakeLabelPrisma();
    const n = await loadOfacDir(prisma, DEFAULT_OFAC_DIR);
    expect(n).toBeGreaterThan(100); // hundreds of SDN digital-currency addresses across the 5 asset files
    expect(rows.every((r) => typeof r.addr === 'string' && (r.addr as string).length > 0)).toBe(true);
  });
});
