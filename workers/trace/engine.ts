import type { Chain, Transfer, TraceCompletedEvent, TraceEventEnvelope, TraceTerminal } from '@ps26183/shared';
import type { ChainLayer } from '../adapters/index';
import { collectTransfers } from '../adapters/index';
import type { GraphHop } from './graphWrite';
import { TaintPriorityQueue } from './priorityQueue';
import { isBridgeContract, isDexRouter } from './serviceContracts';
import { isHighDegree, isServiceLabel, meetsMinValue, SERVICE_LABEL_CATEGORIES, withinWindow, type LabelMatch } from './stopConditions';
import { allocateTaint, type TaintModel } from './taint';

type Numeric = number | { toNumber(): number };
const toNum = (v: Numeric): number => (typeof v === 'number' ? v : v.toNumber());

export interface TraceJobRow {
  id: string;
  caseId: string;
  seedChain: Chain;
  seedAddr: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  taintModel: TaintModel;
  maxHops: number;
  minValueUsd: Numeric;
  windowDays: number;
  reportedAmount: Numeric | null;
  createdAt: Date;
}

export interface HopCreateInput {
  traceId: string;
  hopNo: number;
  chain: string;
  txHash: string;
  idx: number;
  fromAddr: string;
  toAddr: string;
  token: string;
  amount: string;
  usd: string | null;
  ts: Date;
}

/** The exact subset of PrismaClient B4's engine calls; a real PrismaClient satisfies this structurally. */
export interface TracePrisma {
  traceJob: {
    findUniqueOrThrow(args: { where: { id: string } }): Promise<TraceJobRow>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  hop: {
    createMany(args: { data: HopCreateInput[]; skipDuplicates: true }): Promise<unknown>;
    count(args: { where: { traceId: string } }): Promise<number>;
  };
  label: {
    findFirst(args: { where: { chain: string; addr: string; category: { in: string[] } } }): Promise<LabelMatch | null>;
  };
}

export interface BridgeResolver {
  /** Looks up the destination-chain transaction for a bridge deposit; null when it cannot be resolved. */
  resolve(chain: Chain, bridgeAddr: string, edge: Transfer): Promise<{ chain: Chain; addr: string; txHash: string } | null>;
}

export interface TraceEngineDeps {
  prisma: TracePrisma;
  chainLayer: ChainLayer;
  writeGraphHops: (hops: GraphHop[]) => Promise<void>;
  publish: (e: TraceEventEnvelope) => Promise<void>;
  bridgeResolver?: BridgeResolver;
  topK?: number;
  highDegreeCutoff?: number;
  now?: () => number;
  /** Safety valve against runaway loops; not part of the plan's stop conditions. */
  maxNodes?: number;
  /**
   * B8 hook: called once per terminal after the trace completes, before returning. Used to
   * auto-populate the watchlist with frontier addresses (terminals with reason 'max_hops' -- the
   * trace stopped only because it ran out of hops, not because it reached a known exit point, so
   * B8 keeps watching past where B4 stopped looking). Best-effort: a failure here must never fail
   * the trace itself, so runTrace catches and logs, never throws, from this callback.
   */
  onTerminal?: (terminal: TraceTerminal, caseId: string) => Promise<void>;
}

export interface RunTraceOptions {
  /** BullMQ attempt bookkeeping: only the final attempt marks the TraceJob FAILED on error. */
  attempt?: { made: number; max: number };
}

export interface TraceRunResult {
  terminals: TraceTerminal[];
  hopsWritten: number;
}

interface NodeMeta {
  chain: Chain;
  addr: string;
  taint: number;
  hop: number;
  firstTaintedAt: number;
}

const nodeKey = (chain: Chain, addr: string): string => `${chain}:${addr}`;
const edgeKey = (t: Pick<Transfer, 'txHash' | 'idx'>): string => `${t.txHash}|${t.idx}`;

function topByUsd(edges: Transfer[], k: number): Transfer[] {
  return [...edges].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1)).slice(0, k);
}

/**
 * Walks the tainted-value frontier outward from a trace's seed, following plan B4:
 *  - priority queue on taint value (not BFS)
 *  - HAIRCUT (proportional) or FIFO taint propagation, per TraceJob.taintModel
 *  - stops at labeled services (exchange/mixer/bridge/sanctioned), max hops, min value, the incident
 *    window, top-10 outflows per node, and high-degree (>5,000 counterparty) addresses
 *  - pairs DEX swap legs and continues with the output token; resolves bridge crossings onto the
 *    destination chain when a resolver is given
 *  - batches Hop writes to PostgreSQL and Neo4j, and streams trace.progress/trace.hop/trace.completed
 *
 * Idempotent: a COMPLETED job is not re-walked (its terminals/hop count are reported from storage);
 * any other status re-walks from the seed, relying on the B3 provider cache (confirmed transfers are
 * cached forever) so a retry or a resumed job never repeats provider work, and on Hop's
 * (traceId, txHash, fromAddr, toAddr) unique key (skipDuplicates) so re-writing is always safe.
 */
export async function runTrace(traceId: string, deps: TraceEngineDeps, opts: RunTraceOptions = {}): Promise<TraceRunResult> {
  const now = deps.now ?? Date.now;
  const topK = deps.topK ?? 10;
  const highDegreeCutoff = deps.highDegreeCutoff ?? 5000;
  const maxNodes = deps.maxNodes ?? 5000;

  const job = await deps.prisma.traceJob.findUniqueOrThrow({ where: { id: traceId } });

  if (job.status === 'COMPLETED') {
    const hopsDone = await deps.prisma.hop.count({ where: { traceId } });
    const payload: TraceCompletedEvent = { traceId, caseId: job.caseId, terminals: [], durationMs: 0 };
    await deps.publish({ event: 'trace.completed', payload });
    return { terminals: [], hopsWritten: hopsDone };
  }

  const start = now();
  await deps.prisma.traceJob.update({ where: { id: traceId }, data: { status: 'RUNNING', startedAt: new Date(start) } });

  try {
    const windowStartMs = job.createdAt.getTime();
    const windowEndMs = windowStartMs + job.windowDays * 86_400_000;
    const maxHops = job.maxHops;
    const minValueUsd = toNum(job.minValueUsd);
    const taintModel = job.taintModel;
    const seedTaint = job.reportedAmount === null ? Number.POSITIVE_INFINITY : toNum(job.reportedAmount);

    const heap = new TaintPriorityQueue<string>();
    const nodeMeta = new Map<string, NodeMeta>();
    const expanded = new Set<string>();
    const terminals: TraceTerminal[] = [];

    const seedKey = nodeKey(job.seedChain, job.seedAddr);
    nodeMeta.set(seedKey, { chain: job.seedChain, addr: job.seedAddr, taint: seedTaint, hop: 0, firstTaintedAt: windowStartMs });
    heap.push(seedKey, seedTaint);

    let hopBuffer: HopCreateInput[] = [];
    let graphBuffer: GraphHop[] = [];
    let hopsWritten = 0;
    let apiCalls = 0;
    let hopNoCounter = 0;
    let nodesProcessed = 0;

    const flush = async () => {
      if (hopBuffer.length === 0) return;
      await deps.prisma.hop.createMany({ data: hopBuffer, skipDuplicates: true });
      await deps.writeGraphHops(graphBuffer);
      hopsWritten += hopBuffer.length;
      hopBuffer = [];
      graphBuffer = [];
    };

    const pushChild = (childChain: Chain, childAddr: string, share: number, childHop: number, ts: number) => {
      const k = nodeKey(childChain, childAddr);
      if (expanded.has(k)) return; // already expanded from an earlier, independent arrival
      const existing = nodeMeta.get(k);
      const newTaint = (existing?.taint ?? 0) + share;
      nodeMeta.set(k, {
        chain: childChain,
        addr: childAddr,
        taint: newTaint,
        hop: Math.min(existing?.hop ?? childHop, childHop),
        firstTaintedAt: Math.min(existing?.firstTaintedAt ?? ts, ts),
      });
      heap.push(k, newTaint);
    };

    const persistEdges = (chain: Chain, fromAddr: string, fromHop: number, edges: Transfer[], emitHopEvents: boolean) => {
      for (const e of edges) {
        hopNoCounter++;
        const usdStr = e.usd != null ? String(e.usd) : null;
        hopBuffer.push({ traceId, hopNo: hopNoCounter, chain, txHash: e.txHash, idx: e.idx, fromAddr, toAddr: e.to, token: e.token, amount: e.amount, usd: usdStr, ts: new Date(e.ts) });
        graphBuffer.push({ chain, from: fromAddr, to: e.to, tx: e.txHash, idx: e.idx, token: e.token, amount: e.amount, usd: usdStr, ts: new Date(e.ts).toISOString() });
      }
      if (!emitHopEvents) return Promise.resolve();
      return Promise.all(
        edges.map((e) =>
          deps.publish({
            event: 'trace.hop',
            payload: {
              traceId,
              caseId: job.caseId,
              edge: { chain, from: fromAddr, to: e.to, token: e.token, amount: e.amount, usd: e.usd ?? null, txHash: e.txHash, ts: e.ts },
              fromNode: { chain, addr: fromAddr, hop: fromHop },
              toNode: { chain, addr: e.to, hop: fromHop + 1 },
            },
          }),
        ),
      );
    };

    while (heap.size > 0 && nodesProcessed < maxNodes) {
      const popped = heap.pop()!;
      const meta = nodeMeta.get(popped.key)!;
      if (meta.taint !== popped.taint || expanded.has(popped.key)) continue; // stale entry or already expanded
      expanded.add(popped.key);
      nodesProcessed++;

      const { chain, addr, taint, hop, firstTaintedAt } = meta;

      await deps.publish({
        event: 'trace.progress',
        payload: { traceId, caseId: job.caseId, hopsDone: hopsWritten + hopBuffer.length, frontier: heap.size, apiCalls },
      });

      // Stop condition: a labeled service (VASP/mixer/bridge/sanctioned).
      const label = await deps.prisma.label.findFirst({ where: { chain, addr, category: { in: [...SERVICE_LABEL_CATEGORIES] } } });
      if (isServiceLabel(label)) {
        const reason = label.category === 'mixer' ? 'mixer' : label.category === 'sanctioned' ? 'sanctioned' : label.category === 'bridge' ? 'bridge_unresolved' : 'exchange';
        terminals.push({ chain, addr, reason, label: label.name });
        continue; // do not expand outflows past a labeled service
      }

      if (hop >= maxHops) {
        terminals.push({ chain, addr, reason: 'max_hops' });
        continue;
      }

      const adapter = deps.chainLayer.adapter(chain);
      const since = Math.max(firstTaintedAt, windowStartMs);
      apiCalls++;
      const collected = await collectTransfers(adapter, addr, 'out', { since });
      apiCalls += collected.pages;

      const outs = collected.items.filter((t) => t.amount !== '0' && withinWindow(t.ts, windowStartMs, job.windowDays) && t.ts >= since && t.ts <= windowEndMs);

      // High-degree service: too many distinct counterparties to be a real person; stop, flag for review.
      const counterparties = new Set(outs.map((t) => t.to));
      if (isHighDegree(counterparties.size, highDegreeCutoff)) {
        terminals.push({ chain, addr, reason: 'high_degree_service' });
        await persistEdges(chain, addr, hop, topByUsd(outs, topK), false);
        if (hopBuffer.length >= 500) await flush();
        continue;
      }

      // DEX swap legs: an outflow into a known router paired with a same-tx inbound leg of a different
      // token nets to zero external movement; exclude it, and let the node's genuine subsequent
      // outflow (in the output token) carry the trace onward.
      const swapLegs = new Set<string>();
      if (outs.some((t) => isDexRouter(chain, t.to))) {
        apiCalls++;
        const inbound = await collectTransfers(adapter, addr, 'in', { since });
        apiCalls += inbound.pages;
        for (const o of outs) {
          if (!isDexRouter(chain, o.to)) continue;
          if (inbound.items.some((i) => i.txHash === o.txHash && i.token !== o.token && isDexRouter(chain, i.from))) swapLegs.add(edgeKey(o));
        }
      }
      const nonSwap = outs.filter((t) => !swapLegs.has(edgeKey(t)));

      // Bridge crossings: handled specially, excluded from the generic top-K fan-out.
      const bridgeLegs = nonSwap.filter((t) => isBridgeContract(chain, t.to));
      const candidates = nonSwap.filter((t) => !isBridgeContract(chain, t.to));

      for (const edge of bridgeLegs) {
        await persistEdges(chain, addr, hop, [edge], false);
        const resolved = deps.bridgeResolver ? await deps.bridgeResolver.resolve(chain, edge.to, edge) : null;
        if (resolved) {
          const [share] = allocateTaint(taintModel, taint, [{ usd: edge.usd ?? null }]);
          if (share > 0) pushChild(resolved.chain, resolved.addr, share, hop + 1, edge.ts);
        } else {
          terminals.push({ chain, addr: edge.to, reason: 'bridge_unresolved' });
        }
      }

      // Regular fan-out: min value, top-K by USD value, then taint allocation (HAIRCUT or FIFO).
      const priced = candidates.filter((t) => meetsMinValue(t.usd ?? null, minValueUsd));
      const top = topByUsd(priced, topK);
      const order = taintModel === 'FIFO' ? [...top].sort((a, b) => a.ts - b.ts) : top;
      const shares = allocateTaint(taintModel, taint, order.map((t) => ({ usd: t.usd ?? null })));
      const shareOf = new Map(order.map((t, i) => [edgeKey(t), shares[i]]));

      await persistEdges(chain, addr, hop, top, true);
      for (const edge of top) {
        const share = shareOf.get(edgeKey(edge)) ?? 0;
        if (share > 0) pushChild(chain, edge.to, share, hop + 1, edge.ts);
      }

      if (hopBuffer.length >= 500) await flush();
    }

    await flush();
    const durationMs = now() - start;
    await deps.prisma.traceJob.update({ where: { id: traceId }, data: { status: 'COMPLETED', finishedAt: new Date(now()) } });

    if (deps.onTerminal) {
      await Promise.all(
        terminals.map((t) =>
          deps.onTerminal!(t, job.caseId).catch((e) => console.error('B8 onTerminal hook failed (trace still completes)', e)),
        ),
      );
    }

    await deps.publish({ event: 'trace.completed', payload: { traceId, caseId: job.caseId, terminals, durationMs } });
    return { terminals, hopsWritten };
  } catch (err) {
    const isFinalAttempt = opts.attempt ? opts.attempt.made + 1 >= opts.attempt.max : true;
    if (isFinalAttempt) {
      await deps.prisma.traceJob.update({
        where: { id: traceId },
        data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err), finishedAt: new Date(now()) },
      });
    }
    throw err;
  }
}
