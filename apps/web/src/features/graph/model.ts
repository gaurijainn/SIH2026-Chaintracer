import { z } from 'zod';
import type { Chain, RiskBand } from '@/lib/tokens';

export const CHAIN_LIST: Chain[] = ['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC'];
const chainEnum = z.enum(['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC']);

/**
 * GET /api/v1/traces/:id/graph (apps/api/src/graph/service.ts). The backend returns only what the persisted hops know: chain,
 * address, USD in/out per node and the transfers. Role, risk band, label and community are NOT returned today; they are
 * accepted as optional so that the day the backend adds them they flow through untouched, and are never invented here.
 */
const rolesEnum = z.enum(['victim', 'wallet', 'vasp', 'mixer', 'bridge']);
const bandEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const graphResponseSchema = z.object({
  traceId: z.string().min(1),
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      chain: chainEnum,
      addr: z.string().min(1),
      inUsd: z.number().finite(),
      outUsd: z.number().finite(),
      role: rolesEnum.optional(),
      riskBand: bandEnum.optional(),
      label: z.string().optional(),
      communityId: z.string().optional(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string().min(1),
      chain: chainEnum,
      txHash: z.string().min(1),
      from: z.string().min(1),
      to: z.string().min(1),
      token: z.string(),
      amount: z.string(),
      usd: z.number().finite().nullable(),
      hopNo: z.number().int().nonnegative(),
      ts: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp'),
    }),
  ),
});
export type GraphResponse = z.infer<typeof graphResponseSchema>;

export type NodeRole = z.infer<typeof rolesEnum>;
export type NodeRisk = RiskBand | 'UNKNOWN';

export interface GNode {
  id: string;
  chain: Chain;
  addr: string;
  role: NodeRole;
  /** Where the role came from: the VASP registry, the graph API, or the plain default for an address (a wallet). */
  roleSource: 'registry' | 'api' | 'default';
  /** VASP / service name when known (registry or API). */
  label: string | null;
  risk: NodeRisk;
  inUsd: number;
  outUsd: number;
  /** Fewest hops from a trace source; null when unknown. */
  hop: number | null;
  communityId: string | null;
  live: boolean;
}

export interface GEdge {
  id: string;
  /** chain|txHash|from|to: the identity used to keep API-loaded and live hops from duplicating. */
  key: string;
  source: string;
  target: string;
  chain: Chain;
  txHash: string;
  token: string;
  amount: string;
  usd: number | null;
  hopNo: number;
  ts: number;
  crossChain: boolean;
  live: boolean;
}

export interface GraphModel {
  traceId: string;
  nodes: GNode[];
  edges: GEdge[];
}

export const nodeId = (chain: string, addr: string) => `${chain}:${addr}`;
export const edgeKey = (chain: string, txHash: string, from: string, to: string) => `${chain}|${txHash}|${from}|${to}`;
const chainOfId = (id: string) => id.slice(0, id.indexOf(':'));

/** Registry lookup by `CHAIN:addr` (GET /vasps hot wallets), the only real source of VASP identity next to a graph. */
export type VaspIndex = Map<string, { name: string }>;

const norm = (chain: string, addr: string) => (chain === 'ETH' || chain === 'BSC' || chain === 'POLYGON' ? addr.toLowerCase() : addr);
export const vaspKey = (chain: string, addr: string) => `${chain}:${norm(chain, addr)}`;

function toNode(n: { id: string; chain: Chain; addr: string; inUsd: number; outUsd: number; role?: NodeRole; riskBand?: RiskBand; label?: string; communityId?: string }, vasps: VaspIndex): GNode {
  const reg = vasps.get(vaspKey(n.chain, n.addr));
  const role: NodeRole = n.role ?? (reg ? 'vasp' : 'wallet');
  return {
    id: n.id,
    chain: n.chain,
    addr: n.addr,
    role,
    roleSource: n.role ? 'api' : reg ? 'registry' : 'default',
    label: n.label ?? reg?.name ?? null,
    risk: n.riskBand ?? 'UNKNOWN',
    inUsd: n.inUsd,
    outUsd: n.outUsd,
    hop: null,
    communityId: n.communityId ?? null,
    live: false,
  };
}

function assignHops(nodes: Map<string, GNode>, edges: GEdge[]) {
  const incoming = new Set(edges.map((e) => e.target));
  const best = new Map<string, number>();
  for (const e of edges) {
    if (!incoming.has(e.source)) best.set(e.source, 0);
    best.set(e.target, Math.min(best.get(e.target) ?? Infinity, e.hopNo));
  }
  for (const [id, n] of nodes) n.hop = best.get(id) ?? null;
}

export function buildGraph(api: GraphResponse, vasps: VaspIndex = new Map()): GraphModel {
  const nodes = new Map<string, GNode>();
  for (const n of api.nodes) nodes.set(n.id, toNode(n, vasps));
  const edges: GEdge[] = [];
  const seen = new Set<string>();
  for (const e of api.edges) {
    const key = edgeKey(e.chain, e.txHash, e.from, e.to);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const id of [e.from, e.to]) {
      if (!nodes.has(id)) {
        const c = chainOfId(id);
        const chain = (CHAIN_LIST as string[]).includes(c) ? (c as Chain) : e.chain;
        nodes.set(id, toNode({ id, chain, addr: id.slice(id.indexOf(':') + 1), inUsd: 0, outUsd: 0 }, vasps));
      }
    }
    edges.push({ id: e.id, key, source: e.from, target: e.to, chain: e.chain, txHash: e.txHash, token: e.token, amount: e.amount, usd: e.usd, hopNo: e.hopNo, ts: Date.parse(e.ts), crossChain: chainOfId(e.from) !== chainOfId(e.to), live: false });
  }
  assignHops(nodes, edges);
  return { traceId: api.traceId, nodes: [...nodes.values()], edges };
}

/** trace.hop payload (packages/shared traceEvents.ts). Validated: anything malformed is dropped, never rendered. */
const hopEventSchema = z.object({
  traceId: z.string().min(1),
  edge: z.object({ chain: chainEnum, from: z.string().min(1), to: z.string().min(1), token: z.string(), amount: z.string(), usd: z.number().finite().nullable(), txHash: z.string().min(1), ts: z.number().finite() }),
  fromNode: z.object({ chain: chainEnum, addr: z.string().min(1), hop: z.number().int().nonnegative() }),
  toNode: z.object({ chain: chainEnum, addr: z.string().min(1), hop: z.number().int().nonnegative() }),
});
export type HopEvent = z.infer<typeof hopEventSchema>;
export const parseHopEvent = (raw: unknown): HopEvent | null => {
  const r = hopEventSchema.safeParse(raw);
  return r.success ? r.data : null;
};

/** Adds a live hop's missing nodes and edge. Returns the same object when the hop is already present (idempotent). */
export function mergeHop(graph: GraphModel, ev: HopEvent, vasps: VaspIndex = new Map()): GraphModel {
  // Same identity as an API edge (whose endpoints are CHAIN:addr ids), so a hop the API already returned is not added twice.
  const key = edgeKey(ev.edge.chain, ev.edge.txHash, nodeId(ev.fromNode.chain, ev.edge.from), nodeId(ev.toNode.chain, ev.edge.to));
  if (graph.edges.some((e) => e.key === key)) return graph;
  const nodes = [...graph.nodes];
  const add = (n: { chain: Chain; addr: string; hop: number }) => {
    const id = nodeId(n.chain, n.addr);
    const existing = nodes.findIndex((x) => x.id === id);
    if (existing >= 0) {
      const cur = nodes[existing];
      if (cur.hop === null || n.hop < cur.hop) nodes[existing] = { ...cur, hop: n.hop };
      return id;
    }
    nodes.push({ ...toNode({ id, chain: n.chain, addr: n.addr, inUsd: 0, outUsd: 0 }, vasps), hop: n.hop, live: true });
    return id;
  };
  const source = add(ev.fromNode);
  const target = add(ev.toNode);
  const usd = ev.edge.usd ?? 0;
  const bump = (id: string, k: 'inUsd' | 'outUsd') => {
    const i = nodes.findIndex((x) => x.id === id);
    nodes[i] = { ...nodes[i], [k]: nodes[i][k] + usd };
  };
  bump(source, 'outUsd');
  bump(target, 'inUsd');
  const edge: GEdge = { id: `live:${key}`, key, source, target, chain: ev.edge.chain, txHash: ev.edge.txHash, token: ev.edge.token, amount: ev.edge.amount, usd: ev.edge.usd, hopNo: ev.toNode.hop, ts: ev.edge.ts, crossChain: ev.fromNode.chain !== ev.toNode.chain, live: true };
  return { ...graph, nodes, edges: [...graph.edges, edge] };
}

export function timeRange(graph: GraphModel): { min: number; max: number } | null {
  if (graph.edges.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const e of graph.edges) {
    if (e.ts < min) min = e.ts;
    if (e.ts > max) max = e.ts;
  }
  return { min, max };
}

export interface ViewOptions {
  /** Replay cursor (epoch ms): edges after it are hidden. null = everything. */
  replayT: number | null;
  /** When set, only edges leaving a source/expanded node are shown (lazy expansion of large graphs). null = show all. */
  expanded: ReadonlySet<string> | null;
}

/** Sources of the loaded graph: nodes that no edge points to. Their next hops are always visible. */
export const rootIds = (graph: GraphModel): Set<string> => {
  const targets = new Set(graph.edges.map((e) => e.target));
  return new Set(graph.nodes.filter((n) => !targets.has(n.id)).map((n) => n.id));
};

/** Local view over the already-loaded graph: replay cursor and lazy expansion. Never touches the network. */
export function visibleGraph(graph: GraphModel, view: ViewOptions): GraphModel {
  const roots = view.expanded ? rootIds(graph) : null;
  let edges = graph.edges.filter((e) => (view.replayT === null || e.ts <= view.replayT) && (!view.expanded || roots!.has(e.source) || view.expanded.has(e.source)));
  // Lazy view: an edge is only reachable if its source is itself visible (a root or the target of a visible edge).
  if (view.expanded) {
    const reachable = new Set(roots);
    for (let changed = true; changed; ) {
      changed = false;
      for (const e of edges) {
        if (reachable.has(e.source) && !reachable.has(e.target)) {
          reachable.add(e.target);
          changed = true;
        }
      }
    }
    edges = edges.filter((e) => reachable.has(e.source));
  }
  const ids = new Set<string>();
  for (const e of edges) {
    ids.add(e.source);
    ids.add(e.target);
  }
  // Unfiltered: every node (even one with no edges). Replay / lazy views show only the endpoints of visible edges.
  const nodes = view.replayT === null && !view.expanded ? graph.nodes : graph.nodes.filter((n) => ids.has(n.id));
  return { traceId: graph.traceId, nodes, edges };
}

/** Outgoing edges hidden behind a node in the lazy view (0 when everything from it is already shown). */
export const hiddenChildren = (full: GraphModel, shown: GraphModel, id: string) => full.edges.filter((e) => e.source === id).length - shown.edges.filter((e) => e.source === id).length;

export interface HeaviestPath {
  edgeIds: string[];
  nodeIds: string[];
  /** Sum of edge USD along the path. */
  total: number;
}

/**
 * Heaviest path = the source-to-sink path with the greatest CUMULATIVE USD across its edges (not the single largest edge).
 * This is a display heuristic over the loaded graph, not the backend's taint calculation. Trace graphs can contain cycles,
 * so edges that close a cycle in a deterministic depth-first order are ignored, leaving a DAG on which the longest weighted
 * path is exact. Edges with unknown USD weigh 0. Ties break on edge id, so the result is stable.
 */
export function heaviestPath(graph: GraphModel): HeaviestPath | null {
  if (graph.edges.length === 0) return null;
  const out = new Map<string, GEdge[]>();
  for (const e of graph.edges) (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e);
  for (const list of out.values()) list.sort((a, b) => a.id.localeCompare(b.id));

  // 1. drop cycle-closing edges via iterative DFS
  const dag = new Map<string, GEdge[]>();
  const state = new Map<string, 0 | 1 | 2>(); // 1 = on stack, 2 = done
  const ids = [...new Set([...out.keys(), ...graph.edges.map((e) => e.target)])].sort();
  for (const start of ids) {
    if (state.get(start)) continue;
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = out.get(top.id) ?? [];
      if (top.i >= edges.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const e = edges[top.i++];
      if (state.get(e.target) === 1) continue; // back edge: closes a cycle
      (dag.get(e.source) ?? dag.set(e.source, []).get(e.source)!).push(e);
      if (!state.get(e.target)) {
        state.set(e.target, 1);
        stack.push({ id: e.target, i: 0 });
      }
    }
  }

  // 2. longest weighted path on the DAG, memoised (post-order over the same DFS forest)
  const best = new Map<string, { total: number; edge: GEdge | null }>();
  const visit = (start: string) => {
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (best.has(top.id)) {
        stack.pop();
        continue;
      }
      const edges = dag.get(top.id) ?? [];
      if (top.i < edges.length) {
        const t = edges[top.i++].target;
        if (!best.has(t)) stack.push({ id: t, i: 0 });
        continue;
      }
      let pick: { total: number; edge: GEdge | null } = { total: 0, edge: null };
      for (const e of edges) {
        const total = (e.usd ?? 0) + best.get(e.target)!.total;
        if (pick.edge === null || total > pick.total) pick = { total, edge: e };
      }
      best.set(top.id, pick);
      stack.pop();
    }
  };
  for (const id of ids) visit(id);

  let startId: string | null = null;
  for (const id of ids) if (best.get(id)!.edge && (startId === null || best.get(id)!.total > best.get(startId)!.total)) startId = id;
  if (startId === null) return null;
  const edgeIds: string[] = [];
  const nodeIds = [startId];
  for (let cur = best.get(startId)!; cur.edge; cur = best.get(cur.edge.target)!) {
    edgeIds.push(cur.edge.id);
    nodeIds.push(cur.edge.target);
  }
  return { edgeIds, nodeIds, total: best.get(startId)!.total };
}

// ---------- encodings ----------

/** Edge width grows with log(value): $1 -> ~1.6px, $1,000 -> ~5px, $1M -> ~9px; unknown value = thinnest. */
export const edgeWidth = (usd: number | null): number => (usd === null || usd <= 0 ? 1 : Math.min(9, 1 + 1.3 * Math.log10(1 + usd)));

export const ROLE_META: Record<NodeRole, { label: string; shape: string }> = {
  victim: { label: 'Victim', shape: 'star' },
  wallet: { label: 'Wallet', shape: 'ellipse' },
  vasp: { label: 'VASP', shape: 'round-rectangle' },
  mixer: { label: 'Mixer', shape: 'hexagon' },
  bridge: { label: 'Bridge', shape: 'octagon' },
};

/** Chain identity through border PATTERN and width as well as colour; the ticker is also in every node label. */
export const CHAIN_BORDER: Record<Chain, { style: 'solid' | 'dashed' | 'dotted' | 'double'; width: number }> = {
  TRON: { style: 'solid', width: 2 },
  ETH: { style: 'dashed', width: 3 },
  BSC: { style: 'dotted', width: 3 },
  POLYGON: { style: 'double', width: 5 },
  BTC: { style: 'solid', width: 5 },
};

export const RISK_TEXT: Record<NodeRisk, string> = { LOW: 'LOW', MEDIUM: 'MED', HIGH: 'HIGH', CRITICAL: 'CRIT', UNKNOWN: 'risk n/a' };

export const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function nodeLabel(n: GNode): string {
  const head = `${ROLE_META[n.role].label}${n.risk === 'UNKNOWN' ? '' : ` · ${RISK_TEXT[n.risk]}`}`;
  return `${head}\n${n.label ?? `${n.chain} ${shortAddr(n.addr)}`}`;
}

/** Public block explorers for the five supported chains (Tronscan, Etherscan, mempool.space are the plan's providers). */
const EXPLORERS: Record<Chain, (addr: string) => string> = {
  TRON: (a) => `https://tronscan.org/#/address/${encodeURIComponent(a)}`,
  ETH: (a) => `https://etherscan.io/address/${encodeURIComponent(a)}`,
  BSC: (a) => `https://bscscan.com/address/${encodeURIComponent(a)}`,
  POLYGON: (a) => `https://polygonscan.com/address/${encodeURIComponent(a)}`,
  BTC: (a) => `https://mempool.space/address/${encodeURIComponent(a)}`,
};
export const explorerUrl = (chain: string, addr: string): string | null => (chain in EXPLORERS ? EXPLORERS[chain as Chain](addr) : null);

export const formatUsdValue = (n: number | null) => (n === null ? 'unknown' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 100 ? 0 : 2 }));
export const formatWhen = (ms: number) => new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) + ' IST';
