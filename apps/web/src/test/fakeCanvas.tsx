import { forwardRef, useImperativeHandle } from 'react';
import { vi } from 'vitest';
import type { GraphCanvasHandle, GraphCanvasProps } from '@/features/graph/GraphCanvas';

/** What the explorer last handed the canvas, plus spies for the imperative handle. Cytoscape itself needs a real canvas. */
export const probe = {
  props: null as GraphCanvasProps | null,
  lassoResult: [] as string[],
  exportPng: vi.fn(() => 'data:image/png;base64,AAAA'),
  fit: vi.fn(),
  zoomBy: vi.fn(),
  reset() {
    this.props = null;
    this.lassoResult = [];
    this.exportPng.mockClear();
    this.fit.mockClear();
    this.zoomBy.mockClear();
  },
};

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function FakeGraphCanvas(props, ref) {
  probe.props = props;
  useImperativeHandle(ref, () => ({
    fit: probe.fit,
    zoomBy: probe.zoomBy,
    exportPng: probe.exportPng,
    nodesInPolygon: () => probe.lassoResult,
    relayout: () => undefined,
    center: () => undefined,
  }));
  return (
    <div data-testid="fake-canvas" data-nodes={props.graph.nodes.length} data-edges={props.graph.edges.length} data-layout={props.layout} data-path-edges={[...(props.pathEdgeIds ?? [])].join(',')} data-multi={[...props.multiIds].join(',')}>
      {props.graph.nodes.map((n) => (
        <span key={n.id}>
          <button type="button" onClick={() => props.onSelect(n.id)}>{`select ${n.id}`}</button>
          <button type="button" onClick={() => props.onContextMenu(n.id, { x: 10, y: 10 })}>{`menu ${n.id}`}</button>
        </span>
      ))}
    </div>
  );
});
