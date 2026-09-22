import neo4j, { type Driver, type Session } from 'neo4j-driver';

export interface CommunityResult {
  chain: string;
  addr: string;
  /** weakly-connected-component id: groups addresses into mule-ring candidates. */
  wccId: number;
  /** Louvain community id: a denser grouping within (or across) WCC components. */
  louvainId: number;
  /** collector-wallet metric: total in+out degree within the case subgraph. */
  degree: number;
  /** collector-wallet metric: how often this address sits on the shortest path between others. */
  betweenness: number;
}

const graphName = (caseId: string): string => `mule-case-${caseId}`;
const asNum = (v: unknown): number => (typeof v === 'number' ? v : neo4j.integer.toNumber(v as never));

async function dropGraph(session: Session, name: string): Promise<void> {
  // failIfMissing=false: dropping a projection that was never created (or already dropped) is a no-op.
  await session.run('CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName', { name }).catch(() => undefined);
}

/**
 * Runs WCC, Louvain, degree and betweenness on the subgraph touched by one case's traced
 * transactions only (plan B6: analyse the relevant case subgraph, never the whole database).
 * Projects a Cypher-filtered in-memory graph named after the case, streams every algorithm's
 * results, and always drops the projection again — on success or failure — so a rerun never
 * collides with a leftover named graph (idempotent, safe to rerun) and never leaks GDS memory.
 */
export async function analyzeCaseGraph(driver: Driver, caseId: string, txHashes: string[]): Promise<CommunityResult[]> {
  if (txHashes.length === 0) return [];
  const name = graphName(caseId);
  const session = driver.session();
  try {
    await dropGraph(session, name);

    const proj = await session.run(
      `CALL gds.graph.project.cypher(
         $name,
         'MATCH (a:Address) WHERE EXISTS { MATCH (a)-[t:TRANSFER]-() WHERE t.tx IN $txs } RETURN id(a) AS id',
         'MATCH (a:Address)-[t:TRANSFER]->(b:Address) WHERE t.tx IN $txs RETURN id(a) AS source, id(b) AS target',
         { parameters: { txs: $txs } }
       )
       YIELD nodeCount
       RETURN nodeCount`,
      { name, txs: txHashes },
    );
    const nodeCount = asNum(proj.records[0]?.get('nodeCount') ?? 0);
    if (nodeCount === 0) return [];

    // A single session only ever has one query in flight; run each algorithm in turn rather than
    // in parallel (gds.graph.project.cypher above is the same constraint the projection step hits).
    const wcc = await session.run('CALL gds.wcc.stream($name) YIELD nodeId, componentId RETURN nodeId, componentId', { name });
    const louvain = await session.run('CALL gds.louvain.stream($name) YIELD nodeId, communityId RETURN nodeId, communityId', { name });
    const degree = await session.run('CALL gds.degree.stream($name) YIELD nodeId, score RETURN nodeId, score', { name });
    const betweenness = await session.run('CALL gds.betweenness.stream($name) YIELD nodeId, score RETURN nodeId, score', { name });

    const wccById = new Map(wcc.records.map((r) => [asNum(r.get('nodeId')), asNum(r.get('componentId'))]));
    const louvainById = new Map(louvain.records.map((r) => [asNum(r.get('nodeId')), asNum(r.get('communityId'))]));
    const degreeById = new Map(degree.records.map((r) => [asNum(r.get('nodeId')), r.get('score') as number]));
    const betweennessById = new Map(betweenness.records.map((r) => [asNum(r.get('nodeId')), r.get('score') as number]));

    const nodeIds = [...wccById.keys()];
    const resolved = await session.run(
      'UNWIND $ids AS id MATCH (a:Address) WHERE id(a) = id RETURN id(a) AS nodeId, a.chain AS chain, a.addr AS addr',
      { ids: nodeIds.map((n) => neo4j.int(n)) },
    );

    return resolved.records.map((r) => {
      const nodeId = asNum(r.get('nodeId'));
      return {
        chain: r.get('chain') as string,
        addr: r.get('addr') as string,
        wccId: wccById.get(nodeId) ?? 0,
        louvainId: louvainById.get(nodeId) ?? 0,
        degree: degreeById.get(nodeId) ?? 0,
        betweenness: betweennessById.get(nodeId) ?? 0,
      };
    });
  } finally {
    await dropGraph(session, name);
    await session.close();
  }
}
