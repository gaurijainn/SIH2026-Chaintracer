import { describe, expect, it } from 'vitest';
import { USDT_TRC20, loadEnv } from '@ps26183/shared';
import { createChainLayer } from '@ps26183/workers/adapters';
import { fakeTransport, tronAddr, type Route } from '@ps26183/workers/adapters/testing';
import { buildNegativeCandidate, buildNegativeCandidates, confirmedNegatives, negativeCandidatesToLabelRows } from './negativeCandidates';

const NOW = '2026-09-23T00:00:00.000Z';
const ACTIVE_USDT_HOLDER = tronAddr('neg-active-usdt');
const INACTIVE = tronAddr('neg-inactive');
const ACTIVE_NO_USDT = tronAddr('neg-active-no-usdt');
const TAGGED_EXCHANGE = tronAddr('neg-exchange');

function layer(routes: Route[]) {
  const env = { ...loadEnv({ DATA_MODE: 'live' }), FIXTURES_DIR: 'unused' };
  return createChainLayer({ env, transport: fakeTransport(routes), pricing: false, guard: { unlimited: true, sleep: async () => undefined, random: () => 0 } });
}

const trc20 = (id: string, from: string, to: string, value = '1000000') => ({ transaction_id: id, token_info: { symbol: 'USDT', address: USDT_TRC20, decimals: 6 }, block_timestamp: 1_756_000_000_000, from, to, type: 'Transfer', value });

const routesFor = (addr: string, opts: { active: boolean; usdt: boolean; tag?: string; blacklisted?: boolean }): Route[] => [
  [new RegExp(`tronscanapi\\.com/api/accountv2\\?address=${addr}`), () => ({ date_created: 1_700_000_000_000, addressTag: opts.tag ?? '' })],
  [new RegExp(`api/security/account/data\\?address=${addr}`), () => ({ is_black_list: opts.blacklisted ?? false, has_fraud_transaction: false, fraud_token_creator: false, send_ad_by_memo: false })],
  [new RegExp(`v1/accounts/${addr}$`), () => (opts.active ? { data: [{ address: addr }], success: true } : { data: [], success: true })],
  [new RegExp(`v1/accounts/${addr}/transactions/trc20\\?`), () => (opts.usdt ? { data: [trc20('a'.repeat(64), addr, tronAddr('r'))], success: true, meta: {} } : { data: [], success: true, meta: {} })],
  [new RegExp(`v1/accounts/${addr}/transactions\\?`), () => ({ data: [], success: true, meta: {} })],
];

describe('buildNegativeCandidate', () => {
  it('marks a known VASP/high-risk address excluded without any provider call', async () => {
    const l = layer([]);
    const row = await buildNegativeCandidate(TAGGED_EXCHANGE, 'TRON', { tron: l.tron, excludedAddresses: new Set([TAGGED_EXCHANGE]), nowIso: NOW });
    expect(row.status).toBe('excluded');
    expect(row.exclusion_reason).toMatch(/known VASP/);
  });

  it('excludes an address Tronscan itself tags as an exchange/service', async () => {
    const l = layer(routesFor(TAGGED_EXCHANGE, { active: true, usdt: true, tag: 'Some Exchange' }));
    const row = await buildNegativeCandidate(TAGGED_EXCHANGE, 'TRON', { tron: l.tron, excludedAddresses: new Set(), nowIso: NOW });
    expect(row.status).toBe('excluded');
    expect(row.exclusion_reason).toContain('exchange_associated');
  });

  it('marks an address with no TronGrid account activity as undetermined, never licit-by-absence', async () => {
    const l = layer(routesFor(INACTIVE, { active: false, usdt: false }));
    const row = await buildNegativeCandidate(INACTIVE, 'TRON', { tron: l.tron, excludedAddresses: new Set(), nowIso: NOW });
    expect(row.status).toBe('undetermined');
    expect(row.activity_evidence).toEqual({});
  });

  it('marks an active address with no observed USDT activity as undetermined (activity alone is not enough)', async () => {
    const l = layer(routesFor(ACTIVE_NO_USDT, { active: true, usdt: false }));
    const row = await buildNegativeCandidate(ACTIVE_NO_USDT, 'TRON', { tron: l.tron, excludedAddresses: new Set(), nowIso: NOW });
    expect(row.status).toBe('undetermined');
    expect(row.usdt_holder_evidence).toEqual({});
  });

  it('includes a candidate only once both real activity AND real USDT-holder evidence are observed', async () => {
    const l = layer(routesFor(ACTIVE_USDT_HOLDER, { active: true, usdt: true }));
    const row = await buildNegativeCandidate(ACTIVE_USDT_HOLDER, 'TRON', { tron: l.tron, excludedAddresses: new Set(), nowIso: NOW });
    expect(row.status).toBe('included');
    expect(row.activity_evidence).not.toEqual({});
    expect(row.usdt_holder_evidence).not.toEqual({});
  });
});

describe('buildNegativeCandidates / confirmedNegatives / negativeCandidatesToLabelRows', () => {
  it('processes a deterministically sorted address list and only promotes INCLUDED rows to licit label rows', async () => {
    const l = layer([
      ...routesFor(ACTIVE_USDT_HOLDER, { active: true, usdt: true }),
      ...routesFor(INACTIVE, { active: false, usdt: false }),
    ]);
    const rows = await buildNegativeCandidates([INACTIVE, ACTIVE_USDT_HOLDER], 'TRON', { tron: l.tron, excludedAddresses: new Set(), nowIso: NOW });
    expect(rows.map((r) => r.address)).toEqual([ACTIVE_USDT_HOLDER, INACTIVE].sort()); // stable sort
    const confirmed = confirmedNegatives(rows);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].address).toBe(ACTIVE_USDT_HOLDER);

    const labelRows = negativeCandidatesToLabelRows(rows, NOW);
    expect(labelRows).toHaveLength(1);
    expect(labelRows[0]).toMatchObject({ address: ACTIVE_USDT_HOLDER, chain: 'TRON', label: 'licit', confidence: 1 });
  });
});
