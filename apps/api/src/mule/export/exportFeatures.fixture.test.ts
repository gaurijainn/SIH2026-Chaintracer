import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildExportFile } from './exportFeatures';
import { FIXTURE_T0, buildSampleExportRows } from './fixtureScenarios';
import { MULE_FEATURE_NAMES, type ExportFile } from './types';

const FIXTURE_PATH = fileURLToPath(new URL('../../../../../data/ml-exports/mule_features_sample.json', import.meta.url));

/**
 * Golden-file test: the checked-in fixture at data/ml-exports/mule_features_sample.json must be
 * byte-for-byte what running B6's real feature computation through the B7.3 exporter produces right
 * now. If this fails, someone changed B6's feature logic or the exporter without re-running
 * `pnpm tsx scripts/export-mule-features-fixture.mts` to regenerate the checked-in file — this is
 * exactly the drift this test exists to catch, since services/ml's Python tests read the same file.
 */
describe('mule_features_sample.json (B6 -> B7 cross-language fixture)', () => {
  const onDisk = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ExportFile;
  const fresh = buildExportFile(buildSampleExportRows(), { datasetVersion: 'b6-export-v1', generatedAt: new Date(FIXTURE_T0).toISOString() });

  it('matches a fresh run of B6 feature computation through the exporter exactly', () => {
    expect(onDisk).toEqual(fresh);
  });

  it('declares the canonical B7.1 feature order at the file level', () => {
    expect(onDisk.featureOrder).toEqual([...MULE_FEATURE_NAMES]);
  });

  it('has at least one row with every feature known and one row with several features missing', () => {
    const someNull = onDisk.rows.some((r) => r.features.dwell_median_min === null || r.features.activator_label === null);
    const someKnown = onDisk.rows.some((r) => r.features.dwell_median_min !== null && r.features.activator_label !== null);
    expect(someNull).toBe(true);
    expect(someKnown).toBe(true);
  });

  it('has at least one row with a known label and one with label null (not yet known)', () => {
    expect(onDisk.rows.some((r) => r.label !== null)).toBe(true);
    expect(onDisk.rows.some((r) => r.label === null)).toBe(true);
  });
});
