import { Check, Copy, Download, ExternalLink, Eye, GitBranch, Lasso, Maximize2, Pause, Play, RotateCcw, Route, Radio, ShieldAlert, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChainBadge, RiskBadge, StatusBadge } from '@/components/common/badges';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { SectionCard } from '@/components/common/cards';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { Can, useCan } from '@/features/auth/access';
import { cn } from '@/lib/cn';
import type { Chain } from '@/lib/tokens';
import { filtersActive, NO_FILTERS, useAddToWatchlist, useCaseWatchlist, useTraceGraph, useVaspIndex, type AddResult, type GraphFilters } from './api';
import { WalletProfile } from '@/features/wallet/WalletProfile';
import { GraphCanvas, type GraphCanvasHandle, type LayoutKind } from './GraphCanvas';
import {
  buildGraph, CHAIN_LIST, explorerUrl, formatUsdValue, formatWhen, heaviestPath, hiddenChildren, mergeHop, rootIds, ROLE_META, shortAddr, timeRange, vaspKey, visibleGraph,
  type GEdge, type GNode, type GraphModel, type HopEvent,
} from './model';
import { useLiveTrace } from './useLiveTrace';

/** Above this many nodes the progressive (hop-by-hop) view switches on by itself; the target of 1,000 nodes renders in full. */
export const PROGRESSIVE_NODES = 1200;
const REPLAY_TICK_MS = 100;
const REPLAY_TICKS = 120; // a full replay takes about 12 s

export interface ExplorerTrace {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  seedChain: string;
  seedAddr: string;
}

const useDebounced = <T,>(value: T, ms: number) => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
};

const field = 'h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground';
const labelCls = 'flex flex-col gap-1 text-xs text-muted-foreground';

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Live hops must obey the active filters too (the server only filtered the initial load). */
const passesFilters = (ev: HopEvent, f: GraphFilters) => {
  if (f.chain && ev.edge.chain !== f.chain) return false;
  const min = Number(f.minUsd);
  if (f.minUsd.trim() !== '' && Number.isFinite(min) && (ev.edge.usd ?? 0) < min) return false;
  const day = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10); // IST calendar day
  if (f.from && day(ev.edge.ts) < f.from) return false;
  if (f.to && day(ev.edge.ts) > f.to) return false;
  return true;
};

export function GraphExplorer({ caseId, trace, focus = null }: { caseId: string; trace: ExplorerTrace; focus?: { chain: string; addr: string } | null }) {
  const can = useCan();
  const canvas = useRef<GraphCanvasHandle>(null);
  const [draft, setDraft] = useState<GraphFilters>(NO_FILTERS);
  const filters = useDebounced(draft, 400);
  const graphQ = useTraceGraph(trace.id, filters);
  const vasps = useVaspIndex();
  const watchlist = useCaseWatchlist(caseId);
  const add = useAddToWatchlist(caseId);

  const [layout, setLayout] = useState<LayoutKind>('auto');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [multi, setMulti] = useState<ReadonlySet<string>>(new Set());
  const [pathOn, setPathOn] = useState(false);
  const [progressive, setProgressive] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [replayT, setReplayT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [lasso, setLasso] = useState(false);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [layoutMs, setLayoutMs] = useState<number | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);

  // ---- data: API graph + live hops, merged idempotently ----
  const [liveHops, setLiveHops] = useState<HopEvent[]>([]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  useEffect(() => setLiveHops([]), [trace.id]);
  const onHop = useCallback((ev: HopEvent) => {
    if (passesFilters(ev, filtersRef.current)) setLiveHops((prev) => [...prev, ev]);
  }, []);
  const live = useLiveTrace(caseId, trace.id, onHop);

  const base = useMemo(() => (graphQ.data ? buildGraph(graphQ.data, vasps.data) : null), [graphQ.data, vasps.data]);
  const full: GraphModel | null = useMemo(() => (base ? liveHops.reduce((g, ev) => mergeHop(g, ev, vasps.data), base) : null), [base, liveHops, vasps.data]);
  const isProgressive = progressive || (full?.nodes.length ?? 0) > PROGRESSIVE_NODES;
  const range = useMemo(() => (full ? timeRange(full) : null), [full]);
  const shown = useMemo(() => (full ? visibleGraph(full, { replayT, expanded: isProgressive ? expanded : null }) : null), [full, replayT, expanded, isProgressive]);
  const path = useMemo(() => (pathOn && shown ? heaviestPath(shown) : null), [pathOn, shown]);
  const pathNodeIds = useMemo(() => (path ? new Set(path.nodeIds) : null), [path]);
  const pathEdgeIds = useMemo(() => (path ? new Set(path.edgeIds) : null), [path]);
  const nodeById = useMemo(() => new Map((full?.nodes ?? []).map((n) => [n.id, n])), [full]);
  const watched = useMemo(() => new Set((watchlist.data ?? []).map((w) => vaspKey(w.chain, w.addr))), [watchlist.data]);
  const isWatched = (n: GNode) => watched.has(vaspKey(n.chain, n.addr));

  // ---- deep link from an alert: select its address once, when the graph first loads ----
  const focusApplied = useRef(false);
  useEffect(() => {
    if (!focus || focusApplied.current || !full) return;
    focusApplied.current = true;
    const key = vaspKey(focus.chain, focus.addr);
    const match = full.nodes.find((n) => vaspKey(n.chain, n.addr) === key);
    if (match) setSelectedId(match.id);
    else setNotice({ tone: 'warn', text: `The address from that alert (${focus.chain} ${shortAddr(focus.addr)}) is not in this trace's graph. It may belong to another trace of this case, or be hidden by a filter.` });
  }, [focus, full]);

  // ---- replay ----
  useEffect(() => {
    if (!playing || !range) return;
    const step = Math.max(1, (range.max - range.min) / REPLAY_TICKS);
    const id = setInterval(() => {
      setReplayT((t) => {
        const next = (t ?? range.min) + step;
        if (next >= range.max) {
          setPlaying(false);
          return null; // finished: back to the full flow
        }
        return next;
      });
    }, REPLAY_TICK_MS);
    return () => clearInterval(id);
  }, [playing, range]);
  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (replayT === null) setReplayT(range?.min ?? null);
    setPlaying(true);
  };
  const resetReplay = () => (setPlaying(false), setReplayT(null));

  // ---- theme key so the canvas re-reads colours when dark/light flips ----
  const [themeKey, setThemeKey] = useState('');
  useEffect(() => {
    const read = () => setThemeKey(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  // ---- actions ----
  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;
  const copy = async (n: GNode) => {
    if (await copyText(n.addr)) {
      setCopied(n.id);
      setTimeout(() => setCopied((c) => (c === n.id ? null : c)), 1800);
    } else setNotice({ tone: 'error', text: 'Could not copy to the clipboard. Select the address and copy it manually.' });
  };
  const expand = (id: string) => setExpanded((s) => new Set([...s, id]));
  const toggleMulti = (id: string) =>
    setMulti((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  const addToWatchlist = (ids: string[]) => {
    const targets = ids.map((id) => nodeById.get(id)).filter((n): n is GNode => !!n).map((n) => ({ id: n.id, chain: n.chain, addr: n.addr }));
    if (targets.length === 0) return;
    add.mutate(targets, {
      onSuccess: (r: AddResult) => {
        const parts = [r.added.length && `${r.added.length} added`, r.alreadyWatched.length && `${r.alreadyWatched.length} already watched`, r.failed.length && `${r.failed.length} failed`].filter(Boolean);
        setNotice({ tone: r.failed.length ? 'error' : r.added.length ? 'ok' : 'warn', text: `Watchlist: ${parts.join(', ')}.${r.failed[0] ? ` ${r.failed[0].message}` : ''}` });
        if (r.added.length && !r.failed.length) setMulti(new Set());
      },
      onError: () => setNotice({ tone: 'error', text: 'Could not update the watchlist. Try again.' }),
    });
  };
  const exportPng = () => {
    const uri = canvas.current?.exportPng(2);
    if (!uri) return setNotice({ tone: 'error', text: 'Nothing to export yet.' });
    const a = document.createElement('a');
    a.href = uri;
    a.download = `trace-${trace.id}-graph.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setNotice({ tone: 'ok', text: `Exported trace-${trace.id}-graph.png` });
  };
  const resetFilters = () => setDraft(NO_FILTERS);

  // Escape closes the menu / panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(null);
      setLasso(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shownSelected = selected && shown?.nodes.some((n) => n.id === selected.id) ? selected : null;
  const liveLabel = live.completed ? 'Trace complete' : live.status === 'connected' ? (trace.status === 'RUNNING' || live.progress ? 'Live: trace running' : 'Live: listening') : live.status === 'connecting' ? 'Live: connecting' : 'Live: reconnecting';
  const summary = shown
    ? `${shown.nodes.length} nodes, ${shown.edges.length} edges${full && (full.nodes.length !== shown.nodes.length || full.edges.length !== shown.edges.length) ? ` shown of ${full.nodes.length} nodes, ${full.edges.length} edges` : ''}. ` +
      `Filters: ${filtersActive(filters) ? [filters.chain && `chain ${filters.chain}`, filters.minUsd && `minimum $${filters.minUsd}`, filters.from && `from ${filters.from}`, filters.to && `to ${filters.to}`].filter(Boolean).join(', ') : 'none'}. ` +
      `Selected: ${shownSelected ? `${ROLE_META[shownSelected.role].label} ${shownSelected.chain} ${shortAddr(shownSelected.addr)}` : 'none'}${multi.size ? `; ${multi.size} in selection` : ''}. ` +
      `Heaviest path: ${path ? `${path.edgeIds.length} hops, ${formatUsdValue(path.total)}` : 'off'}. ` +
      `${replayT !== null ? `Replay at ${formatWhen(replayT)}${playing ? ' (playing)' : ''}. ` : ''}${liveLabel}.`
    : '';

  const hasWatchWrite = can('watchlist:write');

  return (
    <SectionCard
      title="Fund-flow graph"
      description={`Trace ${trace.seedChain} ${shortAddr(trace.seedAddr)} · status ${trace.status.toLowerCase()}`}
      actions={
        <StatusBadge tone={live.status === 'connected' ? 'success' : 'neutral'} icon={<Radio className="size-3.5" aria-hidden="true" />}>
          <span role="status">{liveLabel}</span>
        </StatusBadge>
      }
      bodyClassName="space-y-3 p-3 sm:p-4"
    >
      {/* filters */}
      <form className="flex flex-wrap items-end gap-2" aria-label="Graph filters" onSubmit={(e) => e.preventDefault()}>
        <label className={labelCls}>
          Chain
          <select className={field} value={draft.chain} onChange={(e) => setDraft({ ...draft, chain: e.target.value as Chain | '' })}>
            <option value="">All</option>
            {CHAIN_LIST.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Minimum value (USD)
          <input className={cn(field, 'w-32')} type="number" min="0" step="any" inputMode="decimal" placeholder="0" value={draft.minUsd} onChange={(e) => setDraft({ ...draft, minUsd: e.target.value })} />
        </label>
        <label className={labelCls}>
          From date (IST)
          <input className={field} type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className={labelCls}>
          To date (IST)
          <input className={field} type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <Button type="button" variant="outline" size="sm" onClick={resetFilters} disabled={!filtersActive(draft)}>
          <RotateCcw className="size-4" aria-hidden="true" /> Reset filters
        </Button>
        <label className={labelCls}>
          Layout
          <select className={field} value={layout} onChange={(e) => setLayout(e.target.value as LayoutKind)}>
            <option value="auto">Auto (flow, clusters when dense)</option>
            <option value="dagre">Left-to-right flow</option>
            <option value="fcose">Clusters</option>
          </select>
        </label>
      </form>

      {/* tools */}
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Graph tools">
        <Button type="button" variant={pathOn ? 'default' : 'outline'} size="sm" aria-pressed={pathOn} onClick={() => setPathOn((v) => !v)}>
          <Route className="size-4" aria-hidden="true" /> Heaviest path
        </Button>
        <Button type="button" variant={lasso ? 'default' : 'outline'} size="sm" aria-pressed={lasso} onClick={() => setLasso((v) => !v)}>
          <Lasso className="size-4" aria-hidden="true" /> Lasso select
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setMulti(new Set((shown?.nodes ?? []).map((n) => n.id)))} disabled={!shown?.nodes.length}>
          Select all
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setMulti(new Set())} disabled={multi.size === 0}>
          Clear selection
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={isProgressive} disabled={(full?.nodes.length ?? 0) > PROGRESSIVE_NODES} onChange={(e) => (setProgressive(e.target.checked), setExpanded(new Set()))} />
          Reveal hop by hop
        </label>
        <span className="ml-auto flex items-center gap-1">
          <Tooltip label="Zoom in" side="bottom">
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom in" onClick={() => canvas.current?.zoomBy(1.3)}>
              <ZoomIn className="size-4" aria-hidden="true" />
            </Button>
          </Tooltip>
          <Tooltip label="Zoom out" side="bottom">
            <Button type="button" variant="ghost" size="icon" aria-label="Zoom out" onClick={() => canvas.current?.zoomBy(1 / 1.3)}>
              <ZoomOut className="size-4" aria-hidden="true" />
            </Button>
          </Tooltip>
          <Tooltip label="Fit graph to view" side="bottom">
            <Button type="button" variant="ghost" size="icon" aria-label="Fit graph to view" onClick={() => canvas.current?.fit()}>
              <Maximize2 className="size-4" aria-hidden="true" />
            </Button>
          </Tooltip>
          <Button type="button" variant="outline" size="sm" onClick={exportPng} disabled={!shown?.nodes.length}>
            <Download className="size-4" aria-hidden="true" /> Export PNG
          </Button>
        </span>
      </div>

      {/* replay */}
      {range && range.max > range.min && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2" role="group" aria-label="Time replay">
          <Button type="button" variant="outline" size="sm" onClick={togglePlay} aria-label={playing ? 'Pause replay' : 'Play replay'}>
            {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
            {playing ? 'Pause' : 'Play'}
          </Button>
          <input
            type="range"
            aria-label="Replay time"
            className="min-w-40 flex-1"
            min={range.min}
            max={range.max}
            step={Math.max(1, Math.floor((range.max - range.min) / 500))}
            value={replayT ?? range.max}
            onChange={(e) => (setPlaying(false), setReplayT(Number(e.target.value)))}
            aria-valuetext={formatWhen(replayT ?? range.max)}
          />
          <span className="text-xs tabular-nums text-muted-foreground" data-testid="replay-time">
            {replayT === null ? `All flow · to ${formatWhen(range.max)}` : formatWhen(replayT)}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={resetReplay} disabled={replayT === null && !playing}>
            <RotateCcw className="size-4" aria-hidden="true" /> Show all
          </Button>
        </div>
      )}

      <p role="status" className="text-xs text-muted-foreground" data-testid="graph-summary">
        {summary}
      </p>
      {live.progress && (
        <p className="text-xs text-muted-foreground" data-testid="live-progress">
          Trace progress: {live.progress.hopsDone} hops done, frontier {live.progress.frontier}, {live.progress.apiCalls} provider calls.
        </p>
      )}
      {live.completed && (
        <p className="text-xs text-muted-foreground" data-testid="live-completed">
          Trace completed in {(live.completed.durationMs / 1000).toFixed(1)} s with {live.completed.terminals.length} terminal {live.completed.terminals.length === 1 ? 'point' : 'points'}.
        </p>
      )}
      {notice && (
        <p role="status" className={cn('rounded-md border px-3 py-2 text-sm', notice.tone === 'error' ? 'border-risk-critical/40 text-risk-critical' : notice.tone === 'warn' ? 'border-risk-medium/40 text-risk-medium' : 'border-risk-low/40 text-risk-low')}>
          {notice.text}
        </p>
      )}

      {/* canvas + side panel */}
      {!graphQ.data && graphQ.isPending && graphQ.fetchStatus !== 'idle' ? (
        <LoadingState rows={6} label="Loading graph" />
      ) : graphQ.isError && !graphQ.data ? (
        <ErrorState error={graphQ.error} title="Could not load the graph" onRetry={() => void graphQ.refetch()} />
      ) : graphQ.fetchStatus === 'idle' && !graphQ.data ? (
        <EmptyState title="Not available for your role" description="Your role does not include graph access." />
      ) : shown && shown.nodes.length === 0 ? (
        <EmptyState
          title={filtersActive(filters) ? 'No transfers match these filters' : 'No transfers recorded for this trace yet'}
          description={filtersActive(filters) ? 'Loosen the chain, value or date filters.' : 'Hops appear here as the trace finds them.'}
          action={filtersActive(filters) ? <Button variant="outline" size="sm" onClick={resetFilters}>Reset filters</Button> : undefined}
        />
      ) : (
        shown && (
          <div className="relative grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className={cn('relative h-[55vh] min-h-[360px] overflow-hidden rounded-lg border bg-card lg:h-[64vh]', graphQ.isFetching && 'opacity-90')} aria-busy={graphQ.isFetching}>
              <GraphCanvas
                ref={canvas}
                graph={shown}
                layout={layout}
                selectedId={shownSelected?.id ?? null}
                multiIds={multi}
                pathNodeIds={pathNodeIds}
                pathEdgeIds={pathEdgeIds}
                themeKey={themeKey}
                onSelect={(id) => (setSelectedId(id), setMenu(null))}
                onContextMenu={(id, at) => setMenu({ id, ...at })}
                onLayoutDone={setLayoutMs}
              />
              {lasso && <LassoOverlay onDone={(pts) => (setMulti(new Set(canvas.current?.nodesInPolygon(pts) ?? [])), setLasso(false))} />}
              {menu && nodeById.get(menu.id) && <NodeMenu node={nodeById.get(menu.id)!} at={menu} onClose={() => setMenu(null)} onCopy={copy} onSelect={() => (setSelectedId(menu.id), setMenu(null))} />}
              <Legend />
            </div>

            {shownSelected && (
              <SidePanel
                node={shownSelected}
                graph={full!}
                shown={shown}
                progressive={isProgressive}
                copied={copied === shownSelected.id}
                watched={isWatched(shownSelected)}
                inMulti={multi.has(shownSelected.id)}
                busy={add.isPending}
                onClose={() => setSelectedId(null)}
                onCopy={() => void copy(shownSelected)}
                onExpand={() => expand(shownSelected.id)}
                onToggleMulti={() => toggleMulti(shownSelected.id)}
                onProfile={() => setProfileId(shownSelected.id)}
                onWatch={() => addToWatchlist([shownSelected.id])}
                canWrite={hasWatchWrite}
              />
            )}
          </div>
        )
      )}

      {/* watchlist bar */}
      <Can permission="watchlist:write" fallback={<p className="text-xs text-muted-foreground">Read-only access: adding addresses to the watchlist needs an Investigator or Supervisor role.</p>}>
        {multi.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm" data-testid="selection-bar">
            <span>
              {multi.size} {multi.size === 1 ? 'address' : 'addresses'} selected
            </span>
            <Button size="sm" onClick={() => addToWatchlist([...multi])} disabled={add.isPending}>
              <Eye className="size-4" aria-hidden="true" /> {add.isPending ? 'Adding…' : 'Add selected to watchlist'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMulti(new Set())}>
              Clear
            </Button>
          </div>
        )}
      </Can>

      {shown && shown.nodes.length > 0 && (
        <details className="rounded-md border px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none rounded font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Node list (keyboard and screen-reader alternative to the canvas)</summary>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto" aria-label="Graph nodes">
            {shown.nodes.slice(0, 100).map((n) => (
              <li key={n.id}>
                <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setSelectedId(n.id)}>
                  {ROLE_META[n.role].label} · {n.chain} · <span className="font-mono text-xs">{shortAddr(n.addr)}</span>
                  {n.label ? ` · ${n.label}` : ''}
                </button>
              </li>
            ))}
          </ul>
          {shown.nodes.length > 100 && <p className="mt-1 text-xs text-muted-foreground">Showing the first 100 of {shown.nodes.length} nodes.</p>}
        </details>
      )}
      <WalletProfile node={profileId ? (nodeById.get(profileId) ?? null) : null} graph={full ?? { traceId: trace.id, nodes: [], edges: [] }} traceId={trace.id} onClose={() => setProfileId(null)} />
      {layoutMs !== null && (
        <p className="text-[0.7rem] text-muted-foreground" data-testid="layout-ms">
          Layout took {layoutMs} ms.
        </p>
      )}
    </SectionCard>
  );
}

/** Freehand lasso: drag to draw, release to select the nodes inside. Pointer events cover mouse, touch and pen. */
function LassoOverlay({ onDone }: { onDone: (pts: { x: number; y: number }[]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pts, setPts] = useState<{ x: number; y: number }[]>([]);
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  return (
    <div
      ref={ref}
      data-testid="lasso-overlay"
      className="absolute inset-0 z-10 cursor-crosshair touch-none bg-primary/5"
      onPointerDown={(e) => (e.currentTarget.setPointerCapture?.(e.pointerId), setPts([at(e)]))}
      onPointerMove={(e) => pts.length && setPts((p) => [...p, at(e)])}
      onPointerUp={() => (pts.length > 2 ? onDone(pts) : setPts([]))}
    >
      <p className="pointer-events-none absolute left-2 top-2 rounded bg-card/90 px-2 py-1 text-xs">Drag around the addresses to select. Esc cancels.</p>
      <svg className="pointer-events-none size-full" aria-hidden="true">
        <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="hsl(var(--primary) / 0.15)" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="6 4" />
      </svg>
    </div>
  );
}

function NodeMenu({ node, at, onClose, onCopy, onSelect }: { node: GNode; at: { x: number; y: number }; onClose: () => void; onCopy: (n: GNode) => Promise<void>; onSelect: () => void }) {
  const url = explorerUrl(node.chain, node.addr);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring aria-disabled:opacity-50';
  return (
    <div role="menu" aria-label={`Actions for ${shortAddr(node.addr)}`} className="absolute z-20 min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-md" style={{ left: Math.max(4, at.x), top: Math.max(4, at.y) }}>
      <button ref={first} role="menuitem" type="button" className={item} onClick={() => void onCopy(node).then(onClose)}>
        <Copy className="size-4" aria-hidden="true" /> Copy address
      </button>
      {url ? (
        <a role="menuitem" className={item} href={url} target="_blank" rel="noopener noreferrer" onClick={onClose}>
          <ExternalLink className="size-4" aria-hidden="true" /> Open in explorer
        </a>
      ) : (
        <span role="menuitem" aria-disabled="true" className={item}>
          <ExternalLink className="size-4" aria-hidden="true" /> No explorer for {node.chain}
        </span>
      )}
      <button role="menuitem" type="button" className={item} onClick={onSelect}>
        <GitBranch className="size-4" aria-hidden="true" /> Show details
      </button>
      <button role="menuitem" type="button" className={cn(item, 'text-muted-foreground')} onClick={onClose}>
        <X className="size-4" aria-hidden="true" /> Close
      </button>
    </div>
  );
}

function Legend() {
  return (
    <details className="absolute bottom-2 left-2 z-[5] max-w-[16rem] rounded-md border bg-card/95 px-2 py-1 text-[0.7rem]">
      <summary className="cursor-pointer select-none font-medium">Legend</summary>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        <li>Shape + icon + label: role (Victim ★, Wallet ●, VASP ▭, Mixer ⬡, Bridge ⯃)</li>
        <li>Fill + risk text: risk band (grey = not returned by the API)</li>
        <li>Border pattern + ticker: chain (TRON solid · ETH dashed · BSC dotted · POLYGON double · BTC heavy)</li>
        <li>Edge width: log of USD value; dashed edge = cross-chain hop</li>
      </ul>
    </details>
  );
}

function SidePanel({ node, graph, shown, progressive, copied, watched, inMulti, busy, canWrite, onClose, onCopy, onExpand, onToggleMulti, onWatch, onProfile }: {
  node: GNode; graph: GraphModel; shown: GraphModel; progressive: boolean; copied: boolean; watched: boolean; inMulti: boolean; busy: boolean; canWrite: boolean;
  onClose: () => void; onCopy: () => void; onExpand: () => void; onToggleMulti: () => void; onWatch: () => void; onProfile: () => void;
}) {
  const url = explorerUrl(node.chain, node.addr);
  const incoming = graph.edges.filter((e) => e.target === node.id);
  const outgoing = graph.edges.filter((e) => e.source === node.id);
  const hidden = hiddenChildren(graph, shown, node.id);
  const isRoot = rootIds(graph).has(node.id);
  const recent = [...incoming, ...outgoing].sort((a, b) => b.ts - a.ts).slice(0, 6);
  const dl = 'grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1 text-sm';
  return (
    <aside
      aria-label="Node details"
      className="fixed inset-x-0 bottom-0 z-40 max-h-[75vh] overflow-y-auto rounded-t-xl border-t bg-card p-4 shadow-2xl lg:static lg:z-auto lg:max-h-[64vh] lg:rounded-lg lg:border lg:shadow-none"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {ROLE_META[node.role].label}
          {node.label ? ` · ${node.label}` : ''}
        </h3>
        <Button type="button" variant="ghost" size="icon" aria-label="Close details" onClick={onClose}>
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <p className="mono-id mt-1 select-all">{node.addr}</p>
      <dl className={cn(dl, 'mt-3')}>
        <dt className="text-muted-foreground">Chain</dt>
        <dd>
          <ChainBadge chain={node.chain} />
        </dd>
        <dt className="text-muted-foreground">Role</dt>
        <dd>
          {ROLE_META[node.role].label}
          <span className="text-xs text-muted-foreground"> ({node.roleSource === 'registry' ? 'from the VASP registry' : node.roleSource === 'api' ? 'from the graph API' : 'default: not classified'})</span>
        </dd>
        <dt className="text-muted-foreground">Risk band</dt>
        <dd>{node.risk === 'UNKNOWN' ? <span className="text-muted-foreground">Unknown (not returned by the graph API)</span> : <RiskBadge band={node.risk} />}</dd>
        <dt className="text-muted-foreground">Received</dt>
        <dd className="tabular-nums">{formatUsdValue(node.inUsd)}</dd>
        <dt className="text-muted-foreground">Sent</dt>
        <dd className="tabular-nums">{formatUsdValue(node.outUsd)}</dd>
        <dt className="text-muted-foreground">Hop</dt>
        <dd>{node.hop === null ? 'Unknown' : isRoot ? 'Source (0)' : node.hop}</dd>
        <dt className="text-muted-foreground">Transfers</dt>
        <dd>
          {incoming.length} in · {outgoing.length} out
        </dd>
        <dt className="text-muted-foreground">Watchlist</dt>
        <dd>{watched ? <StatusBadge tone="success">Watched</StatusBadge> : 'Not watched'}</dd>
      </dl>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onProfile}>
          <ShieldAlert className="size-4" aria-hidden="true" /> Wallet profile
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCopy}>
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />} {copied ? 'Copied' : 'Copy address'}
        </Button>
        {url ? (
          <Button asChild size="sm" variant="outline">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" aria-hidden="true" /> Open explorer
            </a>
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled>
            No explorer for {node.chain}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onExpand} disabled={!progressive || hidden === 0} title={!progressive ? 'All next hops are already shown' : hidden === 0 ? 'No hidden next hops' : undefined}>
          <GitBranch className="size-4" aria-hidden="true" /> Expand{progressive && hidden > 0 ? ` (${hidden})` : ''}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onToggleMulti} aria-pressed={inMulti}>
          {inMulti ? 'Remove from selection' : 'Add to selection'}
        </Button>
        {canWrite && (
          <Button type="button" size="sm" onClick={onWatch} disabled={busy || watched}>
            <Eye className="size-4" aria-hidden="true" /> {watched ? 'Already watched' : 'Add to watchlist'}
          </Button>
        )}
      </div>
      {!canWrite && <p className="mt-2 text-xs text-muted-foreground">Read-only access: watchlist changes need an Investigator or Supervisor role.</p>}

      {recent.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest transfers</h4>
          <ul className="mt-1 divide-y text-xs">
            {recent.map((e: GEdge) => (
              <li key={e.id} className="py-1.5">
                <span className="font-medium">{e.source === node.id ? 'Sent' : 'Received'}</span> {formatUsdValue(e.usd)} <span className="text-muted-foreground">({e.token})</span>
                <div className="text-muted-foreground">
                  {formatWhen(e.ts)} · tx <span className="font-mono">{shortAddr(e.txHash)}</span>
                  {e.crossChain ? ' · cross-chain' : ''}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

