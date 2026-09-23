/**
 * Offline contract test (B7.6 task 8): a fixture-based mock of the exact `AddressScoreResponse`
 * JSON shape the real B7.5 FastAPI service returns from `POST /score` (services/ml/app/main.py's
 * `_score_one`, response_model=list[AddressScoreResponse]). The feature values below are copied
 * verbatim from B7.5's own real integration test fixtures
 * (services/ml/tests/api/test_score_endpoint.py's `_FULL_FEATURES`), and the response fields/types
 * match `services/ml/app/inference/schemas.py`'s `AddressScoreResponse` exactly (including the
 * `sanctioned` override forcing a Critical band + `SANCTIONED` override string, which that same
 * test file exercises against the real trained model). This proves the Node mapping/service code
 * handles a genuine ML response shape correctly without starting a live Python process.
 *
 * See also `mlClient.test.ts` (HTTP-level: timeout/unreachable/malformed against a stub HTTP
 * server) and `service.test.ts` (orchestration). A real in-process FastAPI integration test was
 * considered (task 9) but not added: it would require spawning a Python subprocess, binding a
 * port, and waiting for readiness from a Vitest test -- adding real flakiness/slowness to a suite
 * that must stay fast and fully offline for routine runs, for coverage this fixture-based contract
 * test + the B7.5 Python suite (services/ml/tests/api/test_score_endpoint.py, which asserts the
 * *actual* response shape server-side) already provide together.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AddressScoreResponse, MlClient, RawFeatureVector, TypologyResponse } from './mlClient';
import { RiskService, type RiskServicePrisma } from './service';

// Copied from services/ml/tests/api/test_score_endpoint.py's _FULL_FEATURES (snake_case, real B7.5 fixture values).
const FULL_FEATURES_RAW: RawFeatureVector = {
  dwell_median_min: 12.0,
  fan_out_1h: 8,
  fan_in_unique: 15,
  passthrough_ratio: 0.98,
  age_at_taint_days: 2.0,
  activator_label: 'TSomeActivator123',
  trx_dust_usdt: true,
  round_amount_ratio: 0.7,
  burst_tx_per_hour: 20,
  hops_from_victim: null,
  hops_to_vasp: null,
  sanction_exposure: null,
  external_flags: ['high_risk', 'reported'],
  shared_mule_cps: 4,
  cross_case_count: 3,
};

// A realistic AddressScoreResponse matching services/ml/app/inference/schemas.py exactly, and the
// same "sanctioned override forces Critical band" behavior test_score_sanctioned_override_forces_critical_band asserts.
const SANCTIONED_RESPONSE: AddressScoreResponse = {
  addr: 'TAddr1',
  score: 92,
  band: 'Critical',
  factors: [
    { feature: 'sanction_exposure', impact: 0.9, reason: 'address is directly sanctioned (OFAC)' },
    { feature: 'fan_out_1h', impact: 0.31, reason: 'high fan-out within 1 hour' },
  ],
  overrides: ['SANCTIONED'],
  modelVersion: 'tron-xgb-v1',
  mlProbability: 0.83,
  ruleScore: 100,
  explanationStatus: 'ok',
  datasetVersion: 'tron-bootstrap-v1',
};

const TYPOLOGY_RESPONSE: TypologyResponse = { label: 'pig_butchering', confidence: 0.72, signals: ['escalating deposits from the same victim over days or weeks'] };

function makePrisma(): RiskServicePrisma {
  return {
    traceJob: { findUnique: vi.fn().mockResolvedValue(null) },
    hop: { findMany: vi.fn().mockResolvedValue([]) },
    addressProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    label: { findMany: vi.fn().mockResolvedValue([{ category: 'sanctioned', name: 'OFAC SDN' }]) },
    muleFlag: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    complaint: { findFirst: vi.fn().mockResolvedValue(null) },
    riskScore: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'risk-fixture-1',
        chain: data.chain,
        addr: data.addr,
        score: data.score,
        band: data.band,
        modelVersion: data.modelVersion,
        traceId: data.traceId ?? null,
        createdAt: new Date('2026-09-23T00:00:00Z'),
      })),
    },
  } as RiskServicePrisma;
}

describe('B7.5 /score response contract (fixture-based, offline)', () => {
  it('maps a real-shaped AddressScoreResponse (sanctioned override, Critical band) end to end', async () => {
    let sentFeatures: RawFeatureVector | undefined;
    let sentSanctioned: boolean | undefined;
    const mlClient: MlClient = {
      score: vi.fn().mockImplementation(async (addresses) => {
        sentFeatures = addresses[0].features;
        sentSanctioned = addresses[0].sanctioned;
        return [SANCTIONED_RESPONSE];
      }),
      typology: vi.fn().mockResolvedValue(TYPOLOGY_RESPONSE),
    };
    const service = new RiskService({ prisma: makePrisma(), mlClient });

    const result = await service.getAddressRisk('TRON', 'TAddr1');

    // the feature assembly for TAddr1 (no traceId, no hops) won't produce FULL_FEATURES_RAW exactly,
    // but the /score request shape (raw snake_case keys) must structurally match the real schema.
    expect(sentFeatures ? Object.keys(sentFeatures).sort() : []).toEqual(Object.keys(FULL_FEATURES_RAW).sort());
    expect(sentSanctioned).toBe(true); // sanctioned Label row -> real hard-override evidence sent to ML

    expect(result.score).toBe(92);
    expect(result.band).toBe('CRITICAL');
    expect(result.overrides).toEqual(['SANCTIONED']);
    expect(result.factors).toEqual(SANCTIONED_RESPONSE.factors);
    expect(result.modelVersion).toBe('tron-xgb-v1');
    expect(result.typology).toBe('pig_butchering');
    expect(result.typologyConfidence).toBe(0.72);
  });
});
