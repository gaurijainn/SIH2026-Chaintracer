import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver } from 'neo4j-driver';
import type { Env } from '@ps26183/shared';

export const HOP_BATCH_SIZE = 500;

/** One TRANSFER edge. Amounts are decimal strings, never floats; ts is an ISO-8601 UTC string. */
export interface GraphHop {
  chain: string;
  from: string;
  to: string;
  tx: string;
  idx: number;
  token: string;
  amount: string;
  usd: string | null;
  ts: string;
}

export interface EntityLink {
  chain: string;
  addr: string;
  entity: { name: string; type: string };
  heuristic: string;
  confidence: number;
}

export function createDriver(env: Pick<Env, 'NEO4J_URI' | 'NEO4J_USER' | 'NEO4J_PASSWORD'>): Driver {
  return neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
}

const CONSTRAINTS_FILE = new URL('../../../../graph/cypher/constraints.cypher', import.meta.url);

/** Applies graph/cypher/constraints.cypher (uniqueness constraints + index). Idempotent. */
export async function applySchema(driver: Driver, file: URL = CONSTRAINTS_FILE): Promise<number> {
  const text = await readFile(fileURLToPath(file), 'utf8');
  const statements = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const session = driver.session();
  try {
    for (const stmt of statements) await session.run(stmt);
  } finally {
    await session.close();
  }
  return statements.length;
}

// Idempotent write, exactly the plan's shape: MERGE nodes on (chain, addr) and the edge on (tx, idx).
const WRITE_HOPS = `
UNWIND $hops AS h
MERGE (a:Address {chain: h.chain, addr: h.from})
MERGE (b:Address {chain: h.chain, addr: h.to})
MERGE (a)-[t:TRANSFER {tx: h.tx, idx: h.idx}]->(b)
SET t.token = h.token, t.amount = h.amount, t.usd = h.usd, t.ts = datetime(h.ts)
`;

/** Writes hops in UNWIND batches of 500 rows per call. Re-running never duplicates anything. */
export async function writeHops(driver: Driver, hops: GraphHop[]): Promise<void> {
  const session = driver.session();
  try {
    for (let i = 0; i < hops.length; i += HOP_BATCH_SIZE) {
      const rows = hops.slice(i, i + HOP_BATCH_SIZE).map((h) => ({ ...h, idx: neo4j.int(h.idx) }));
      await session.executeWrite((tx) => tx.run(WRITE_HOPS, { hops: rows }));
    }
  } finally {
    await session.close();
  }
}

/** Attributes an address to a named entity: (:Address)-[:BELONGS_TO {heuristic, confidence}]->(:Entity). */
export async function linkToEntity(driver: Driver, l: EntityLink): Promise<void> {
  const session = driver.session();
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `MERGE (a:Address {chain: $chain, addr: $addr})
         MERGE (e:Entity {name: $name, type: $type})
         MERGE (a)-[b:BELONGS_TO {heuristic: $heuristic}]->(e)
         SET b.confidence = $confidence`,
        { chain: l.chain, addr: l.addr, name: l.entity.name, type: l.entity.type, heuristic: l.heuristic, confidence: l.confidence },
      ),
    );
  } finally {
    await session.close();
  }
}

export interface StoredTransfer {
  chain: string;
  from: string;
  to: string;
  tx: string;
  idx: number;
  token: string;
  amount: string;
  usd: string | null;
  ts: string;
}

/** Reads TRANSFER edges back by transaction hash (used to prove parity with PostgreSQL). */
export async function getTransfersByTx(driver: Driver, txHashes: string[]): Promise<StoredTransfer[]> {
  const session = driver.session();
  try {
    const res = await session.run(
      `MATCH (a:Address)-[t:TRANSFER]->(b:Address)
       WHERE t.tx IN $txs
       RETURN a.chain AS chain, a.addr AS from, b.addr AS to, t.tx AS tx, t.idx AS idx,
              t.token AS token, t.amount AS amount, t.usd AS usd, toString(t.ts) AS ts
       ORDER BY t.ts, t.tx`,
      { txs: txHashes },
    );
    return res.records.map((r) => ({
      chain: r.get('chain'),
      from: r.get('from'),
      to: r.get('to'),
      tx: r.get('tx'),
      idx: neo4j.integer.toNumber(r.get('idx')),
      token: r.get('token'),
      amount: r.get('amount'),
      usd: r.get('usd') ?? null,
      ts: r.get('ts'),
    }));
  } finally {
    await session.close();
  }
}

/** Shortest directed money path between two addresses: "how did money get from A to B". */
export async function pathBetween(driver: Driver, chain: string, from: string, to: string): Promise<string[]> {
  const session = driver.session();
  try {
    const res = await session.run(
      `MATCH p = shortestPath((a:Address {chain: $chain, addr: $from})-[:TRANSFER*..12]->(b:Address {chain: $chain, addr: $to}))
       RETURN [n IN nodes(p) | n.addr] AS path`,
      { chain, from, to },
    );
    return res.records[0]?.get('path') ?? [];
  } finally {
    await session.close();
  }
}

export async function getEntityOf(driver: Driver, chain: string, addr: string) {
  const session = driver.session();
  try {
    const res = await session.run(
      `MATCH (:Address {chain: $chain, addr: $addr})-[b:BELONGS_TO]->(e:Entity)
       RETURN e.name AS name, e.type AS type, b.heuristic AS heuristic, b.confidence AS confidence`,
      { chain, addr },
    );
    return res.records.map((r) => ({
      name: r.get('name') as string,
      type: r.get('type') as string,
      heuristic: r.get('heuristic') as string,
      confidence: r.get('confidence') as number,
    }));
  } finally {
    await session.close();
  }
}
