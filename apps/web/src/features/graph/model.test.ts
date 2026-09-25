import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import fcose from 'cytoscape-fcose';
import { describe, expect, it } from 'vitest';
import { SMALL_GRAPH, syntheticGraph } from '@/test/graphFixtures';
import { graphQuery, NO_FILTERS } from './api';
import { layoutOptions, resolveLayout, syncElements } from './GraphCanvas';
import {
  buildGraph, CHAIN_BORDER, edgeKey, edgeWidth, explorerUrl, graphResponseSchema, heaviestPath, mergeHop, nodeLabel, parseHopEvent, ROLE_META, timeRange, vaspKey, visibleGraph,
  type GEdge, type GNode, type GraphModel, type NodeRole,
} from './model';
import { buildStylesheet, FALLBACK_PALETTE, nodeData, roleIconUri, toElements } from './style';

const ETH_ADDR = '0xabc0000000000000000000000000000000000001';
const vasps = new Map([[vaspKey('TRON', 'TVASP'), { name: 'Demo Exchange' }]]);
const model = () => buildGraph(SMALL_GRAPH, vasps);
const node = (id: string) => model().nodes.find((n) => n.id === id)!;

describe('graph response validation', () => {
  it('accepts the backend contract, keeping optional role/risk/label/community when the backend adds them', () => {
    expect(graphResponseSchema.safeParse(SMALL_GRAPH).success).toBe(true);
    const richer = { ...SMALL_GRAPH, nodes: [{ ...SMALL_GRAPH.nodes[0], role: 'victim', riskBand: 'HIGH', label: 'Victim wallet', communityId: 'c1' }] };
    const parsed = graphResponseSchema.parse(richer);
    expect(parsed.nodes[0]).toMatchObject({ role: 'victim', riskBand: 'HIGH', communityId: 'c1' });
  });

  it.each([
    ['not an object', 'nope'],
    ['missing edges', { traceId: 't', nodes: [] }],
    ['unknown chain', { ...SMALL_GRAPH, nodes: [{ ...SMALL_GRAPH.nodes[0], chain: 'SOLANA' }] }],
    ['NaN value', { ...SMALL_GRAPH, edges: [{ ...SMALL_GRAPH.edges[0], usd: Number.NaN }] }],
    ['bad timestamp', { ...SMALL_GRAPH, edges: [{ ...SMALL_GRAPH.edges[0], ts: 'yesterday' }] }],
    ['unknown role', { ...SMALL_GRAPH, nodes: [{ ...SMALL_GRAPH.nodes[0], role: 'whale' }] }],
  ])('rejects %s', (_n, body) => {
    expect(graphResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('building the model without inventing data', () => {
  it('takes VASP identity only from the registry and defaults everything else to an unclassified wallet with unknown risk', () => {
    const vasp = node('TRON:TVASP');
    expect(vasp).toMatchObject({ role: 'vasp', roleSource: 'registry', label: 'Demo Exchange', risk: 'UNKNOWN' });
    const wallet = node('TRON:TMID');
    expect(wallet).toMatchObject({ role: 'wallet', roleSource: 'default', label: null, risk: 'UNKNOWN', communityId: null });
  });

  it('matches EVM registry addresses case-insensitively', () => {
    const idx = new Map([[vaspKey('ETH', ETH_ADDR.toUpperCase().replace('0X', '0x')), { name: 'EvmEx' }]]);
    expect(buildGraph(SMALL_GRAPH, idx).nodes.find((n) => n.chain === 'ETH')?.role).toBe('vasp');
  });

  it('derives cross-chain from the endpoints and computes hop levels', () => {
    const m = model();
    expect(m.edges.find((e) => e.id === 'e3')!.crossChain).toBe(true);
    expect(m.edges.find((e) => e.id === 'e1')!.crossChain).toBe(false);
    expect(node('TRON:TSEED').hop).toBe(0);
    expect(node('TRON:TVASP').hop).toBe(2);
  });

  it('drops a repeated transfer', () => {
    const dup = { ...SMALL_GRAPH, edges: [...SMALL_GRAPH.edges, { ...SMALL_GRAPH.edges[0], id: 'other-id' }] };
    expect(buildGraph(dup).edges).toHaveLength(4);
  });

  it('creates a node for an edge endpoint the node list omitted', () => {
    const g = buildGraph({ ...SMALL_GRAPH, nodes: SMALL_GRAPH.nodes.slice(0, 1) });
    expect(g.nodes).toHaveLength(5);
  });
});

describe('visual encoding', () => {
  it('gives every role its own shape and its own icon (not colour alone)', () => {
    const roles = Object.keys(ROLE_META) as NodeRole[];
    expect(new Set(roles.map((r) => ROLE_META[r].shape)).size).toBe(roles.length);
    expect(new Set(roles.map((r) => roleIconUri(r, '#fff'))).size).toBe(roles.length);
    expect(ROLE_META.victim.shape).toBe('star');
    expect(ROLE_META.vasp.shape).toBe('round-rectangle');
  });

  it('puts the role name and chain ticker in the node label', () => {
    expect(nodeLabel(node('TRON:TVASP'))).toBe('VASP\nDemo Exchange');
    expect(nodeLabel(node('TRON:TMID'))).toContain('Wallet');
    expect(nodeLabel(node('TRON:TMID'))).toContain('TRON');
  });

  it('encodes risk band as fill AND text, and unknown as neutral fill', () => {
    const n: GNode = { ...node('TRON:TMID'), risk: 'HIGH' };
    const d = nodeData(n, FALLBACK_PALETTE);
    expect(d.fill).toBe(FALLBACK_PALETTE.risk.HIGH.soft);
    expect(nodeLabel(n)).toContain('HIGH');
    const unknown = nodeData(node('TRON:TMID'), FALLBACK_PALETTE);
    expect(unknown.fill).toBe(FALLBACK_PALETTE.muted);
    expect(nodeLabel(node('TRON:TMID'))).not.toMatch(/LOW|MED|HIGH|CRIT/);
    const fills = (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).map((r) => nodeData({ ...n, risk: r }, FALLBACK_PALETTE).fill);
    expect(new Set(fills).size).toBe(4);
  });

  it('encodes chain as border colour plus a distinct pattern/width', () => {
    const patterns = Object.values(CHAIN_BORDER).map((b) => `${b.style}/${b.width}`);
    expect(new Set(patterns).size).toBe(5);
    const d = nodeData(node('TRON:TMID'), FALLBACK_PALETTE);
    expect(d).toMatchObject({ borderColor: FALLBACK_PALETTE.chain.TRON, borderStyle: 'solid' });
    expect(nodeData(node(`ETH:${ETH_ADDR}`), FALLBACK_PALETTE)).toMatchObject({ borderColor: FALLBACK_PALETTE.chain.ETH, borderStyle: 'dashed' });
  });

  it('draws cross-chain edges dashed through a dedicated style rule', () => {
    const els = toElements(model(), FALLBACK_PALETTE);
    const cross = els.filter((e) => e.group === 'edges').filter((e) => e.data.cross === 1);
    expect(cross.map((e) => e.data.id)).toEqual(['e3']);
    const rule = (buildStylesheet(FALLBACK_PALETTE, false) as { selector: string; style: Record<string, unknown> }[]).find((s) => s.selector === 'edge[cross = 1]')!;
    expect(rule.style['line-style']).toBe('dashed');
  });

  it('scales edge width with the logarithm of value', () => {
    expect(edgeWidth(null)).toBe(1);
    expect(edgeWidth(0)).toBe(1);
    const w = [10, 100, 1000, 10_000, 100_000].map(edgeWidth);
    expect([...w].sort((a, b) => a - b)).toEqual(w);
    const steps = w.slice(1).map((v, i) => v - w[i]);
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(0.05); // near-constant step per decade = logarithmic
    expect(edgeWidth(1e12)).toBe(9);
    expect(edgeWidth(1500)).toBeGreaterThan(edgeWidth(900));
  });
});

describe('server-side filters', () => {
  it('maps the filter form to the backend query (IST day bounds, numeric minimum), omitting empty ones', () => {
    expect(graphQuery(NO_FILTERS)).toEqual({ chain: undefined, minValueUsd: undefined, from: undefined, to: undefined });
    expect(graphQuery({ chain: 'ETH', minUsd: '100', from: '2026-09-20', to: '2026-09-21' })).toEqual({
      chain: 'ETH',
      minValueUsd: 100,
      from: '2026-09-19T18:30:00.000Z',
      to: '2026-09-21T18:29:59.999Z',
    });
    expect(graphQuery({ ...NO_FILTERS, minUsd: 'abc' }).minValueUsd).toBeUndefined();
    expect(graphQuery({ ...NO_FILTERS, minUsd: '-5' }).minValueUsd).toBeUndefined();
  });
});

describe('replay and progressive views (local, no network)', () => {
  it('reports the time range from real edge timestamps', () => {
    const r = timeRange(model())!;
    expect(r.max - r.min).toBe(3 * 3_600_000);
    expect(timeRange({ traceId: 'x', nodes: [], edges: [] })).toBeNull();
  });

  it('reveals edges progressively up to the replay time', () => {
    const m = model();
    const t = timeRange(m)!;
    expect(visibleGraph(m, { replayT: t.min - 1, expanded: null }).edges).toHaveLength(0);
    expect(visibleGraph(m, { replayT: t.min, expanded: null }).edges.map((e) => e.id)).toEqual(['e1']);
    const mid = visibleGraph(m, { replayT: t.min + 3_600_000, expanded: null });
    expect(mid.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(mid.nodes.map((n) => n.id).sort()).toEqual(['TRON:TMID', 'TRON:TSEED', 'TRON:TVASP']);
    expect(visibleGraph(m, { replayT: null, expanded: null }).edges).toHaveLength(4);
  });

  it('expands a node on demand: only sources are shown until a node is expanded', () => {
    const m = model();
    const first = visibleGraph(m, { replayT: null, expanded: new Set() });
    expect(first.edges.map((e) => e.id).sort()).toEqual(['e1', 'e4']);
    const more = visibleGraph(m, { replayT: null, expanded: new Set(['TRON:TMID']) });
    expect(more.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
  });
});

describe('heaviest path', () => {
  it('is the greatest CUMULATIVE flow, not the largest single edge', () => {
    const p = heaviestPath(model())!;
    expect(p.edgeIds).toEqual(['e1', 'e2']);
    expect(p.nodeIds).toEqual(['TRON:TSEED', 'TRON:TMID', 'TRON:TVASP']);
    expect(p.total).toBe(1900);
    const largest = [...model().edges].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
    expect(largest.id).toBe('e4');
    expect(p.edgeIds).not.toContain('e4');
  });

  it('survives cycles and unknown values, and is deterministic', () => {
    const e = (id: string, from: string, to: string, usd: number | null): GEdge => ({ id, key: id, source: from, target: to, chain: 'TRON', txHash: id, token: 'USDT', amount: '1', usd, hopNo: 1, ts: 0, crossChain: false, live: false });
    const nodes = ['A', 'B', 'C'].map((a) => ({ ...node('TRON:TMID'), id: a, addr: a }));
    const g: GraphModel = { traceId: 'x', nodes, edges: [e('1', 'A', 'B', 10), e('2', 'B', 'C', 20), e('3', 'C', 'A', 30), e('4', 'B', 'C', null)] };
    const p = heaviestPath(g)!;
    expect(p.edgeIds.length).toBeGreaterThan(0);
    expect(heaviestPath(g)).toEqual(p);
    expect(Number.isFinite(p.total)).toBe(true);
  });

  it('returns null for a graph with no edges', () => {
    expect(heaviestPath({ traceId: 'x', nodes: [], edges: [] })).toBeNull();
  });
});

describe('live hops', () => {
  const ev = { traceId: 't1', edge: { chain: 'TRON' as const, from: 'TSIDE', to: 'TNEW', token: 'USDT', amount: '20', usd: 20, txHash: 'txNEW', ts: Date.parse('2026-09-21T00:00:00Z') }, fromNode: { chain: 'TRON' as const, addr: 'TSIDE', hop: 2 }, toNode: { chain: 'TRON' as const, addr: 'TNEW', hop: 3 } };

  it('adds the missing node and edge and keeps existing ones', () => {
    const m = model();
    const next = mergeHop(m, ev);
    expect(next.nodes).toHaveLength(m.nodes.length + 1);
    expect(next.edges).toHaveLength(m.edges.length + 1);
    const added = next.nodes.find((n) => n.id === 'TRON:TNEW')!;
    expect(added).toMatchObject({ live: true, hop: 3, inUsd: 20, role: 'wallet' });
    expect(next.edges.at(-1)).toMatchObject({ live: true, source: 'TRON:TSIDE', target: 'TRON:TNEW' });
    expect(next.nodes.find((n) => n.id === 'TRON:TSIDE')!.outUsd).toBe(20);
  });

  it('ignores a duplicate hop, including one already loaded from the API', () => {
    const once = mergeHop(model(), ev);
    expect(mergeHop(once, ev)).toBe(once);
    const dupOfApi = { ...ev, edge: { ...ev.edge, from: 'TSEED', to: 'TMID', txHash: 'tx1' }, fromNode: { ...ev.fromNode, addr: 'TSEED' }, toNode: { ...ev.toNode, addr: 'TMID' } };
    const m = model();
    expect(mergeHop(m, dupOfApi)).toBe(m);
    expect(edgeKey('TRON', 'tx1', 'TRON:TSEED', 'TRON:TMID')).toBeTruthy();
  });

  it('validates the trace.hop payload', () => {
    expect(parseHopEvent(ev)).not.toBeNull();
    for (const bad of [null, {}, { ...ev, edge: { ...ev.edge, chain: 'X' } }, { ...ev, traceId: '' }, { ...ev, edge: { ...ev.edge, usd: 'a' } }, { ...ev, toNode: undefined }]) expect(parseHopEvent(bad)).toBeNull();
  });
});

describe('explorer links', () => {
  it('maps every supported chain to its own explorer and refuses unknown chains', () => {
    expect(explorerUrl('TRON', 'TAbc')).toBe('https://tronscan.org/#/address/TAbc');
    expect(explorerUrl('ETH', '0x1')).toBe('https://etherscan.io/address/0x1');
    expect(explorerUrl('BSC', '0x1')).toBe('https://bscscan.com/address/0x1');
    expect(explorerUrl('POLYGON', '0x1')).toBe('https://polygonscan.com/address/0x1');
    expect(explorerUrl('BTC', 'bc1q')).toBe('https://mempool.space/address/bc1q');
    expect(explorerUrl('SOLANA', 'x')).toBeNull();
  });
});

describe('layout selection', () => {
  it('uses the left-to-right dagre flow by default and fcose for dense graphs', () => {
    expect(resolveLayout('auto', 50)).toBe('dagre');
    expect(resolveLayout('auto', 800)).toBe('fcose');
    expect(resolveLayout('dagre', 800)).toBe('dagre');
    expect(layoutOptions('dagre', 10, true)).toMatchObject({ name: 'dagre', rankDir: 'LR' });
    expect(layoutOptions('fcose', 900, true)).toMatchObject({ name: 'fcose', quality: 'draft', animate: false });
  });
});

describe('Cytoscape element sync (headless)', () => {
  cytoscape.use(dagre);
  cytoscape.use(fcose);
  const mk = () => cytoscape({ headless: true, styleEnabled: false });

  it('adds, updates and removes in place without duplicating elements', () => {
    const cy = mk();
    const g = model();
    expect(syncElements(cy, g, FALLBACK_PALETTE)).toEqual({ added: 9, removed: 0 });
    cy.getElementById('TRON:TMID').select();
    expect(syncElements(cy, g, FALLBACK_PALETTE)).toEqual({ added: 0, removed: 0 });
    expect(cy.nodes()).toHaveLength(5);
    expect(cy.edges()).toHaveLength(4);
    expect(cy.getElementById('TRON:TMID').selected()).toBe(true); // untouched by a no-op sync
    const smaller = { ...g, nodes: g.nodes.filter((n) => n.id !== 'TRON:TSIDE'), edges: g.edges.filter((e) => e.id !== 'e4') };
    expect(syncElements(cy, smaller, FALLBACK_PALETTE)).toEqual({ added: 0, removed: 2 });
    const grown = mergeHop(smaller, { traceId: 't1', edge: { chain: 'TRON', from: 'TMID', to: 'TNEW', token: 'USDT', amount: '1', usd: 1, txHash: 'txN', ts: 0 }, fromNode: { chain: 'TRON', addr: 'TMID', hop: 2 }, toNode: { chain: 'TRON', addr: 'TNEW', hop: 3 } });
    expect(syncElements(cy, grown, FALLBACK_PALETTE).added).toBe(2);
    expect(cy.getElementById('TRON:TMID').data('inUsd') ?? 0).toBeDefined();
    cy.destroy();
  });

  it('maps live flags and dashed cross-chain data onto elements', () => {
    const cy = mk();
    syncElements(cy, model(), FALLBACK_PALETTE);
    expect(cy.getElementById('e3').data('cross')).toBe(1);
    expect(cy.getElementById('e1').data('cross')).toBe(0);
    expect(cy.getElementById('e2').data('width')).toBeCloseTo(edgeWidth(900));
    cy.destroy();
  });
});

describe('1,000-node performance fixture (headless)', () => {
  cytoscape.use(dagre);
  cytoscape.use(fcose);

  it('builds without duplicate nodes or edges', () => {
    const api = syntheticGraph(1000);
    expect(graphResponseSchema.safeParse(api).success).toBe(true);
    const g = buildGraph(api);
    expect(g.nodes.length).toBeGreaterThanOrEqual(990);
    expect(g.nodes.length).toBeLessThanOrEqual(1000);
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
    expect(new Set(g.edges.map((e) => e.key)).size).toBe(g.edges.length);
  });

  it.each(['dagre', 'fcose'] as const)('lays out 1,000 nodes with %s within a bounded time and syncs idempotently', async (kind) => {
    const g = buildGraph(syntheticGraph(1000));
    const cy = cytoscape({ headless: true, styleEnabled: false });
    const t0 = performance.now();
    syncElements(cy, g, FALLBACK_PALETTE);
    const syncMs = performance.now() - t0;
    const t1 = performance.now();
    await new Promise<void>((res) => {
      const l = cy.layout(layoutOptions(kind, g.nodes.length, false));
      l.one('layoutstop', () => res());
      l.run();
    });
    const layoutMs = performance.now() - t1;
    console.info(`perf: ${g.nodes.length} nodes / ${g.edges.length} edges, sync ${syncMs.toFixed(0)} ms, ${kind} layout ${layoutMs.toFixed(0)} ms (headless, node)`);
    expect(layoutMs).toBeLessThan(20_000);
    expect(syncElements(cy, g, FALLBACK_PALETTE)).toEqual({ added: 0, removed: 0 });
    expect(cy.nodes()).toHaveLength(g.nodes.length);
    expect(cy.edges()).toHaveLength(g.edges.length);
    expect(cy.nodes().map((n) => n.position()).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    cy.destroy();
  }, 60_000);

  it('computes the heaviest path on 1,000 nodes quickly and deterministically', () => {
    const g = buildGraph(syntheticGraph(1000));
    const t = performance.now();
    const p = heaviestPath(g)!;
    expect(performance.now() - t).toBeLessThan(2000);
    expect(heaviestPath(g)).toEqual(p);
    expect(p.edgeIds.length).toBeGreaterThan(1);
  });
});
