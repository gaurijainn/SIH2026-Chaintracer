/**
 * B7.4: the REAL live/record TRON bootstrap collection run, approved by the user for this run only
 * (see project instructions -- pinned rule: live calls require explicit go-ahead each time). This
 * is the live counterpart to scripts/build-tron-bootstrap-dataset.mts's fixture dry-run: it reuses
 * every B7.4 pipeline module unchanged, but talks to the real TronGrid/Tronscan/Chainabuse APIs in
 * DATA_MODE='record' through B0's fixture system, so every response is written to fixtures/{trongrid,
 * tronscan,chainabuse}/*.json for offline replay by all future runs (B7.4 training, CI, re-derivation).
 *
 * Hard budget ceilings (conservative estimates from the approved readiness report) are enforced by
 * polling layer.guard.stats() and stopping early -- never by disabling ProviderGuard's own rate
 * limiting/retry/circuit-breaker, which stays fully in effect throughout.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '../packages/shared/src/env.ts';
import { createChainLayer } from '../workers/adapters/index.ts';
import { collectAddedBlackListEvents } from '../workers/adapters/tron.ts';
import { normalizeAddressForChain } from '../apps/api/src/mule/training/normalize.ts';
import type { BootstrapLabelRow } from '../apps/api/src/mule/training/types.ts';
import { ChainabuseClient } from '../apps/api/src/attribution/loaders/chainabuse.ts';
import { FIU_IND_INSTANT_SWAP_SEED } from '../apps/api/src/attribution/vaspRegistry.ts';
import { blacklistEventsToLabelRows, loadOfacTronLabelRows, mergeHighRiskLabelRows } from '../apps/api/src/mule/bootstrap/highRisk.ts';
import { discoverCandidateAddresses } from '../apps/api/src/mule/bootstrap/candidateDiscovery.ts';
import { buildNegativeCandidate, negativeCandidatesToCsvRows, negativeCandidatesToLabelRows, type NegativeCandidateRow } from '../apps/api/src/mule/bootstrap/negativeCandidates.ts';
import { ChainabuseBudget, enrichHighRiskWithChainabuse, selectChainabuseCandidates, chainAbuseEnrichmentToCsvRows } from '../apps/api/src/mule/bootstrap/chainabuseLimiter.ts';
import { ChainLayerTracedAddressProvider } from '../apps/api/src/mule/bootstrap/tracedAddressProvider.ts';
import { buildTronBootstrapCsv, buildValidationReport } from '../apps/api/src/mule/bootstrap/assembleDataset.ts';
import { toCsv } from '../apps/api/src/mule/bootstrap/csv.ts';
import { joinBootstrapLabels } from '../apps/api/src/mule/training/join.ts';

// --- targets & hard ceilings (approved budget: TronGrid ~3,020 expected / ~7,020 worst-case;
// TronScan ~1,000 expected / ~2,000 worst-case; Chainabuse <=10; OFAC 0) ------------------------
const TARGET_HIGH_RISK = 250;
const TARGET_LICIT = 250;
const BLACKLIST_MAX_PAGES = 25; // 25 * 200/page = 5,000 events ceiling on discovery alone
const CANDIDATE_DISCOVERY_MAX_SEEDS = 60; // 60 seeds * 2 calls = 120 TronGrid calls for candidate harvesting
const CANDIDATE_POOL_TARGET = 700; // buffer above 250 to survive screening dropout
// IMPORTANT: the project's Chainabuse budget is a HARD GLOBAL MAXIMUM OF 10 CALLS FOR THE ENTIRE
// PROJECT, not 10 calls per run. The first live run (2026-09-22) already spent all 10 of them --
// on addresses that turned out to be malformed due to a since-fixed hex-decoding bug, so their
// enrichment data is worthless, but the calls themselves are unrecoverable. This constant is 0 so
// no re-run can ever spend another Chainabuse call without a deliberate, reviewed code change.
const CHAINABUSE_MAX = 0;

const TRONGRID_CEILING = 7_020;
const TRONSCAN_CEILING = 2_000;

async function loadDotEnv(file: string): Promise<Record<string, string>> {
  if (!existsSync(file)) return {};
  const text = await readFile(file, 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function callsUsed(stats: ReturnType<ReturnType<typeof createChainLayer>['stats']>, provider: string): number {
  return stats.providers[provider]?.calls ?? 0;
}

class BudgetExceededError extends Error {}

/**
 * Regression guard for the AddedBlackList decoding bug: validates every address with the exact
 * B2/B3 normalizer (normalizeAddressForChain, wrapping addressRules.ts's classifyIdentifier)
 * *before* it is ever handed to a TronGrid/Tronscan call, and again before it's allowed into the
 * final dataset. A raw '0x...' EVM-shaped string is never a valid TRON family address, so it is
 * rejected here rather than silently reaching a live provider call or a training row.
 */
function partitionValidTronAddresses<T extends { address: string }>(rows: readonly T[]): { valid: T[]; invalid: T[] } {
  const valid: T[] = [];
  const invalid: T[] = [];
  for (const row of rows) {
    const normalized = normalizeAddressForChain('TRON', row.address);
    if (normalized && normalized === row.address) valid.push(row);
    else invalid.push(row);
  }
  return { valid, invalid };
}

function filterValidTronAddressStrings(addresses: readonly string[]): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const a of addresses) {
    const normalized = normalizeAddressForChain('TRON', a);
    if (normalized && normalized === a) valid.push(a);
    else invalid.push(a);
  }
  return { valid, invalid };
}

function checkBudget(layer: ReturnType<typeof createChainLayer>, phase: string) {
  const stats = layer.stats();
  const tg = callsUsed(stats, 'trongrid');
  const ts = callsUsed(stats, 'tronscan');
  if (tg > TRONGRID_CEILING) throw new BudgetExceededError(`TronGrid calls (${tg}) exceeded the approved ceiling (${TRONGRID_CEILING}) during ${phase}`);
  if (ts > TRONSCAN_CEILING) throw new BudgetExceededError(`TronScan calls (${ts}) exceeded the approved ceiling (${TRONSCAN_CEILING}) during ${phase}`);
  return { tg, ts };
}

async function main() {
  const startedAt = Date.now();
  const dotEnv = await loadDotEnv(path.resolve(import.meta.dirname, '..', '.env'));
  const mergedEnv = { ...dotEnv, ...process.env };
  if (!mergedEnv.TRONGRID_KEY || !mergedEnv.TRONSCAN_KEY || !mergedEnv.CHAINABUSE_KEY) {
    throw new Error('TRONGRID_KEY, TRONSCAN_KEY and CHAINABUSE_KEY must all be set (in .env or the environment) for a live run.');
  }

  const env = { ...loadEnv(mergedEnv), DATA_MODE: 'record' as const, FIXTURES_DIR: path.resolve(import.meta.dirname, '..', 'fixtures') };
  // No `guard: { unlimited: true }` override here -- real rate limiting/retry/circuit-breaker from
  // ProviderGuard's defaults (workers/adapters/limits.ts DEFAULT_LIMITS) apply for the entire run.
  const layer = createChainLayer({ env, pricing: false });

  const generatedAt = new Date(startedAt).toISOString();
  const outDir = path.resolve(import.meta.dirname, '..', 'data', 'labels', 'tron-bootstrap', 'v1');
  await mkdir(outDir, { recursive: true });

  console.log(`[live] starting B7.4 TRON bootstrap collection at ${generatedAt}, DATA_MODE=record, fixtures -> ${env.FIXTURES_DIR}`);

  if (mergedEnv.COLLECT_DRY_CHECK === '1') {
    console.log('[live] COLLECT_DRY_CHECK=1: env + imports + chain-layer construction verified, exiting before any network call.');
    return;
  }

  // --- 1: AddedBlackList discovery (real TronGrid contract-events call, paginated) ----------------
  console.log('[live] phase 1: TronGrid AddedBlackList discovery...');
  const { items: blacklistEvents, pages: blacklistPages, truncated: blacklistTruncated } = await collectAddedBlackListEvents(layer.tron, { maxPages: BLACKLIST_MAX_PAGES });
  console.log(`[live] AddedBlackList: ${blacklistEvents.length} events across ${blacklistPages} pages (truncated=${blacklistTruncated})`);
  checkBudget(layer, 'AddedBlackList discovery');

  // --- 2: OFAC (real local file, 0 network calls) --------------------------------------------------
  const ofacRows = await loadOfacTronLabelRows(generatedAt);
  console.log(`[live] OFAC: ${ofacRows.length} real TRON addresses loaded from the local file (0 network calls)`);

  // --- 3: merge high-risk label rows, cap at TARGET_HIGH_RISK -------------------------------------
  const blacklistRows = blacklistEventsToLabelRows(blacklistEvents, generatedAt);
  const { rows: mergedHighRisk, counts: highRiskCounts } = mergeHighRiskLabelRows(blacklistRows, ofacRows);

  // Regression guard (the bug that produced 0 usable rows in the prior run): validate every
  // merged high-risk address against B2/B3's normalizer *before* selecting/using any of them, so a
  // decoding regression is caught here -- as a visible, counted rejection -- instead of silently
  // reaching a live provider call or the final dataset.
  const { valid: validMergedHighRisk, invalid: invalidMergedHighRisk } = partitionValidTronAddresses(mergedHighRisk);
  console.log(`[live] address validation: ${validMergedHighRisk.length}/${mergedHighRisk.length} merged high-risk addresses are valid TRON base58 addresses (${invalidMergedHighRisk.length} rejected)`);
  if (invalidMergedHighRisk.length > 0) {
    console.warn(`[live] rejected addresses (first 5): ${invalidMergedHighRisk.slice(0, 5).map((r) => r.address).join(', ')}`);
  }
  if (validMergedHighRisk.length === 0) {
    throw new BudgetExceededError('0 valid TRON addresses after normalization -- stopping immediately rather than spending further live calls on a data-integrity problem. See invalidMergedHighRisk above.');
  }

  const highRiskRows = validMergedHighRisk.slice(0, TARGET_HIGH_RISK); // deterministic: mergeHighRiskLabelRows already sorts by address
  console.log(`[live] high-risk merge: ${mergedHighRisk.length} candidates merged (${highRiskCounts.agreeingAddresses} multi-source), keeping first ${highRiskRows.length} of ${validMergedHighRisk.length} valid`);
  // Sanity check required before declaring success: no raw 0x... address may reach the final rows.
  const rawHexHighRisk = highRiskRows.filter((r) => /^0x/i.test(r.address));
  if (rawHexHighRisk.length > 0) throw new BudgetExceededError(`${rawHexHighRisk.length} raw 0x... addresses survived validation -- this must never happen; stopping.`);

  const highRiskAddrSet = new Set(highRiskRows.map((r) => r.address));
  const vaspExcluded = new Set(FIU_IND_INSTANT_SWAP_SEED.flatMap((v) => (v.hotWallets ?? []).filter((w) => w.chain === 'TRON').map((w) => w.addr)));
  const excludedForNegatives = new Set([...highRiskAddrSet, ...vaspExcluded]);

  // --- 4: discover real candidate addresses for negative screening (transfer counterparties of a
  // priority-ordered subset of high-risk addresses; deterministic, budget-bounded) -----------------
  console.log('[live] phase 4: candidate discovery for negative/licit screening...');
  const candidatePool = await discoverCandidateAddresses(layer.tron, highRiskRows.map((r) => r.address), {
    maxSeeds: CANDIDATE_DISCOVERY_MAX_SEEDS,
    maxCandidates: CANDIDATE_POOL_TARGET,
    excludedAddresses: excludedForNegatives,
  });
  console.log(`[live] candidate discovery: ${candidatePool.length} unique candidate addresses harvested`);
  checkBudget(layer, 'candidate discovery');

  // Validate harvested counterparties too before they can reach buildNegativeCandidate's TronGrid/
  // Tronscan calls -- they come from real live transfer data so should already be valid, but this
  // is the same defense-in-depth check applied at every address boundary, not a one-off patch.
  const { valid: validCandidatePool, invalid: invalidCandidatePool } = filterValidTronAddressStrings(candidatePool);
  if (invalidCandidatePool.length > 0) console.warn(`[live] rejected ${invalidCandidatePool.length} malformed addresses from candidate discovery before screening`);

  // --- 5: screen candidates for licit inclusion, stopping once TARGET_LICIT confirmed or the pool
  // is exhausted or the budget ceiling is approached ------------------------------------------------
  console.log('[live] phase 5: negative-candidate screening...');
  const negativeCandidates: NegativeCandidateRow[] = [];
  let confirmed = 0;
  for (const addr of validCandidatePool) {
    if (confirmed >= TARGET_LICIT) break;
    const { tg, ts } = checkBudget(layer, `negative screening (${negativeCandidates.length} screened so far)`);
    if (tg > TRONGRID_CEILING * 0.9 || ts > TRONSCAN_CEILING * 0.9) {
      console.warn(`[live] stopping negative screening early: within 90% of a provider ceiling (trongrid=${tg}, tronscan=${ts})`);
      break;
    }
    const row = await buildNegativeCandidate(addr, 'TRON', { tron: layer.tron, excludedAddresses: excludedForNegatives, nowIso: new Date().toISOString() });
    negativeCandidates.push(row);
    if (row.status === 'included') confirmed++;
  }
  console.log(`[live] negative screening: ${negativeCandidates.length} candidates screened, ${confirmed} confirmed licit`);
  const licitRows = negativeCandidatesToLabelRows(negativeCandidates, generatedAt);

  // --- 6: Chainabuse enrichment, hard-limited to CHAINABUSE_MAX (never for negatives) -------------
  console.log('[live] phase 6: Chainabuse enrichment (hard-capped)...');
  const chainabuseSelected = selectChainabuseCandidates(highRiskRows.map((r) => r.address), CHAINABUSE_MAX);
  const budget = new ChainabuseBudget(CHAINABUSE_MAX);
  const chainabuseClient = new ChainabuseClient({ guard: layer.guard, http: layer.http });
  const chainabuseEnriched = await enrichHighRiskWithChainabuse(chainabuseClient, budget, chainabuseSelected, { maxRetries: 1 });
  console.log(`[live] Chainabuse: enriched ${chainabuseEnriched.length} addresses, ${budget.callsUsed}/${CHAINABUSE_MAX} calls used`);
  if (budget.callsUsed > CHAINABUSE_MAX) throw new BudgetExceededError(`Chainabuse budget somehow exceeded: ${budget.callsUsed}/${CHAINABUSE_MAX}`);

  // --- 7: real B6 feature computation for every final address --------------------------------------
  console.log('[live] phase 7: B6 feature computation via ChainLayerTracedAddressProvider...');
  const allLabelRows: BootstrapLabelRow[] = [...highRiskRows, ...licitRows];
  const { valid: validAllLabelRows, invalid: invalidAllLabelRows } = partitionValidTronAddresses(allLabelRows);
  if (invalidAllLabelRows.length > 0) throw new BudgetExceededError(`${invalidAllLabelRows.length} invalid addresses reached phase 7 -- this must never happen (they should have been filtered earlier); stopping before spending any more calls.`);
  const allAddresses = [...new Set(validAllLabelRows.map((r) => r.address))];
  const provider = await ChainLayerTracedAddressProvider.build(layer, 'TRON', allAddresses);
  checkBudget(layer, 'B6 feature computation');

  // --- 8: join labels with real B6 features (dedup/conflict handling built into join.ts) ----------
  const joinReport = joinBootstrapLabels(validAllLabelRows, provider);
  console.log(`[live] join: ${joinReport.rows.length} training rows, ${joinReport.conflicts.length} conflicts, ${joinReport.unmatchedLabels.length} unmatched`);

  // Final integrity check required before declaring success: no raw 0x... address may appear
  // anywhere in the joined training rows.
  const rawHexInOutput = joinReport.rows.filter((r) => /^0x/i.test(r.identifier));
  if (rawHexInOutput.length > 0) throw new BudgetExceededError(`${rawHexInOutput.length} raw 0x... addresses reached the final training rows -- this must never happen; stopping before writing any output.`);

  // --- 9: write outputs -----------------------------------------------------------------------------
  await writeFile(path.join(outDir, 'candidates_high_risk.csv'), toCsv(highRiskRows.map((r) => ({ ...r, evidence: JSON.stringify(r.evidence ?? null) })), ['address', 'chain', 'label', 'source', 'fetchedAt', 'confidence', 'evidence']), 'utf8');
  await writeFile(path.join(outDir, 'candidates_negative.csv'), toCsv(negativeCandidatesToCsvRows(negativeCandidates), ['address', 'chain', 'status', 'source', 'timestamp', 'activity_evidence', 'usdt_holder_evidence', 'exclusion_reason']), 'utf8');
  await writeFile(path.join(outDir, 'chainabuse_enriched.csv'), toCsv(chainAbuseEnrichmentToCsvRows('TRON', chainabuseEnriched, generatedAt), ['address', 'chain', 'reportCount', 'attempts', 'enrichedAt']), 'utf8');
  await writeFile(path.join(outDir, 'tron_bootstrap_dataset.csv'), buildTronBootstrapCsv(joinReport.rows), 'utf8');

  const finalStats = layer.stats();
  const runtimeMs = Date.now() - startedAt;
  const validation = buildValidationReport({
    joinReport,
    negativeCandidates,
    sourceCounts: { addedBlackListAddresses: highRiskCounts.addedBlackListAddresses, ofacAddresses: highRiskCounts.ofacAddresses, chainabuseEnrichedAddresses: chainabuseEnriched.length },
    datasetVersion: 'tron-bootstrap-v1-live',
    generatedAt,
    totalHighRiskCandidatesConsidered: highRiskRows.length,
  });
  const report = {
    ...validation,
    scopeNote: 'LIVE COLLECTION: real TronGrid AddedBlackList + real OFAC local file + real TronScan account meta + real (budget-capped) Chainabuse reports + real B3 transfer/account data for all B6 features. Recorded to fixtures/ for offline replay.',
    excludedRecords: {
      conflicts: joinReport.conflicts,
      unmatchedLabels: joinReport.unmatchedLabels,
      invalidAddresses: joinReport.invalidAddresses,
      untracedAddresses: joinReport.untracedAddresses,
    },
    liveRunStats: {
      runtimeMs,
      apiCalls: {
        trongrid: callsUsed(finalStats, 'trongrid'),
        tronscan: callsUsed(finalStats, 'tronscan'),
        chainabuse: budget.callsUsed,
        ofac: 0,
      },
      blacklistDiscovery: { events: blacklistEvents.length, pages: blacklistPages, truncated: blacklistTruncated },
      candidatePoolSize: candidatePool.length,
      negativeCandidatesScreened: negativeCandidates.length,
      addressValidation: {
        mergedHighRiskValid: validMergedHighRisk.length,
        mergedHighRiskInvalid: invalidMergedHighRisk.length,
        candidatePoolInvalid: invalidCandidatePool.length,
        rawHexAddressesInFinalOutput: rawHexInOutput.length,
      },
    },
  };
  await writeFile(path.join(outDir, 'validation_report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`[live] wrote dataset + reports to ${outDir}`);
  console.log(`[live] final API call counts -- trongrid: ${callsUsed(finalStats, 'trongrid')}, tronscan: ${callsUsed(finalStats, 'tronscan')}, chainabuse: ${budget.callsUsed}`);
  console.log(`[live] runtime: ${(runtimeMs / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e instanceof BudgetExceededError ? `[live] STOPPED -- budget exceeded: ${e.message}` : e);
  process.exitCode = 1;
});
