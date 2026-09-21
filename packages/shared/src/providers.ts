import { USDT_TRC20 } from './constants';

/**
 * Every external provider from plan Section 3, with a cheap probe used by /health.
 * `{NAME}` tokens are substituted from the environment only at the moment of a real
 * network call, so fixture hashes (sha1 of the URL) never depend on secrets.
 */
export interface ProviderDef {
  id: string;
  label: string;
  /** Env var holding the key; undefined = keyless provider. */
  keyEnv?: string;
  /** Key is nice-to-have rather than required for a green health check. */
  keyOptional?: boolean;
  probe: { method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; data?: unknown };
}

const rpc = (method: string) => ({ jsonrpc: '2.0', id: 1, method, params: [] });

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'trongrid', label: 'TronGrid', keyEnv: 'TRONGRID_KEY',
    probe: { method: 'GET', url: `https://api.trongrid.io/v1/accounts/${USDT_TRC20}`, headers: { 'TRON-PRO-API-KEY': '{TRONGRID_KEY}' } },
  },
  {
    id: 'tronscan', label: 'Tronscan', keyEnv: 'TRONSCAN_KEY',
    probe: { method: 'GET', url: 'https://apilist.tronscanapi.com/api/system/status', headers: { 'TRON-PRO-API-KEY': '{TRONSCAN_KEY}' } },
  },
  {
    id: 'etherscan', label: 'Etherscan V2', keyEnv: 'ETHERSCAN_KEY',
    probe: { method: 'GET', url: 'https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey={ETHERSCAN_KEY}' },
  },
  {
    id: 'meganode', label: 'NodeReal MegaNode (BSC)', keyEnv: 'MEGANODE_KEY',
    probe: { method: 'POST', url: 'https://bsc-mainnet.nodereal.io/v1/{MEGANODE_KEY}', data: rpc('eth_blockNumber') },
  },
  {
    id: 'blockscout', label: 'Blockscout', keyEnv: 'BLOCKSCOUT_KEY', keyOptional: true,
    probe: { method: 'GET', url: 'https://eth.blockscout.com/api/v2/stats' },
  },
  {
    id: 'esplora', label: 'Blockstream Esplora',
    probe: { method: 'GET', url: 'https://blockstream.info/api/blocks/tip/height' },
  },
  {
    id: 'mempool', label: 'mempool.space',
    probe: { method: 'GET', url: 'https://mempool.space/api/blocks/tip/height' },
  },
  {
    id: 'alchemy', label: 'Alchemy', keyEnv: 'ALCHEMY_KEY',
    probe: { method: 'POST', url: 'https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}', data: rpc('eth_blockNumber') },
  },
  {
    id: 'chainabuse', label: 'Chainabuse', keyEnv: 'CHAINABUSE_KEY',
    probe: { method: 'GET', url: 'https://api.chainabuse.com/v0/reports?page=1&perPage=1', headers: { Authorization: 'Basic {CHAINABUSE_BASIC}' } },
  },
  {
    id: 'coingecko', label: 'CoinGecko Demo', keyEnv: 'COINGECKO_DEMO_KEY',
    probe: { method: 'GET', url: 'https://api.coingecko.com/api/v3/ping', headers: { 'x-cg-demo-api-key': '{COINGECKO_DEMO_KEY}' } },
  },
  {
    id: 'defillama', label: 'DefiLlama',
    probe: { method: 'GET', url: 'https://coins.llama.fi/prices/current/coingecko:tron' },
  },
  {
    id: 'frankfurter', label: 'Frankfurter',
    probe: { method: 'GET', url: 'https://api.frankfurter.app/latest?from=USD&to=INR' },
  },
  {
    id: 'ankr', label: 'Ankr TRON RPC (failover)', keyEnv: 'ANKR_KEY', keyOptional: true,
    probe: { method: 'POST', url: 'https://rpc.ankr.com/tron_jsonrpc/{ANKR_KEY}', data: rpc('eth_blockNumber') },
  },
];
