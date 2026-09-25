import cytoscape, { type Core, type LayoutOptions } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import fcose from 'cytoscape-fcose';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { GraphModel } from './model';
import { buildStylesheet, edgeData, LARGE_GRAPH, nodeData, readPalette, type Palette } from './style';

let registered = false;
function registerExtensions() {
  if (registered) return;
  registered = true;
  cytoscape.use(dagre);
  cytoscape.use(fcose);
}

export type LayoutKind = 'auto' | 'dagre' | 'fcose';
/** Dense graphs read better as force-directed clusters; sparse ones as a left-to-right flow. */
export const DENSE_NODES = 400;
export const resolveLayout = (kind: LayoutKind, nodeCount: number): 'dagre' | 'fcose' => (kind === 'auto' ? (nodeCount > DENSE_NODES ? 'fcose' : 'dagre') : kind);

export function layoutOptions(kind: 'dagre' | 'fcose', nodeCount: number, fit: boolean): LayoutOptions {
  if (kind === 'dagre') return { name: 'dagre', rankDir: 'LR', nodeSep: 18, rankSep: 110, fit, padding: 30, animate: false } as LayoutOptions;
  return { name: 'fcose', quality: nodeCount > 600 ? 'draft' : 'default', randomize: true, animate: false, fit, padding: 30, nodeDimensionsIncludeLabels: false, nodeRepulsion: () => 6500, idealEdgeLength: () => 70 } as LayoutOptions;
}

/**
 * Applies `graph` to an existing Cytoscape instance IN PLACE: elements are matched on their stable ids, so unchanged ones are
 * untouched (positions and selection survive), new ones are added and gone ones removed. Returns what changed so the caller
 * only re-runs a layout when the structure did.
 */
export function syncElements(cy: Core, graph: GraphModel, palette: Palette) {
  let added = 0;
  let removed = 0;
  cy.batch(() => {
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const edgeIds = new Set(graph.edges.map((e) => e.id));
    cy.edges().forEach((e) => {
      if (!edgeIds.has(e.id())) {
        e.remove();
        removed++;
      }
    });
    cy.nodes().forEach((n) => {
      if (!nodeIds.has(n.id())) {
        n.remove();
        removed++;
      }
    });
    for (const n of graph.nodes) {
      const ele = cy.getElementById(n.id);
      if (ele.empty()) {
        cy.add({ group: 'nodes', data: nodeData(n, palette) });
        added++;
      } else ele.data(nodeData(n, palette));
    }
    for (const e of graph.edges) {
      const ele = cy.getElementById(e.id);
      if (ele.empty()) {
        cy.add({ group: 'edges', data: edgeData(e) });
        added++;
      } else ele.data(edgeData(e));
    }
  });
  return { added, removed };
}

export interface GraphCanvasHandle {
  fit: () => void;
  zoomBy: (factor: number) => void;
  /** PNG of the whole graph with labels, as a data URL. */
  exportPng: (scale?: number) => string;
  /** Node ids whose on-screen centre lies inside the polygon (container-relative pixels): the lasso hit test. */
  nodesInPolygon: (poly: { x: number; y: number }[]) => string[];
  relayout: () => void;
  center: (id: string) => void;
}

export interface GraphCanvasProps {
  graph: GraphModel;
  layout: LayoutKind;
  selectedId: string | null;
  multiIds: ReadonlySet<string>;
  pathNodeIds: ReadonlySet<string> | null;
  pathEdgeIds: ReadonlySet<string> | null;
  /** Bumped when the theme flips so colours are re-read. */
  themeKey: string;
  onSelect: (id: string | null) => void;
  onContextMenu: (id: string, at: { x: number; y: number }) => void;
  onLayoutDone?: (ms: number) => void;
}

const inside = (p: { x: number; y: number }, poly: { x: number; y: number }[]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};

/**
 * One Cytoscape instance for the life of the component. Data changes go through syncElements (no rebuild); selection, path
 * and multi-select are classes; the layout re-runs only when nodes/edges were added or removed (debounced), never on a
 * selection or style change.
 */
export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(props, ref) {
  const { graph, layout, selectedId, multiIds, pathNodeIds, pathEdgeIds, themeKey, onSelect, onContextMenu, onLayoutDone } = props;
  const host = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const palette = useRef<Palette | null>(null);
  const first = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const handlers = useRef({ onSelect, onContextMenu, onLayoutDone });
  handlers.current = { onSelect, onContextMenu, onLayoutDone };
  const latest = useRef({ graph, layout });
  latest.current = { graph, layout };

  const runLayout = (fit: boolean) => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;
    const t0 = performance.now();
    const kind = resolveLayout(latest.current.layout, cy.nodes().length);
    const l = cy.layout(layoutOptions(kind, cy.nodes().length, fit));
    l.one('layoutstop', () => handlers.current.onLayoutDone?.(Math.round(performance.now() - t0)));
    l.run();
  };

  // create once, destroy on unmount
  useEffect(() => {
    registerExtensions();
    const p = readPalette();
    palette.current = p;
    const large = latest.current.graph.nodes.length > LARGE_GRAPH;
    const cy = cytoscape({
      container: host.current,
      style: buildStylesheet(p, large),
      elements: [],
      wheelSensitivity: 0.25,
      minZoom: 0.05,
      maxZoom: 4,
      hideEdgesOnViewport: large,
      textureOnViewport: large,
      pixelRatio: large ? 1 : 'auto',
    });
    cyRef.current = cy;
    cy.on('tap', 'node', (ev) => handlers.current.onSelect(ev.target.id()));
    cy.on('tap', (ev) => {
      if (ev.target === cy) handlers.current.onSelect(null);
    });
    cy.on('cxttap', 'node', (ev) => handlers.current.onContextMenu(ev.target.id(), { x: ev.renderedPosition.x, y: ev.renderedPosition.y }));
    return () => {
      clearTimeout(timer.current);
      cy.destroy();
      cyRef.current = null;
      first.current = true;
    };
  }, []);

  // data -> elements, in place
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !palette.current) return;
    const large = graph.nodes.length > LARGE_GRAPH;
    cy.style(buildStylesheet(palette.current, large));
    cy.autoungrabify(false);
    const { added, removed } = syncElements(cy, graph, palette.current);
    if (added || removed) {
      clearTimeout(timer.current);
      const fit = first.current;
      first.current = false;
      timer.current = setTimeout(() => runLayout(fit), fit ? 0 : 120);
    }
  }, [graph]);

  // an explicit layout change re-lays out once
  useEffect(() => {
    if (!first.current) runLayout(true);
  }, [layout]);

  // theme flip: re-read colours and restyle, no relayout
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    palette.current = readPalette();
    cy.style(buildStylesheet(palette.current, latest.current.graph.nodes.length > LARGE_GRAPH));
    syncElements(cy, latest.current.graph, palette.current);
  }, [themeKey]);

  // selection / multi-select / path highlight: classes only
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('selected multi onpath dim');
      if (selectedId) cy.getElementById(selectedId).addClass('selected');
      multiIds.forEach((id) => cy.getElementById(id).addClass('multi'));
      if (pathNodeIds && pathEdgeIds) {
        cy.elements().addClass('dim');
        pathNodeIds.forEach((id) => cy.getElementById(id).removeClass('dim').addClass('onpath'));
        pathEdgeIds.forEach((id) => cy.getElementById(id).removeClass('dim').addClass('onpath'));
      }
    });
  }, [selectedId, multiIds, pathNodeIds, pathEdgeIds, graph]);

  useImperativeHandle(ref, () => ({
    fit: () => cyRef.current?.fit(undefined, 30),
    zoomBy: (factor) => {
      const cy = cyRef.current;
      if (cy) cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    },
    exportPng: (scale = 2) => {
      const cy = cyRef.current!;
      cy.elements().addClass('exporting');
      try {
        return cy.png({ full: true, scale: cy.nodes().length > 500 ? Math.min(scale, 1.5) : scale, bg: palette.current?.card, output: 'base64uri' });
      } finally {
        cy.elements().removeClass('exporting');
      }
    },
    nodesInPolygon: (poly) => {
      const cy = cyRef.current;
      if (!cy || poly.length < 3) return [];
      return cy.nodes().filter((n) => inside(n.renderedPosition(), poly)).map((n) => n.id());
    },
    relayout: () => runLayout(true),
    center: (id) => {
      const cy = cyRef.current;
      const n = cy?.getElementById(id);
      if (cy && n && !n.empty()) cy.animate({ center: { eles: n }, duration: 0 });
    },
  }));

  return <div ref={host} data-testid="graph-canvas" className="size-full" />;
});
