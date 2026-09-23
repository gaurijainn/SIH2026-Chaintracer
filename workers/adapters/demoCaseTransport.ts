import { DEMO_CASES, USDT_TRC20, demoTransfers, type DemoCase } from '@ps26183/shared';
import { fakeTransport, type Route } from './testing';

/**
 * Simulated TronGrid + CoinGecko for the B11 demo cases (packages/shared/src/demoCases.ts). Used ONLY to record the
 * synthetic replay fixtures (scripts/record-demo-fixtures.mts); at demo/test time the same requests are served from
 * fixtures/ by DATA_MODE=replay and nothing here runs.
 */
export function demoCaseRoutes(cases: DemoCase[] = DEMO_CASES): Route[] {
  const transfers = cases.flatMap(demoTransfers);
  return [
    [
      /api\.trongrid\.io\/v1\/accounts\/([^/?]+)\/transactions\/trc20\?/,
      (req, m) => {
        const url = new URL(req.url);
        const addr = decodeURIComponent(m[1]);
        const outgoing = url.searchParams.get('only_from') === 'true';
        const min = Number(url.searchParams.get('min_timestamp') ?? 0);
        const rows = transfers.filter((t) => (outgoing ? t.from === addr : t.to === addr) && t.ts >= min);
        return {
          data: rows.map((t) => ({
            transaction_id: t.txHash,
            token_info: { address: USDT_TRC20, decimals: 6 },
            block_timestamp: t.ts,
            from: t.from,
            to: t.to,
            type: 'Transfer',
            value: String(Math.round((t.usd ?? 0) * 1_000_000)), // TronGrid reports raw 6-decimal units
          })),
          success: true,
          meta: {},
        };
      },
    ],
    [/api\.trongrid\.io\/v1\/accounts\/[^/?]+\/transactions\?/, () => ({ data: [], success: true, meta: {} })],
    [/api\.coingecko\.com\/api\/v3\/coins\/[a-z-]+\/history/, () => ({ market_data: { current_price: { usd: 1, inr: 88.1 } } })],
  ];
}

export const demoCaseTransport = (cases?: DemoCase[]) => fakeTransport(demoCaseRoutes(cases));
