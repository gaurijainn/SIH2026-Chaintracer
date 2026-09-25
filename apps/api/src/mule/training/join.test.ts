import { describe, expect, it } from 'vitest';
import type { Chain } from '@ps26183/shared';
import type { MuleFeatureInputs } from '../features';
import { sourcePriorityResolver } from './conflict';
import { joinBootstrapLabels } from './join';
import type { BootstrapLabelRow, TracedAddressProvider } from './types';

const T0 = Date.UTC(2026, 8, 1);
const iso = (ms: number) => new Date(ms).toISOString();

const TRON_ADDR_1 = 'TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ8M'; // valid checksum, reused from B1's sample fixtures
const TRON_ADDR_2 = 'TAsspXacEqxsGAo8zbxwhJrZ7Jmhj9C33U';
const TRON_ADDR_3 = 'TNDTnLegqXPSdQ2rACp6euQKNDvsnDmXCA';

function label(over: Partial<BootstrapLabelRow>): BootstrapLabelRow {
  return { address: TRON_ADDR_1, chain: 'TRON', label: 'high_risk', source: 'usdt_blacklist', fetchedAt: iso(T0), confidence: 0.9, ...over };
}

const SOME_INPUTS: MuleFeatureInputs = {
  chain: 'TRON',
  addr: TRON_ADDR_1,
  inbound: [],
  outbound: [],
  accountCreatedAtMs: null,
  firstTaintedAtMs: null,
  activatorLabel: null,
  sanctionExposure: null,
  externalFlags: [],
  trxDustUsdt: false,
  hopsFromVictim: null,
  hopsToVasp: null,
  sharedMuleCps: 0,
  crossCaseCount: 1,
};

/** A provider that knows about a fixed set of traced addresses and their MuleFeatureInputs. */
function fakeProvider(traced: Partial<Record<string, MuleFeatureInputs>>, chain: Chain = 'TRON'): TracedAddressProvider {
  return {
    listTracedAddresses: (c) => (c === chain ? Object.keys(traced) : []),
    getFeatureInputs: (c, addr) => (c === chain ? (traced[addr] ?? null) : null),
  };
}

describe('joinBootstrapLabels', () => {
  it('performs a successful join: label + traced address -> one training row with real B6 features', () => {
    const report = joinBootstrapLabels([label({})], fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }));
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ identifier: TRON_ADDR_1, chain: 'TRON', label: 'high_risk', source: 'usdt_blacklist' });
    expect(report.rows[0].features).toBeDefined();
    expect(report.rows[0].features.cross_case_count).toBe(1); // came straight from computeMuleFeatures, untouched
    expect(report.unmatchedLabels).toEqual([]);
    expect(report.conflicts).toEqual([]);
  });

  it('matches when the raw address needs normalization (same address, different valid casing/whitespace is not altered for TRON, but leading/trailing whitespace is stripped)', () => {
    const report = joinBootstrapLabels([label({ address: `  ${TRON_ADDR_1}  ` })], fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }));
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].identifier).toBe(TRON_ADDR_1);
  });

  it('reports a label with no traced address as unmatched, and never invents features for it', () => {
    const report = joinBootstrapLabels([label({ address: TRON_ADDR_2 })], fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }));
    expect(report.rows).toEqual([]);
    expect(report.unmatchedLabels).toHaveLength(1);
    expect(report.unmatchedLabels[0].address).toBe(TRON_ADDR_2);
  });

  it('reports a traced address with no confirmed label separately, and it never appears in rows', () => {
    const report = joinBootstrapLabels([], fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }));
    expect(report.rows).toEqual([]);
    expect(report.untracedAddresses).toEqual([{ chain: 'TRON', address: TRON_ADDR_1 }]);
  });

  it('combines duplicate agreeing labels from different sources: confidence via noisy-OR, evidence from both kept', () => {
    const labels = [
      label({ source: 'usdt_blacklist', confidence: 0.9, evidence: { tx: 'a' }, fetchedAt: iso(T0 + 1000) }),
      label({ source: 'ofac', confidence: 0.8, evidence: { list: 'SDN' }, fetchedAt: iso(T0) }),
    ];
    const report = joinBootstrapLabels(labels, fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }));
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.confidence).toBeCloseTo(1 - (1 - 0.9) * (1 - 0.8), 5);
    expect(row.source).toBe('ofac+usdt_blacklist'); // sorted, deterministic
    expect(row.evidence).toEqual([
      { source: 'usdt_blacklist', evidence: { tx: 'a' }, confidence: 0.9 },
      { source: 'ofac', evidence: { list: 'SDN' }, confidence: 0.8 },
    ]);
    expect(row.timestamp).toBe(iso(T0)); // earliest fetchedAt preserved as ground truth
  });

  it('rejects conflicting labels for the same address by default, and they never produce a training row', () => {
    const labels = [label({ label: 'high_risk', source: 'usdt_blacklist' }), label({ label: 'licit', source: 'manual_negative' })];
    const report = joinBootstrapLabels(labels, fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }));
    expect(report.rows).toEqual([]);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].entries).toHaveLength(2);
  });

  it('resolves a conflict only when an explicit source-priority resolver says so', () => {
    const labels = [label({ label: 'high_risk', source: 'ofac' }), label({ label: 'licit', source: 'manual_negative' })];
    const resolver = sourcePriorityResolver(['ofac', 'manual_negative']);
    const report = joinBootstrapLabels(labels, fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }), { resolveConflict: resolver });
    expect(report.conflicts).toEqual([]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].label).toBe('high_risk');
    expect(report.rows[0].source).toBe('ofac');
  });

  it('still refuses a conflict when the resolver does not recognise one of the sources', () => {
    const labels = [label({ label: 'high_risk', source: 'some_unlisted_source' }), label({ label: 'licit', source: 'manual_negative' })];
    const resolver = sourcePriorityResolver(['ofac', 'manual_negative']);
    const report = joinBootstrapLabels(labels, fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }), { resolveConflict: resolver });
    expect(report.conflicts).toHaveLength(1);
  });

  it('preserves the original evidence and source for a single, unambiguous label', () => {
    const report = joinBootstrapLabels(
      [label({ source: 'ofac', evidence: { list: 'SDN', file: 'sanctioned_addresses_TRX.txt' }, confidence: 0.7 })],
      fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }),
    );
    expect(report.rows[0].evidence).toEqual({ list: 'SDN', file: 'sanctioned_addresses_TRX.txt' });
    expect(report.rows[0].source).toBe('ofac');
    expect(report.rows[0].confidence).toBe(0.7);
    expect(report.rows[0].confidenceTier).toBe('moderate');
  });

  it('produces byte-identical, sorted output regardless of input order', () => {
    const provider = fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS, [TRON_ADDR_3]: { ...SOME_INPUTS, addr: TRON_ADDR_3 } });
    const labelsA = [label({ address: TRON_ADDR_3, source: 'ofac' }), label({ address: TRON_ADDR_1, source: 'ofac' })];
    const labelsB = [labelsA[1], labelsA[0]];
    const a = joinBootstrapLabels(labelsA, provider);
    const b = joinBootstrapLabels(labelsB, provider);
    expect(a).toEqual(b);
    // lexical sort: 'TNDTn...' < 'TQzQZ...'
    expect(a.rows.map((r) => r.identifier)).toEqual([TRON_ADDR_3, TRON_ADDR_1]);
  });

  it('reports an address that fails to normalize for its stated chain, without guessing', () => {
    const report = joinBootstrapLabels([label({ address: 'not-a-real-address' })], fakeProvider({ [TRON_ADDR_1]: SOME_INPUTS }));
    expect(report.invalidAddresses).toHaveLength(1);
    expect(report.rows).toEqual([]);
  });
});
