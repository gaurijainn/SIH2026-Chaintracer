import type { Driver, Integer } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import { HOP_BATCH_SIZE, applySchema, createDriver, getEntityOf, getTransfersByTx, linkToEntity, pathBetween, writeHops, type GraphHop } from './graph';

let driver: Driver;
const chain = `TESTCHAIN${Date.now()}`; // isolated namespace inside the shared database

const hop = (i: number, over: Partial<GraphHop> = {}): GraphHop => ({
  chain, from: `F${i}`, to: `T${i}`, tx: `tx${i}`, idx: 0, token: 'USDT', amount: '1.500000', usd: '1.5', ts: '2026-09-01T08:10:00.000Z', ...over,
});

async function q<T = unknown>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const s = driver.session();
  try {
    return (await s.run(cypher, params)).records.map((r) => r.toObject() as T);
  } finally {
    await s.close();
  }
}
const counts = async () => {
  const [{ n }] = await q<{ n: Integer }>('MATCH (a:Address {chain: $chain}) RETURN count(a) AS n', { chain });
  const [{ e }] = await q<{ e: Integer }>('MATCH (:Address {chain: $chain})-[t:TRANSFER]->() RETURN count(t) AS e', { chain });
  return { nodes: n.toNumber(), edges: e.toNumber() };
};

beforeAll(async () => {
  driver = createDriver(loadEnv());
  await applySchema(driver);
});
afterAll(async () => {
  await q('MATCH (a:Address {chain: $chain}) DETACH DELETE a', { chain });
  await q('MATCH (e:Entity) WHERE e.name STARTS WITH $p DETACH DELETE e', { p: chain });
  await driver.close();
});

describe('Neo4j schema', () => {
  it('creates the (chain, addr) uniqueness constraint and is re-runnable', async () => {
    await applySchema(driver);
    const cs = await q<{ name: string; labelsOrTypes: string[]; properties: string[]; type: string }>('SHOW CONSTRAINTS');
    const addr = cs.find((c) => c.name === 'address_chain_addr');
    expect(addr).toMatchObject({ type: 'UNIQUENESS', labelsOrTypes: ['Address'], properties: ['chain', 'addr'] });
    expect(cs.find((c) => c.name === 'entity_name_type')).toMatchObject({ labelsOrTypes: ['Entity'], properties: ['name', 'type'] });
  });

  it('rejects a duplicate Address node at the database level', async () => {
    await q('CREATE (:Address {chain: $chain, addr: "DUP"})', { chain });
    await expect(q('CREATE (:Address {chain: $chain, addr: "DUP"})', { chain })).rejects.toThrow(/already exists/i);
  });
});

describe('writeHops', () => {
  it('writes Address nodes and TRANSFER edges with string amounts and datetime ts', async () => {
    await writeHops(driver, [hop(1), hop(2)]);
    expect(await counts()).toMatchObject({ edges: 2 });
    const rows = await getTransfersByTx(driver, ['tx1']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ chain, from: 'F1', to: 'T1', tx: 'tx1', idx: 0, token: 'USDT', amount: '1.500000', usd: '1.5' });
    expect(new Date(rows[0].ts).toISOString()).toBe('2026-09-01T08:10:00.000Z');
    expect(typeof rows[0].amount).toBe('string');
  });

  it('is idempotent: re-running the same hops adds no nodes or edges', async () => {
    const hops = [hop(10), hop(11), hop(12)];
    await writeHops(driver, hops);
    const first = await counts();
    await writeHops(driver, hops);
    await writeHops(driver, hops);
    expect(await counts()).toEqual(first);
  });

  it('updates an edge in place when the same (tx, idx) is rewritten', async () => {
    await writeHops(driver, [hop(20)]);
    const before = await counts();
    await writeHops(driver, [hop(20, { amount: '9.000000' })]);
    expect(await counts()).toEqual(before);
    expect((await getTransfersByTx(driver, ['tx20']))[0].amount).toBe('9.000000');
  });

  it('keeps two transfers in one transaction apart by idx', async () => {
    await writeHops(driver, [hop(30, { idx: 0 }), hop(30, { idx: 1, amount: '2' })]);
    expect((await getTransfersByTx(driver, ['tx30'])).map((r) => r.idx).sort()).toEqual([0, 1]);
  });

  it('batches large writes (> 500 rows per call) and stays idempotent', async () => {
    const n = HOP_BATCH_SIZE * 2 + 37;
    const hops = Array.from({ length: n }, (_, i) => hop(1000 + i, { from: `BF${i}`, to: `BT${i}` }));
    const before = await counts();
    await writeHops(driver, hops);
    const after = await counts();
    expect(after.edges - before.edges).toBe(n);
    await writeHops(driver, hops);
    expect(await counts()).toEqual(after);
  });
});

describe('BELONGS_TO and paths', () => {
  it('links an address to an Entity idempotently with heuristic and confidence', async () => {
    const link = { chain, addr: 'T1', entity: { name: `${chain}-Exchange`, type: 'CENTRALISED_EXCHANGE' }, heuristic: 'H4_DIRECT_LABEL', confidence: 0.95 };
    await linkToEntity(driver, link);
    await linkToEntity(driver, link);
    await linkToEntity(driver, { ...link, confidence: 0.97 });
    const es = await getEntityOf(driver, chain, 'T1');
    expect(es).toEqual([{ name: `${chain}-Exchange`, type: 'CENTRALISED_EXCHANGE', heuristic: 'H4_DIRECT_LABEL', confidence: 0.97 }]);
    const [{ n }] = await q<{ n: Integer }>('MATCH (e:Entity {name: $n}) RETURN count(e) AS n', { n: `${chain}-Exchange` });
    expect(n.toNumber()).toBe(1);
  });

  it('answers "how did money get from A to B" with a path query', async () => {
    await writeHops(driver, [hop(40, { from: 'PA', to: 'PB' }), hop(41, { from: 'PB', to: 'PC' }), hop(42, { from: 'PC', to: 'PD' })]);
    expect(await pathBetween(driver, chain, 'PA', 'PD')).toEqual(['PA', 'PB', 'PC', 'PD']);
    expect(await pathBetween(driver, chain, 'PD', 'PA')).toEqual([]);
  });
});
