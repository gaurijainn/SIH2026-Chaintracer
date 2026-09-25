import { describe, expect, it } from 'vitest';
import { USDT_TRC20, loadEnv } from '@ps26183/shared';
import { createChainLayer } from '@ps26183/workers/adapters';
import { fakeTransport, tronAddr, type Route } from '@ps26183/workers/adapters/testing';
import { ChainLayerTracedAddressProvider } from './tracedAddressProvider';

const ADDR = tronAddr('traced-a');
const OTHER = tronAddr('traced-b');

function layer(routes: Route[]) {
  const env = { ...loadEnv({ DATA_MODE: 'live' }), FIXTURES_DIR: 'unused' };
  return createChainLayer({ env, transport: fakeTransport(routes), pricing: false, guard: { unlimited: true, sleep: async () => undefined, random: () => 0 } });
}

const routes: Route[] = [
  [new RegExp(`v1/accounts/${ADDR}/transactions/trc20\\?.*only_to=true`), () => ({ data: [{ transaction_id: 'a'.repeat(64), token_info: { symbol: 'USDT', address: USDT_TRC20, decimals: 6 }, block_timestamp: 1_700_000_100_000, from: OTHER, to: ADDR, type: 'Transfer', value: '5000000' }], success: true, meta: {} })],
  [new RegExp(`v1/accounts/${ADDR}/transactions/trc20\\?.*only_from=true`), () => ({ data: [], success: true, meta: {} })],
  [new RegExp(`v1/accounts/${ADDR}/transactions\\?`), () => ({ data: [], success: true, meta: {} })],
  [new RegExp(`tronscanapi\\.com/api/accountv2\\?address=${ADDR}`), () => ({ date_created: 1_699_000_000_000, addressTag: '' })],
  [new RegExp(`api/security/account/data\\?address=${ADDR}`), () => ({ is_black_list: false, has_fraud_transaction: false, fraud_token_creator: false, send_ad_by_memo: false })],
];

describe('ChainLayerTracedAddressProvider (real B3 data, replay/fake-backed)', () => {
  it('builds real MuleFeatureInputs from B3 getTransfers/getAccountMeta, never inventing values', async () => {
    const l = layer(routes);
    const provider = await ChainLayerTracedAddressProvider.build(l, 'TRON', [ADDR]);
    expect(provider.listTracedAddresses('TRON')).toEqual([ADDR]);
    const inputs = provider.getFeatureInputs('TRON', ADDR)!;
    expect(inputs.inbound).toHaveLength(1);
    expect(inputs.inbound[0]).toMatchObject({ fromAddr: OTHER, toAddr: ADDR, token: USDT_TRC20, amount: '5' });
    expect(inputs.outbound).toEqual([]);
    expect(inputs.accountCreatedAtMs).toBe(1_699_000_000_000);
    expect(inputs.firstTaintedAtMs).toBe(1_700_000_100_000);
  });

  it('leaves case-graph-dependent fields null/0, never fabricated, and records them as missing', async () => {
    const l = layer(routes);
    const provider = await ChainLayerTracedAddressProvider.build(l, 'TRON', [ADDR]);
    const inputs = provider.getFeatureInputs('TRON', ADDR)!;
    expect(inputs.hopsFromVictim).toBeNull();
    expect(inputs.hopsToVasp).toBeNull();
    expect(inputs.sanctionExposure).toBeNull();
    expect(inputs.sharedMuleCps).toBe(0);
    expect(inputs.crossCaseCount).toBe(0);
    expect(provider.missingFieldsFor('TRON', ADDR)).toEqual(expect.arrayContaining(['sanctionExposure', 'hopsFromVictim', 'hopsToVasp']));
  });

  it('returns null for an address it never traced (never invents a feature vector)', async () => {
    const l = layer(routes);
    const provider = await ChainLayerTracedAddressProvider.build(l, 'TRON', [ADDR]);
    expect(provider.getFeatureInputs('TRON', OTHER)).toBeNull();
  });
});
