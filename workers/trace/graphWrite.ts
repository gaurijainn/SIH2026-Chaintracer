import neo4j, { type Driver } from 'neo4j-driver';

/**
 * Mirrors apps/api/src/graph/graph.ts's GraphHop/writeHops (B1). Duplicated rather than imported
 * because apps/api and workers are separate packages and apps/api is not a library the worker
 * process can depend on; keep this in lockstep with B1's WRITE_HOPS query if that ever changes.
 */
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

export const HOP_BATCH_SIZE = 500;

const WRITE_HOPS = `
UNWIND $hops AS h
MERGE (a:Address {chain: h.chain, addr: h.from})
MERGE (b:Address {chain: h.chain, addr: h.to})
MERGE (a)-[t:TRANSFER {tx: h.tx, idx: h.idx}]->(b)
SET t.token = h.token, t.amount = h.amount, t.usd = h.usd, t.ts = datetime(h.ts)
`;

export async function writeGraphHops(driver: Driver, hops: GraphHop[]): Promise<void> {
  if (hops.length === 0) return;
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
