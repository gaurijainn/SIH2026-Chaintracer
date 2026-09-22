/**
 * Test / demo support for the provider layer. NOT imported by production code.
 * `fakeTransport` scripts provider responses; `demoTransport` simulates the providers with a deterministic dataset
 * (used to record the shipped replay fixtures, in the smoke check and in tests).
 */
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { createHash } from 'node:crypto';
import { USDT_TRC20, tronHexToBase58 } from '@ps26183/shared';

export interface Req {
  url: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
}
const REPLY = Symbol('reply');
export interface Reply {
  [REPLY]: true;
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}
/** Handlers return a plain body (HTTP 200) or reply(body, status, headers) for anything else. */
export const reply = (data: unknown, status = 200, headers?: Record<string, string>): Reply => ({ [REPLY]: true, status, data, headers });
export type Handler = (req: Req, m: RegExpMatchArray) => Reply | unknown;
export type Route = [RegExp, Handler];
export type FakeTransport = AxiosAdapter & { calls: Req[] };

const isReply = (r: unknown): r is Reply => !!r && typeof r === 'object' && (r as Record<symbol, unknown>)[REPLY] === true;

/** Routes are matched in order on the full request URL. Replies with status >= 400 raise an AxiosError like a real transport. */
export function fakeTransport(routes: Route[]): FakeTransport {
  const calls: Req[] = [];
  const t = (async (config: InternalAxiosRequestConfig) => {
    const url = axios.getUri(config);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.headers?.toJSON?.() ?? {})) headers[k.toLowerCase()] = String(v);
    let body: unknown;
    try {
      body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    } catch {
      body = config.data;
    }
    const req: Req = { url, method: (config.method ?? 'get').toUpperCase(), body, headers };
    calls.push(req);
    for (const [re, handler] of routes) {
      const m = url.match(re);
      if (!m) continue;
      const out = handler(req, m);
      const rep: Reply = isReply(out) ? out : reply(out);
      const status = rep.status;
      const response = { data: rep.data, status, statusText: String(status), headers: rep.headers ?? {}, config, request: {} };
      const accepted = config.validateStatus ? config.validateStatus(status) : status >= 200 && status < 300; // like axios settle()
      if (!accepted) throw new AxiosError(`Request failed with status code ${status}`, String(status), config, {}, response);
      return response;
    }
    throw new AxiosError(`fakeTransport: no route for ${req.method} ${url}`, 'ERR_NO_ROUTE', config);
  }) as FakeTransport;
  t.calls = calls;
  return t;
}

/** Wraps a transport so that some calls fail first: every Nth call returns `status` (429 by default). */
export function throttled(inner: FakeTransport, opts: { every: number; status?: number; retryAfterSeconds?: number }): FakeTransport {
  let n = 0;
  const t = (async (config: InternalAxiosRequestConfig) => {
    n++;
    if (n % opts.every === 0) {
      const status = opts.status ?? 429;
      const response = { data: { error: 'rate limited' }, status, statusText: String(status), headers: opts.retryAfterSeconds ? { 'retry-after': String(opts.retryAfterSeconds) } : {}, config, request: {} };
      throw new AxiosError(`Request failed with status code ${status}`, String(status), config, {}, response);
    }
    return inner(config);
  }) as FakeTransport;
  Object.defineProperty(t, 'calls', { get: () => inner.calls });
  return t;
}

// ------------------------------------------------------------------------------------------------------------
// Deterministic demo dataset

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const hexAddr = (seed: string) => '41' + sha(seed).slice(0, 40);
export const tronAddr = (seed: string) => tronHexToBase58(hexAddr(seed));

export const DEMO = {
  /** a busy TRON wallet with 1,050 outgoing USDT-TRC20 transfers */
  tronBusy: tronAddr('demo-busy-tron'),
  tronBusyTotal: 1050,
  tronActivator: tronAddr('demo-activator'),
  ethAddr: '0x73fE180027a6F3e1461906039b2Fa0f90E0C8863',
  btcAddr: '1BWrhsLSGTPoM9vsiaFPtDahPQ73fhUdFN',
  /** newest demo transfer: 2026-09-01T12:00:00Z */
  t0: Date.UTC(2026, 8, 1, 12, 0, 0),
};

const PRICE_USD: Record<string, number> = { tether: 1.0, tron: 0.25, ethereum: 4100, bitcoin: 112000, binancecoin: 720, 'polygon-ecosystem-token': 0.4 };
const USD_INR = 88.1;

export function tronBusyTransfer(i: number) {
  return {
    transaction_id: sha(`busy-tx-${i}`),
    token_info: { symbol: 'USDT', address: USDT_TRC20, decimals: 6, name: 'Tether USD' },
    block_timestamp: DEMO.t0 - i * 60_000,
    from: DEMO.tronBusy,
    to: tronAddr(`demo-recipient-${i % 41}`),
    type: 'Transfer',
    value: String(1_000_000 + ((i * 7919) % 900_000_000)),
  };
}

const qp = (url: string, k: string) => new URL(url).searchParams.get(k);

/** TronGrid TRC-20 history with fingerprint paging, honouring limit, min_timestamp and only_from/only_to. */
function tronGridTrc20(req: Req) {
  const limit = Number(qp(req.url, 'limit') ?? 20);
  const min = Number(qp(req.url, 'min_timestamp') ?? 0);
  const offset = Number((qp(req.url, 'fingerprint') ?? 'fp0').replace('fp', ''));
  const outgoing = qp(req.url, 'only_from') === 'true';
  const all = outgoing ? Array.from({ length: DEMO.tronBusyTotal }, (_, i) => tronBusyTransfer(i)).filter((t) => t.block_timestamp >= min) : [];
  const data = all.slice(offset, offset + limit);
  const more = offset + limit < all.length;
  return { data, success: true, meta: { at: DEMO.t0, page_size: data.length, ...(more ? { fingerprint: `fp${offset + limit}` } : {}) } };
}

function tronGridTrx(req: Req) {
  const inbound = qp(req.url, 'only_to') === 'true';
  const data =
    inbound && qp(req.url, 'order_by')
      ? [
          {
            txID: sha('activation-tx'),
            blockNumber: 61_000_000,
            block_timestamp: DEMO.t0 - 40 * 86_400_000,
            ret: [{ contractRet: 'SUCCESS' }],
            raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: hexAddr('demo-activator'), to_address: hexAddr('demo-busy-tron'), amount: 1_000_000 } } }] },
          },
        ]
      : [];
  return { data, success: true, meta: {} };
}

const cgHistory = (id: string) => ({ market_data: { current_price: { usd: PRICE_USD[id], inr: PRICE_USD[id] * USD_INR } } });

export function demoRoutes(): Route[] {
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  return [
    // --- TRON
    [/api\.trongrid\.io\/v1\/accounts\/[^/?]+\/transactions\/trc20\?/, (r) => tronGridTrc20(r)],
    [/api\.trongrid\.io\/v1\/accounts\/[^/?]+\/transactions\?/, (r) => tronGridTrx(r)],
    [/api\.trongrid\.io\/v1\/accounts\/[^/?]+$/, () => ({ data: [{ address: DEMO.tronBusy }], success: true })],
    [/api\.trongrid\.io\/wallet\/gettransactionbyid/, (r) => ((r.body as { value?: string })?.value === sha('activation-tx') ? { txID: sha('activation-tx') } : {})],
    [/tronscanapi\.com\/api\/accountv2/, () => ({ date_created: DEMO.t0 - 41 * 86_400_000, addressTag: '' })],
    [/tronscanapi\.com\/api\/security\/account\/data/, () => ({ is_black_list: false, has_fraud_transaction: true, fraud_token_creator: false, send_ad_by_memo: false })],
    // --- Ethereum (Etherscan V2)
    [
      /api\.etherscan\.io\/v2\/api\?chainid=1&module=account&action=tokentx/,
      () => ({
        status: '1', message: 'OK',
        result: [
          { hash: '0x' + sha('eth-1'), from: DEMO.ethAddr.toLowerCase(), to: '0x' + sha('eth-r1').slice(0, 40), value: '2500000000', tokenDecimal: '6', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', blockNumber: '23000000', timeStamp: String(Math.floor(DEMO.t0 / 1000)) },
        ],
      }),
    ],
    [
      /api\.etherscan\.io\/v2\/api\?chainid=1&module=account&action=txlist&/,
      () => ({ status: '1', message: 'OK', result: [{ hash: '0x' + sha('eth-2'), from: DEMO.ethAddr.toLowerCase(), to: '0x' + sha('eth-r2').slice(0, 40), value: '1000000000000000000', isError: '0', blockNumber: '23000010', timeStamp: String(Math.floor(DEMO.t0 / 1000) + 60) }] }),
    ],
    [/api\.etherscan\.io\/v2\/api\?chainid=1&module=account&action=txlistinternal/, () => ({ status: '0', message: 'No transactions found', result: [] })],
    // --- Bitcoin (Esplora)
    [
      new RegExp('blockstream\\.info/api/address/[^/]+/txs$'),
      () => [
        {
          txid: sha('btc-1'),
          vin: [{ prevout: { scriptpubkey_address: DEMO.btcAddr, value: 50_000_000 } }],
          vout: [{ scriptpubkey_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', value: 30_000_000 }, { scriptpubkey_address: DEMO.btcAddr, value: 19_990_000 }],
          status: { confirmed: true, block_height: 900_000, block_time: Math.floor(DEMO.t0 / 1000) },
        },
      ],
    ],
    [/blockstream\.info\/api\/tx\/[0-9a-f]{64}\/outspends/, () => [{ spent: true, txid: sha('btc-2'), vin: 0, status: { confirmed: true, block_height: 900_010, block_time: Math.floor(DEMO.t0 / 1000) + 600 } }, { spent: false }]],
    // --- prices: CoinGecko history per UTC day
    [/api\.coingecko\.com\/api\/v3\/coins\/([a-z-]+)\/history\?date=(\d\d)-(\d\d)-(\d{4})/, (_r, m) => cgHistory(m[1])],
    [/coins\.llama\.fi\/prices\/historical\/(\d+)\/coingecko:([a-z-]+)/, (_r, m) => ({ coins: { [`coingecko:${m[2]}`]: { price: PRICE_USD[m[2]], timestamp: Number(m[1]) } } })],
    [/api\.frankfurter\.app\/[\d-]+\?from=USD&to=INR/, (r) => ({ amount: 1, base: 'USD', date: day(DEMO.t0), rates: { INR: USD_INR }, _url: r.url })],
  ];
}

export const demoTransport = () => fakeTransport(demoRoutes());
