/**
 * Writes SYNTHETIC replay fixtures for every provider's /health probe so replay mode
 * works on a fresh clone with no keys. Real recordings come from DATA_MODE=record and
 * overwrite these (same sha1 file names). Flagged `synthetic: true` inside each file.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { PROVIDERS, fixtureKey, fixturePath, type FixtureFile } from '../packages/shared/src/index.ts';
import { MEGANODE_URL, bscActivityBody, etherscanUrl, txlistQuery } from '../apps/api/src/intake/probe.ts';
import { ncrpFeedUrl } from '../apps/api/src/intake/ncrp.ts';

const dir = process.env.FIXTURES_DIR ?? 'fixtures';
const rpcOk = { jsonrpc: '2.0', id: 1, result: '0x1312d00' };

const bodies: Record<string, unknown> = {
  trongrid: { data: [{ address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', type: 'Contract' }], success: true },
  tronscan: { database: 'ok', sync: { progress: 100 } },
  etherscan: { jsonrpc: '2.0', id: 83, result: '0x1312d00' },
  meganode: rpcOk,
  blockscout: { total_blocks: '20000000', total_transactions: '2500000000' },
  esplora: 900000,
  mempool: 900000,
  alchemy: rpcOk,
  chainabuse: [],
  coingecko: { gecko_says: '(V3) To the Moon!' },
  defillama: { coins: { 'coingecko:tron': { price: 0.25, symbol: 'TRX' } } },
  frankfurter: { amount: 1, base: 'USD', date: '2026-09-18', rates: { INR: 88.1 } },
  ankr: rpcOk,
};

for (const p of PROVIDERS) {
  const body = p.probe.data === undefined ? undefined : JSON.stringify(p.probe.data);
  const key = fixtureKey(p.probe.method, p.probe.url, body);
  const fx: FixtureFile = {
    provider: p.id,
    request: { method: p.probe.method, url: p.probe.url, body },
    response: { status: 200, data: bodies[p.id] },
    recordedAt: '2026-09-20T00:00:00.000Z',
    synthetic: true,
  };
  const file = fixturePath(dir, p.id, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(fx, null, 2) + '\n');
  console.log('wrote', file);
}

// ---- B2 replay fixtures: the mock NCRP feed and EVM chain-probe answers (synthetic) ----
async function write(provider: string, method: string, url: string, body: unknown, data: unknown) {
  const b = body === undefined ? undefined : JSON.stringify(body);
  const fx: FixtureFile = {
    provider,
    request: { method, url, body: b },
    response: { status: 200, data },
    recordedAt: '2026-09-20T00:00:00.000Z',
    synthetic: true,
  };
  const file = fixturePath(dir, provider, fixtureKey(method, url, b));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(fx, null, 2) + '\n');
  console.log('wrote', file);
}

const feed = JSON.parse(readFileSync('mocks/mock-server/data/complaints.json', 'utf8')) as { records: unknown[] };
await write('ncrp', 'GET', ncrpFeedUrl(1), undefined, { page: 1, perPage: 100, total: feed.records.length, hasMore: false, items: feed.records });

// Ambiguous EVM demo wallets (no network stated): active on Ethereum only.
const ambiguous = ['0x8Ea58f742011C8808fc43D04d5951E7d3f7e693F', '0x73fE180027a6F3e1461906039b2Fa0f90E0C8863'];
const none = { status: '0', message: 'No transactions found', result: [] };
for (const a of ambiguous) {
  await write('etherscan', 'GET', etherscanUrl('ETH', txlistQuery('txlist', a)), undefined, { status: '1', message: 'OK', result: [{ hash: '0x' + '0'.repeat(63) + '1' }] });
  await write('etherscan', 'GET', etherscanUrl('POLYGON', txlistQuery('txlist', a)), undefined, none);
  await write('etherscan', 'GET', etherscanUrl('POLYGON', txlistQuery('tokentx', a)), undefined, none);
  await write('meganode', 'POST', MEGANODE_URL, bscActivityBody(a), [{ jsonrpc: '2.0', id: 1, result: '0x0' }, { jsonrpc: '2.0', id: 2, result: '0x0' }]);
}
