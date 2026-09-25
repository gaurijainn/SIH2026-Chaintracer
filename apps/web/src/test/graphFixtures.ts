import type { GraphResponse } from '@/features/graph/model';

const T0 = Date.parse('2026-09-20T08:00:00.000Z');
const iso = (h: number) => new Date(T0 + h * 3_600_000).toISOString();

/** Small deterministic graph. e4 is the largest single edge, but the heaviest PATH is e1 -> e2 (1000 + 900 > 1500). */
export const SMALL_GRAPH: GraphResponse = {
  traceId: 't1',
  nodes: [
    { id: 'TRON:TSEED', chain: 'TRON', addr: 'TSEED', inUsd: 0, outUsd: 2500 },
    { id: 'TRON:TMID', chain: 'TRON', addr: 'TMID', inUsd: 1000, outUsd: 950 },
    { id: 'TRON:TVASP', chain: 'TRON', addr: 'TVASP', inUsd: 900, outUsd: 0 },
    { id: 'TRON:TSIDE', chain: 'TRON', addr: 'TSIDE', inUsd: 1500, outUsd: 0 },
    { id: 'ETH:0xabc0000000000000000000000000000000000001', chain: 'ETH', addr: '0xabc0000000000000000000000000000000000001', inUsd: 50, outUsd: 0 },
  ],
  edges: [
    { id: 'e1', chain: 'TRON', txHash: 'tx1', from: 'TRON:TSEED', to: 'TRON:TMID', token: 'USDT', amount: '1000', usd: 1000, hopNo: 1, ts: iso(0) },
    { id: 'e2', chain: 'TRON', txHash: 'tx2', from: 'TRON:TMID', to: 'TRON:TVASP', token: 'USDT', amount: '900', usd: 900, hopNo: 2, ts: iso(1) },
    { id: 'e3', chain: 'ETH', txHash: 'tx3', from: 'TRON:TMID', to: 'ETH:0xabc0000000000000000000000000000000000001', token: 'USDT', amount: '50', usd: 50, hopNo: 2, ts: iso(2) },
    { id: 'e4', chain: 'TRON', txHash: 'tx4', from: 'TRON:TSEED', to: 'TRON:TSIDE', token: 'USDT', amount: '1500', usd: 1500, hopNo: 1, ts: iso(3) },
  ],
};

/**
 * ~1,000-node synthetic trace for the frontend performance test ONLY (never production data): a layered flow of 10 hops
 * with fan-out, deterministic (seeded LCG), plus a few cross-layer edges to keep it realistic rather than a pure tree.
 */
export function syntheticGraph(nodeCount = 1000): GraphResponse {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const chains = ['TRON', 'TRON', 'TRON', 'ETH', 'BSC'] as const;
  const nodes: GraphResponse['nodes'] = [];
  const layers: string[][] = [];
  const perLayer = Math.ceil((nodeCount - 1) / 9);
  for (let l = 0; l < 10 && nodes.length < nodeCount; l++) {
    const layer: string[] = [];
    for (let i = 0; i < (l === 0 ? 1 : perLayer) && nodes.length < nodeCount; i++) {
      const chain = chains[Math.floor(rnd() * chains.length)];
      const addr = `${chain === 'TRON' ? 'T' : '0x'}syn${l}x${i}`;
      nodes.push({ id: `${chain}:${addr}`, chain, addr, inUsd: 0, outUsd: 0 });
      layer.push(`${chain}:${addr}`);
    }
    layers.push(layer);
  }
  const edges: GraphResponse['edges'] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let k = 0;
  const link = (from: string, to: string, hopNo: number) => {
    const usd = Math.round(10 + rnd() * rnd() * 50_000);
    edges.push({ id: `se${k}`, chain: byId.get(to)!.chain, txHash: `stx${k}`, from, to, token: 'USDT', amount: String(usd), usd, hopNo, ts: new Date(Date.parse('2026-09-01T00:00:00Z') + k * 600_000).toISOString() });
    k++;
  };
  for (let l = 1; l < layers.length; l++) {
    for (const to of layers[l]) link(layers[l - 1][Math.floor(rnd() * layers[l - 1].length)], to, l);
    for (let x = 0; x < layers[l].length / 5; x++) link(layers[l - 1][Math.floor(rnd() * layers[l - 1].length)], layers[l][Math.floor(rnd() * layers[l].length)], l);
  }
  return { traceId: 'synthetic', nodes, edges };
}
