import { computeMuleFeatures } from '../features';
import type { HopLike } from '../types';
import { toExportRow } from './exportFeatures';
import type { ExportRow } from './types';

/**
 * The B7.3 cross-language fixture's four scenarios, as a pure function so both the generation
 * script (scripts/export-mule-features-fixture.mts) and its golden-file test
 * (exportFeatures.fixture.test.ts) build the exact same rows from the exact same B6 computation —
 * no duplicated scenario data to drift out of sync.
 */
export const FIXTURE_T0 = Date.UTC(2026, 8, 1);

const iso = (ms: number) => new Date(ms).toISOString();
const hop = (over: Partial<HopLike>): HopLike => ({ txHash: 'tx', idx: 0, fromAddr: 'F', toAddr: 'T', token: 'USDT', amount: '0', usd: 0, ts: FIXTURE_T0, ...over });

export function buildSampleExportRows(): ExportRow[] {
  const T0 = FIXTURE_T0;
  return [
    // 1. Fully-populated: every metadata source available, a confirmed high_risk label.
    toExportRow({
      identifier: 'TMULE1FULLYKNOWNADDRESS0000000001',
      chain: 'TRON',
      timestamp: iso(T0),
      label: 'high_risk',
      source: { name: 'b6-mule-features', version: 'v1', caseId: 'case-demo-1', traceId: 'trace-demo-1' },
      features: computeMuleFeatures({
        chain: 'TRON',
        addr: 'TMULE1FULLYKNOWNADDRESS0000000001',
        inbound: [hop({ txHash: 'in1', fromAddr: 'VICTIM', usd: 1000, ts: T0 })],
        outbound: [hop({ txHash: 'out1', toAddr: 'MULE2', usd: 985, ts: T0 + 20 * 60_000 })],
        accountCreatedAtMs: T0 - 3 * 86_400_000,
        firstTaintedAtMs: T0,
        activatorLabel: 'exchange',
        sanctionExposure: null,
        externalFlags: ['fraudTransaction'],
        trxDustUsdt: true,
        hopsFromVictim: 1,
        hopsToVasp: 2,
        sharedMuleCps: 3,
        crossCaseCount: 2,
      }),
    }),
    // 2. Fresh wallet with no outbound activity yet: dwell/passthrough legitimately null.
    toExportRow({
      identifier: 'TFRESH2NOOUTBOUNDYET00000000000002',
      chain: 'TRON',
      timestamp: iso(T0 + 3_600_000),
      label: null,
      source: { name: 'b6-mule-features', version: 'v1', caseId: 'case-demo-1' },
      features: computeMuleFeatures({
        chain: 'TRON',
        addr: 'TFRESH2NOOUTBOUNDYET00000000000002',
        inbound: [hop({ txHash: 'in2', fromAddr: 'MULE1', usd: 500, ts: T0 + 3_600_000 })],
        outbound: [],
        accountCreatedAtMs: T0 + 3_600_000 - 2 * 86_400_000,
        firstTaintedAtMs: T0 + 3_600_000,
        activatorLabel: null,
        sanctionExposure: null,
        externalFlags: [],
        trxDustUsdt: false,
        hopsFromVictim: 2,
        hopsToVasp: null,
        sharedMuleCps: 0,
        crossCaseCount: 1,
      }),
    }),
    // 3. No account metadata at all: activator_label/age/hops/sanction all legitimately unknown.
    toExportRow({
      identifier: 'TNOMETA3NOADDRESSPROFILE0000000003',
      chain: 'TRON',
      timestamp: null,
      label: null,
      source: { name: 'b6-mule-features', version: 'v1', caseId: 'case-demo-2' },
      features: computeMuleFeatures({
        chain: 'TRON',
        addr: 'TNOMETA3NOADDRESSPROFILE0000000003',
        inbound: [hop({ txHash: 'in3', fromAddr: 'X', usd: 200, ts: T0 + 7_200_000 })],
        outbound: [hop({ txHash: 'out3', toAddr: 'Y', usd: 190, ts: T0 + 7_260_000 })],
        accountCreatedAtMs: null,
        firstTaintedAtMs: T0 + 7_200_000,
        activatorLabel: null,
        sanctionExposure: null,
        externalFlags: [],
        trxDustUsdt: false,
        hopsFromVictim: null,
        hopsToVasp: null,
        sharedMuleCps: 0,
        crossCaseCount: 1,
      }),
    }),
    // 4. Multiple external flags and cross-case linkage, on ETH.
    toExportRow({
      identifier: '0xflags4multipleflagsandcrosscase4',
      chain: 'ETH',
      timestamp: iso(T0 + 10_800_000),
      label: 'licit',
      source: { name: 'b6-mule-features', version: 'v1', caseId: 'case-demo-3' },
      features: computeMuleFeatures({
        chain: 'ETH',
        addr: '0xflags4multipleflagsandcrosscase4',
        inbound: [hop({ txHash: 'in4', fromAddr: 'A', usd: 300, ts: T0 + 10_800_000 })],
        outbound: [hop({ txHash: 'out4', toAddr: 'B', usd: 300, ts: T0 + 10_860_000 })],
        accountCreatedAtMs: T0 - 400 * 86_400_000,
        firstTaintedAtMs: T0 + 10_800_000,
        activatorLabel: null,
        sanctionExposure: 1,
        externalFlags: ['fraudTransaction', 'stablecoinBlacklist', 'reported'],
        trxDustUsdt: false,
        hopsFromVictim: 3,
        hopsToVasp: 1,
        sharedMuleCps: 5,
        crossCaseCount: 3,
      }),
    }),
  ];
}
