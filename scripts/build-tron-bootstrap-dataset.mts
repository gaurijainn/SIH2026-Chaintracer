/**
 * B7.4 prep: assembles the TRON bootstrap training dataset end to end, entirely offline.
 *
 * IMPORTANT SCOPE NOTE: per the hard constraint for this phase ("NO live external API calls of any
 * kind"), this script never touches the network. It runs the *real* pipeline code (TronAdapter's
 * AddedBlackList collector, the real OFAC loader against the real local file, the real negative
 * candidate builder, the real Chainabuse budget/limiter, the real B6-feature-backed
 * ChainLayerTracedAddressProvider, the real joinBootstrapLabels) against:
 *   - the REAL local OFAC TRON file (data/labels/ofac/raw/sanctioned_addresses_TRX.txt, 254
 *     addresses, 0 network calls) for the OFAC half of the high-risk source, and
 *   - a small deterministic SYNTHETIC fixture (via workers/adapters/testing.ts's fakeTransport,
 *     same helper B3's own tests use) standing in for TronGrid/Tronscan/Chainabuse responses for
 *     everything else (AddedBlackList events, transfer history, account meta, Chainabuse reports).
 *
 * This proves the whole B7.4 pipeline is wired correctly end to end and produces a real,
 * schema-valid CSV -- but it is NOT the ~500-address real collection run (that requires the
 * budgeted live/record TronGrid+Tronscan+Chainabuse run described in the readiness report, which
 * needs an explicit go-ahead before it can execute against the free-tier keys).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '../packages/shared/src/env.ts';
import { createChainLayer } from '../workers/adapters/index.ts';
import { collectAddedBlackListEvents } from '../workers/adapters/tron.ts';
import { fakeTransport, tronAddr } from '../workers/adapters/testing.ts';
import type { Route } from '../workers/adapters/testing.ts';
import { ChainabuseClient } from '../apps/api/src/attribution/loaders/chainabuse.ts';
import { blacklistEventsToLabelRows, loadOfacTronLabelRows, mergeHighRiskLabelRows } from '../apps/api/src/mule/bootstrap/highRisk.ts';
import { buildNegativeCandidates, negativeCandidatesToCsvRows, negativeCandidatesToLabelRows } from '../apps/api/src/mule/bootstrap/negativeCandidates.ts';
import { ChainabuseBudget, enrichHighRiskWithChainabuse, selectChainabuseCandidates, chainAbuseEnrichmentToCsvRows } from '../apps/api/src/mule/bootstrap/chainabuseLimiter.ts';
import { ChainLayerTracedAddressProvider } from '../apps/api/src/mule/bootstrap/tracedAddressProvider.ts';
import { buildTronBootstrapCsv, buildValidationReport } from '../apps/api/src/mule/bootstrap/assembleDataset.ts';
import { toCsv } from '../apps/api/src/mule/bootstrap/csv.ts';
import { joinBootstrapLabels } from '../apps/api/src/mule/training/join.ts';

const GENERATED_AT = '2026-09-23T00:00:00.000Z';
const DATASET_VERSION = 'tron-bootstrap-v1-fixture-dryrun';

// --- deterministic synthetic address pools (fixture-only; never real collected addresses) -------
const HR_BLACKLIST_ADDRS = Array.from({ length: 6 }, (_, i) => tronAddr(`hr-blacklist-${i}`));
const NEG_INCLUDED_ADDRS = Array.from({ length: 6 }, (_, i) => tronAddr(`neg-included-${i}`));
const NEG_EXCLUDED_TAG_ADDRS = Array.from({ length: 2 }, (_, i) => tronAddr(`neg-excluded-${i}`));
const NEG_UNDETERMINED_ADDRS = Array.from({ length: 2 }, (_, i) => tronAddr(`neg-undetermined-${i}`));

const usdtHolder = new Set([...HR_BLACKLIST_ADDRS, ...NEG_INCLUDED_ADDRS]);
const inactive = new Set(NEG_UNDETERMINED_ADDRS);
const taggedExchange = new Set(NEG_EXCLUDED_TAG_ADDRS);

// TronGrid gives back hex addresses for event params; simplest correct stand-in here is to encode
// the *base58* address directly as the event's `_user` value (skips the 41-hex round trip, and the
// normalizer already falls back to using the raw value verbatim when it isn't 41-prefixed hex).
const blacklistPage1 = [
  { transaction_id: 'a'.repeat(64), block_number: 1, block_timestamp: 1_756_000_000_000, event_name: 'AddedBlackList', result: { _user: HR_BLACKLIST_ADDRS[0] } },
  { transaction_id: 'b'.repeat(64), block_number: 2, block_timestamp: 1_756_000_001_000, event_name: 'AddedBlackList', result: { _user: HR_BLACKLIST_ADDRS[1] } },
  { transaction_id: 'c'.repeat(64), block_number: 3, block_timestamp: 1_756_000_002_000, event_name: 'AddedBlackList', result: { _user: HR_BLACKLIST_ADDRS[2] } },
];
const blacklistPage2 = [
  { transaction_id: 'd'.repeat(64), block_number: 4, block_timestamp: 1_756_000_003_000, event_name: 'AddedBlackList', result: { _user: HR_BLACKLIST_ADDRS[3] } },
  { transaction_id: 'e'.repeat(64), block_number: 5, block_timestamp: 1_756_000_004_000, event_name: 'AddedBlackList', result: { _user: HR_BLACKLIST_ADDRS[4] } },
  { transaction_id: 'f'.repeat(64), block_number: 6, block_timestamp: 1_756_000_005_000, event_name: 'AddedBlackList', result: { _user: HR_BLACKLIST_ADDRS[5] } },
];

const routes: Route[] = [
  [/events\?event_name=AddedBlackList.*fingerprint=FP1/, () => ({ data: blacklistPage2, success: true, meta: {} })],
  [/events\?event_name=AddedBlackList/, () => ({ data: blacklistPage1, success: true, meta: { fingerprint: 'FP1' } })],
  [/tronscanapi\.com\/api\/accountv2\?address=([^&]+)/, (_r, m) => ({ date_created: 1_690_000_000_000, addressTag: taggedExchange.has(m[1]) ? 'Some Exchange' : '' })],
  [/api\/security\/account\/data\?address=/, () => ({ is_black_list: false, has_fraud_transaction: false, fraud_token_creator: false, send_ad_by_memo: false })],
  [/v1\/accounts\/([^/?]+)$/, (_r, m) => (inactive.has(m[1]) ? { data: [], success: true } : { data: [{ address: m[1] }], success: true })],
  [
    /v1\/accounts\/([^/?]+)\/transactions\/trc20\?.*only_to=true/,
    (_r, m) => (usdtHolder.has(m[1]) ? { data: [{ transaction_id: `${m[1]}-in`.padEnd(64, '0'), token_info: { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 }, block_timestamp: 1_756_000_010_000, from: tronAddr('counterparty'), to: m[1], type: 'Transfer', value: '5000000' }], success: true, meta: {} } : { data: [], success: true, meta: {} }),
  ],
  [/v1\/accounts\/([^/?]+)\/transactions\/trc20\?.*only_from=true/, () => ({ data: [], success: true, meta: {} })],
  [/v1\/accounts\/([^/?]+)\/transactions\?/, () => ({ data: [], success: true, meta: {} })],
  [/api\.chainabuse\.com\/v0\/reports/, () => ({ count: 0, reports: [] })],
];

async function main() {
  const env = { ...loadEnv({ DATA_MODE: 'live' }), FIXTURES_DIR: 'unused' };
  const layer = createChainLayer({ env, transport: fakeTransport(routes), pricing: false, guard: { unlimited: true, sleep: async () => undefined, random: () => 0 } });

  // --- 1: AddedBlackList collection (synthetic fixture events; real pagination/dedup code) -------
  const { items: blacklistEvents, pages } = await collectAddedBlackListEvents(layer.tron);
  console.log(`AddedBlackList: collected ${blacklistEvents.length} events across ${pages} pages (fixture)`);

  // --- 2: OFAC (real local file, 0 network calls) --------------------------------------------
  const ofacRows = await loadOfacTronLabelRows(GENERATED_AT); // reads the real, shipped 254-address file
  console.log(`OFAC: loaded ${ofacRows.length} real TRON addresses from the local file (0 network calls)`);

  // --- 3: merge high-risk label rows ----------------------------------------------------------
  const blacklistRows = blacklistEventsToLabelRows(blacklistEvents, GENERATED_AT);
  // for this fixture dry-run we only take a handful of OFAC rows alongside the synthetic blacklist
  // rows so the demo dataset stays small; a real run would keep all 254.
  const ofacSample = ofacRows.slice(0, 6);
  const { rows: highRiskRows, counts: highRiskCounts } = mergeHighRiskLabelRows(blacklistRows, ofacSample);
  console.log(`high-risk merge: ${highRiskRows.length} addresses (${highRiskCounts.agreeingAddresses} multi-source agreements)`);

  // --- 4: negative/licit candidates ------------------------------------------------------------
  const negAddrs = [...NEG_INCLUDED_ADDRS, ...NEG_EXCLUDED_TAG_ADDRS, ...NEG_UNDETERMINED_ADDRS];
  const negativeCandidates = await buildNegativeCandidates(negAddrs, 'TRON', { tron: layer.tron, excludedAddresses: new Set(), nowIso: GENERATED_AT });
  const licitRows = negativeCandidatesToLabelRows(negativeCandidates, GENERATED_AT);
  console.log(`negative candidates: ${negativeCandidates.length} considered, ${licitRows.length} confirmed licit`);

  // --- 5: Chainabuse enrichment, hard-limited to 10 ---------------------------------------------
  const chainabuseSelected = selectChainabuseCandidates(highRiskRows.map((r) => r.address), 10);
  const budget = new ChainabuseBudget(10);
  const client = new ChainabuseClient({ guard: layer.guard, http: layer.http });
  const enriched = await enrichHighRiskWithChainabuse(client, budget, chainabuseSelected, { maxRetries: 0 });
  console.log(`Chainabuse: enriched ${enriched.length} addresses, ${budget.callsUsed}/10 calls used`);

  // --- 6: real B6 feature computation via a ChainLayer-backed TracedAddressProvider -------------
  const allAddresses = [...new Set([...highRiskRows.map((r) => r.address), ...licitRows.map((r) => r.address)])];
  const provider = await ChainLayerTracedAddressProvider.build(layer, 'TRON', allAddresses);

  // --- 7: join labels with real B6 features, dedup/conflict handling built in -------------------
  const joinReport = joinBootstrapLabels([...highRiskRows, ...licitRows], provider);
  console.log(`join: ${joinReport.rows.length} training rows, ${joinReport.conflicts.length} conflicts, ${joinReport.unmatchedLabels.length} unmatched`);

  // --- 8/9: assemble final CSV + validation report -----------------------------------------------
  const outDir = path.resolve(import.meta.dirname, '..', 'data', 'labels', 'tron-bootstrap', 'v1');
  await mkdir(outDir, { recursive: true });

  await writeFile(path.join(outDir, 'candidates_high_risk.csv'), toCsv(highRiskRows.map((r) => ({ ...r, evidence: JSON.stringify(r.evidence ?? null) })), ['address', 'chain', 'label', 'source', 'fetchedAt', 'confidence', 'evidence']), 'utf8');
  await writeFile(path.join(outDir, 'candidates_negative.csv'), toCsv(negativeCandidatesToCsvRows(negativeCandidates), ['address', 'chain', 'status', 'source', 'timestamp', 'activity_evidence', 'usdt_holder_evidence', 'exclusion_reason']), 'utf8');
  await writeFile(path.join(outDir, 'chainabuse_enriched.csv'), toCsv(chainAbuseEnrichmentToCsvRows('TRON', enriched, GENERATED_AT), ['address', 'chain', 'reportCount', 'attempts', 'enrichedAt']), 'utf8');
  await writeFile(path.join(outDir, 'tron_bootstrap_dataset.csv'), buildTronBootstrapCsv(joinReport.rows), 'utf8');

  const validation = buildValidationReport({
    joinReport,
    negativeCandidates,
    sourceCounts: { addedBlackListAddresses: highRiskCounts.addedBlackListAddresses, ofacAddresses: highRiskCounts.ofacAddresses, chainabuseEnrichedAddresses: enriched.length },
    datasetVersion: DATASET_VERSION,
    generatedAt: GENERATED_AT,
    totalHighRiskCandidatesConsidered: highRiskRows.length,
  });
  const report = {
    ...validation,
    scopeNote: 'FIXTURE DRY-RUN: OFAC rows are real (local file, 0 calls); AddedBlackList/TronScan/Chainabuse responses are synthetic fixtures (workers/adapters/testing.ts fakeTransport). Not the real ~500-address live collection -- see the B7.4 readiness report for that run\'s call budget and required go-ahead.',
    excludedRecords: {
      conflicts: joinReport.conflicts,
      unmatchedLabels: joinReport.unmatchedLabels,
      invalidAddresses: joinReport.invalidAddresses,
      untracedAddresses: joinReport.untracedAddresses,
    },
  };
  await writeFile(path.join(outDir, 'validation_report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`wrote dataset + reports to ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
