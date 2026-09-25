/**
 * B7.3: writes the checked-in cross-language fixture that proves the Node(B6) -> Python(B7)
 * feature-export bridge. Scenario data lives in apps/api/src/mule/export/fixtureScenarios.ts (a
 * pure function run against B6's real production computeMuleFeatures), shared with
 * exportFeatures.fixture.test.ts's golden-file test so the script and the test can never drift
 * apart. Output: data/ml-exports/mule_features_sample.json.
 *
 * Deterministic: fixed timestamps throughout, no Date.now(), no randomness. Re-run with
 * `pnpm tsx scripts/export-mule-features-fixture.mts` any time B6's feature computation changes.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildExportFile } from '../apps/api/src/mule/export/exportFeatures.ts';
import { FIXTURE_T0, buildSampleExportRows } from '../apps/api/src/mule/export/fixtureScenarios.ts';

const rows = buildSampleExportRows();
const file = buildExportFile(rows, { datasetVersion: 'b6-export-v1', generatedAt: new Date(FIXTURE_T0).toISOString() });

const outPath = path.resolve(import.meta.dirname, '..', 'data', 'ml-exports', 'mule_features_sample.json');
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
console.log(`wrote ${rows.length} rows to ${outPath}`);
