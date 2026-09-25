import type { ElementDefinition, StylesheetJson } from 'cytoscape';
import type { Chain } from '@/lib/tokens';
import { CHAIN_BORDER, CHAIN_LIST, edgeWidth, nodeLabel, ROLE_META, type GEdge, type GNode, type GraphModel, type NodeRisk, type NodeRole } from './model';

/** Cytoscape paints to a canvas, which cannot read CSS variables, so the design tokens are resolved to concrete colours. */
export interface Palette {
  background: string;
  card: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
  risk: Record<Exclude<NodeRisk, 'UNKNOWN'>, { solid: string; soft: string }>;
  chain: Record<Chain, string>;
}

const hsl = (raw: string, fallback: string) => {
  const parts = raw.trim().split(/\s+/);
  return parts.length === 3 ? `hsl(${parts[0]}, ${parts[1]}, ${parts[2]})` : fallback;
};

export const FALLBACK_PALETTE: Palette = {
  background: '#0d1017',
  card: '#151922',
  foreground: '#e6ebf1',
  muted: '#232a36',
  mutedForeground: '#9aa5b5',
  border: '#2c3442',
  primary: '#22d3ee',
  risk: {
    LOW: { solid: '#4ade80', soft: '#14301f' },
    MEDIUM: { solid: '#facc15', soft: '#352c10' },
    HIGH: { solid: '#fb923c', soft: '#38230f' },
    CRITICAL: { solid: '#fb7185', soft: '#3d1621' },
  },
  chain: { TRON: '#f2675f', ETH: '#96a2f2', BSC: '#f5c518', POLYGON: '#b891f2', BTC: '#f79a3e' },
};

export function readPalette(root: HTMLElement = document.documentElement): Palette {
  const cs = getComputedStyle(root);
  const v = (name: string, fb: string) => hsl(cs.getPropertyValue(name), fb);
  const f = FALLBACK_PALETTE;
  return {
    background: v('--background', f.background),
    card: v('--card', f.card),
    foreground: v('--foreground', f.foreground),
    muted: v('--muted', f.muted),
    mutedForeground: v('--muted-foreground', f.mutedForeground),
    border: v('--border', f.border),
    primary: v('--primary', f.primary),
    risk: {
      LOW: { solid: v('--risk-low', f.risk.LOW.solid), soft: v('--risk-low-soft', f.risk.LOW.soft) },
      MEDIUM: { solid: v('--risk-medium', f.risk.MEDIUM.solid), soft: v('--risk-medium-soft', f.risk.MEDIUM.soft) },
      HIGH: { solid: v('--risk-high', f.risk.HIGH.solid), soft: v('--risk-high-soft', f.risk.HIGH.soft) },
      CRITICAL: { solid: v('--risk-critical', f.risk.CRITICAL.solid), soft: v('--risk-critical-soft', f.risk.CRITICAL.soft) },
    },
    chain: Object.fromEntries(CHAIN_LIST.map((c) => [c, v(`--chain-${c.toLowerCase()}`, f.chain[c])])) as Palette['chain'],
  };
}

/** Role glyphs (lucide-style strokes) drawn inside the node, so role is readable without shape or colour perception. */
const ICON_PATHS: Record<NodeRole, string> = {
  victim: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>',
  vasp: '<path d="M3 21h18M5 21V10M9 21V10M15 21V10M19 21V10M2 10l10-6 10 6z"/>',
  mixer: '<path d="M3 6h4l10 12h4M3 18h4l3-4M14 10l3-4h4M18 3l3 3-3 3M18 15l3 3-3 3"/>',
  bridge: '<path d="M3 17c0-6 4-9 9-9s9 3 9 9M3 17h18M7 17v-4M12 17v-6M17 17v-4"/>',
};
export const roleIconUri = (role: NodeRole, color: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[role]}</svg>`)}`;

/** Elements are keyed by stable ids so a data change updates them in place instead of rebuilding the graph. */
export function nodeData(n: GNode, palette: Palette) {
  const fill = n.risk === 'UNKNOWN' ? palette.muted : palette.risk[n.risk].soft;
  const iconColor = n.risk === 'UNKNOWN' ? palette.mutedForeground : palette.risk[n.risk].solid;
  const b = CHAIN_BORDER[n.chain];
  return {
    id: n.id,
    label: nodeLabel(n),
    role: n.role,
    chain: n.chain,
    risk: n.risk,
    shape: ROLE_META[n.role].shape,
    fill,
    borderColor: palette.chain[n.chain],
    borderStyle: b.style,
    borderWidth: b.width,
    icon: roleIconUri(n.role, iconColor),
    live: n.live ? 1 : 0,
  };
}

export function edgeData(e: GEdge) {
  return { id: e.id, source: e.source, target: e.target, width: edgeWidth(e.usd), cross: e.crossChain ? 1 : 0, live: e.live ? 1 : 0, usd: e.usd ?? -1 };
}

export const toElements = (g: GraphModel, palette: Palette): ElementDefinition[] => [
  ...g.nodes.map((n) => ({ group: 'nodes' as const, data: nodeData(n, palette) })),
  ...g.edges.map((e) => ({ group: 'edges' as const, data: edgeData(e) })),
];

export const LARGE_GRAPH = 500;

export function buildStylesheet(p: Palette, large: boolean): StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        shape: 'data(shape)' as never,
        'background-color': 'data(fill)',
        'border-color': 'data(borderColor)',
        'border-style': 'data(borderStyle)' as never,
        'border-width': 'data(borderWidth)',
        'background-image': 'data(icon)',
        'background-width': '55%',
        'background-height': '55%',
        'background-position-y': '35%',
        label: 'data(label)',
        color: p.foreground,
        'font-size': 10,
        'text-wrap': 'wrap',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-background-color': p.card,
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
        'min-zoomed-font-size': 9,
        width: 38,
        height: 38,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 'data(width)',
        'line-color': p.mutedForeground,
        'target-arrow-color': p.mutedForeground,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        'curve-style': large ? 'straight' : 'bezier',
        opacity: 0.85,
      },
    },
    // cross-chain hops are dashed (a non-colour signal)
    { selector: 'edge[cross = 1]', style: { 'line-style': 'dashed', 'line-dash-pattern': [8, 5] } },
    { selector: '.live', style: { 'overlay-color': p.primary, 'overlay-opacity': 0.25, 'overlay-padding': 6 } },
    { selector: 'node:selected, node.selected', style: { 'underlay-color': p.primary, 'underlay-opacity': 0.35, 'underlay-padding': 7 } },
    // lasso / multi-selection: a heavy outline plus a check-style underlay
    { selector: 'node.multi', style: { 'outline-color': p.primary, 'outline-width': 3, 'outline-style': 'solid', 'outline-offset': 3 } as never },
    { selector: '.dim', style: { opacity: 0.3 } },
    { selector: 'edge.onpath', style: { 'line-color': p.primary, 'target-arrow-color': p.primary, opacity: 1, 'z-index': 20 } },
    { selector: 'node.onpath', style: { 'underlay-color': p.primary, 'underlay-opacity': 0.5, 'underlay-padding': 8, opacity: 1 } },
    { selector: '.exporting', style: { 'min-zoomed-font-size': 0 } },
  ] as StylesheetJson;
}
