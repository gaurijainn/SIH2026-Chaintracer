import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { TRACE_QUEUE_DEFAULT, TRACE_QUEUE_TRON, defaultTokenContract, type Chain } from '@ps26183/shared';
import { normalizeComplaint } from './normalize';
import { createProbeRunner, type ChainProbe } from './probe';
import type { TraceJobPayload, TraceQueue } from './queue';
import { resolveEntries } from './resolve';
import { seedChainsOf, type Issue, type NormalizedComplaint, type RawComplaint, type ResolvedEntry } from './types';
import { FIR_PII_CONTEXT, type PiiCipher } from '../auth/pii';

export interface TraceDefaults {
  maxHops: number;
  minValueUsd: number;
  windowDays: number;
  taintModel: 'HAIRCUT' | 'FIFO';
}

export interface IntakeDeps {
  prisma: PrismaClient;
  queue: TraceQueue | null;
  probe: ChainProbe | null;
  defaults: TraceDefaults;
  now?: () => Date;
  /** B10: when set, person-linked fields (Case.firNumber) are AES-256-GCM encrypted before they reach the database. */
  pii?: PiiCipher;
}

/** One input row: a raw complaint, or a parse error from the CSV reader. `row` is the 1-based line/record number. */
export interface IngestInput {
  row: number;
  raw?: RawComplaint;
  error?: Issue;
}

export type RowStatus = 'CREATED' | 'DUPLICATE' | 'INVALID';

export interface PreparedTrace {
  id: string;
  chain: Chain;
  seed: string;
  queue: string;
  reused: boolean;
}

export interface RowResult {
  row: number;
  ackNo: string | null;
  status: RowStatus;
  errors: Issue[];
  warnings: Issue[];
  duplicateOf?: 'existing' | 'file';
  complaintId?: string;
  caseId?: string;
  caseCreated?: boolean;
  /** Other cases this complaint shares a wallet with (crime linkage). The complaint joins the earliest one. */
  linkedCaseIds?: string[];
  linkedAckNos?: string[];
  entries?: Pick<ResolvedEntry, 'raw' | 'value' | 'kind' | 'chain' | 'candidateChains' | 'flags'>[];
  traceJobs?: PreparedTrace[];
}

export interface IngestSummary {
  total: number;
  created: number;
  duplicates: number;
  invalid: number;
  linked: number;
  casesCreated: number;
  traceJobsPrepared: number;
  tronTraceJobs: number;
  queued: number;
  queueError?: string;
  timings: { validationMs: number; persistMs: number; totalMs: number };
}

export interface ListQuery {
  page: number;
  pageSize: number;
  ackNo?: string;
  category?: string;
  chain?: string;
  caseId?: string;
  from?: Date;
  to?: Date;
}

export interface IngestResult {
  summary: IngestSummary;
  rows: RowResult[];
}

const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const queueName = (c: Chain) => (c === 'TRON' ? TRACE_QUEUE_TRON : TRACE_QUEUE_DEFAULT);
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

interface Match {
  caseId: string;
  rank: number;
  ackNo: string;
}
interface Item {
  idx: number;
  c: NormalizedComplaint;
  entries: ResolvedEntry[];
}

export function createIntakeService(deps: IntakeDeps) {
  const { prisma, defaults } = deps;
  const now = deps.now ?? (() => new Date());

  const payloadOf = (t: { id: string; caseId: string; seedChain: string; seedAddr: string }): TraceJobPayload => ({
    traceId: t.id,
    caseId: t.caseId,
    chain: t.seedChain as Chain,
    seed: t.seedAddr,
    token: defaultTokenContract(t.seedChain as Chain),
    options: { ...defaults },
    source: 'intake',
  });

  async function findExisting(ackNos: string[]) {
    const out = new Map<string, { id: string; caseId: string | null }>();
    for (const part of chunk(ackNos, 5000)) {
      for (const r of await prisma.complaint.findMany({ where: { ackNo: { in: part } }, select: { id: true, ackNo: true, caseId: true } })) {
        out.set(r.ackNo, { id: r.id, caseId: r.caseId });
      }
    }
    return out;
  }

  /** Writes cases, complaints, entries and trace jobs for the batch in one transaction. */
  async function persist(items: Item[], results: RowResult[], batchStart: number) {
    // crime linkage: any wallet already on another complaint (or earlier in this batch) puts the complaint in that case
    const addrs = [...new Set(items.flatMap((i) => i.entries.filter((e) => e.kind === 'ADDRESS').map((e) => e.value)))];
    const known = new Map<string, Match[]>();
    for (const part of chunk(addrs, 5000)) {
      const rows = await prisma.complaintAddress.findMany({
        where: { kind: 'ADDRESS', address: { in: part }, complaint: { caseId: { not: null } } },
        select: { address: true, complaint: { select: { ackNo: true, caseId: true, case: { select: { createdAt: true } } } } },
      });
      for (const r of rows) {
        const m: Match = { caseId: r.complaint.caseId!, rank: r.complaint.case!.createdAt.getTime(), ackNo: r.complaint.ackNo };
        known.set(r.address, [...(known.get(r.address) ?? []), m]);
      }
    }

    const cases: Prisma.CaseCreateManyInput[] = [];
    const complaints: Prisma.ComplaintCreateManyInput[] = [];
    const entryRows: Prisma.ComplaintAddressCreateManyInput[] = [];
    const caseRank = new Map<string, number>();
    const caseOf = new Map<number, string>();

    items.forEach((it, n) => {
      const values = it.entries.filter((e) => e.kind === 'ADDRESS').map((e) => e.value);
      const matches = values.flatMap((v) => known.get(v) ?? []);
      const r = results[it.idx];
      let caseId: string;
      if (matches.length) {
        const primary = matches.reduce((a, b) => (b.rank < a.rank ? b : a));
        caseId = primary.caseId;
        caseRank.set(caseId, primary.rank);
        r.linkedCaseIds = [...new Set(matches.map((m) => m.caseId))];
        r.linkedAckNos = [...new Set(matches.map((m) => m.ackNo))];
      } else {
        caseId = randomUUID();
        const rank = batchStart + n;
        caseRank.set(caseId, rank);
        cases.push({
          id: caseId,
          title: `NCRP ${it.c.ackNo}: ${it.c.category}`.slice(0, 200),
          firNumber: deps.pii ? deps.pii.encryptNullable(it.c.firNumber, FIR_PII_CONTEXT) : (it.c.firNumber ?? null),
          createdAt: new Date(rank),
        });
        r.caseCreated = true;
      }
      caseOf.set(it.idx, caseId);
      for (const v of values) known.set(v, [...(known.get(v) ?? []), { caseId, rank: caseRank.get(caseId)!, ackNo: it.c.ackNo }]);

      const complaintId = randomUUID();
      r.complaintId = complaintId;
      r.caseId = caseId;
      complaints.push({
        id: complaintId,
        ackNo: it.c.ackNo,
        reportedAt: it.c.reportedAt,
        category: it.c.category,
        amountInr: it.c.amountInr,
        network: it.c.network ?? null,
        tokenContract: it.c.tokenContract ?? null,
        caseId,
      });
      for (const e of it.entries) {
        entryRows.push({
          complaintId,
          raw: e.raw,
          address: e.value,
          chain: e.chain,
          kind: e.kind,
          candidateChains: e.candidateChains,
          flags: e.flags,
        });
      }
    });

    // trace-job preparation: one per (case, chain, seed); reuse rows that already exist for a joined case
    const newCaseIds = new Set(cases.map((c) => c.id));
    const existingCaseIds = [...new Set(items.map((i) => caseOf.get(i.idx)!).filter((id) => !newCaseIds.has(id)))];
    const existingTraces = new Map<string, { id: string; caseId: string; seedChain: string; seedAddr: string; status: string }>();
    for (const part of chunk(existingCaseIds, 5000)) {
      for (const t of await prisma.traceJob.findMany({ where: { caseId: { in: part } }, select: { id: true, caseId: true, seedChain: true, seedAddr: true, status: true } })) {
        existingTraces.set(`${t.caseId}|${t.seedChain}|${t.seedAddr}`, t);
      }
    }
    const newTraces: Prisma.TraceJobCreateManyInput[] = [];
    const toEnqueue: TraceJobPayload[] = [];
    const seenKeys = new Map<string, string>();
    for (const it of items) {
      const caseId = caseOf.get(it.idx)!;
      const prepared: PreparedTrace[] = [];
      for (const e of it.entries) {
        for (const chain of seedChainsOf(e)) {
          const key = `${caseId}|${chain}|${e.value}`;
          const have = existingTraces.get(key);
          let id = have?.id ?? seenKeys.get(key);
          const reused = !!id;
          if (!id) {
            id = randomUUID();
            seenKeys.set(key, id);
            const row: Prisma.TraceJobCreateManyInput = {
              id,
              caseId,
              seedChain: chain,
              seedAddr: e.value,
              status: 'QUEUED',
              maxHops: defaults.maxHops,
              minValueUsd: defaults.minValueUsd,
              windowDays: defaults.windowDays,
              taintModel: defaults.taintModel,
              reportedAmount: null,
            };
            newTraces.push(row);
            toEnqueue.push(payloadOf({ id, caseId, seedChain: chain, seedAddr: e.value }));
          } else if (have && have.status === 'QUEUED' && !toEnqueue.some((p) => p.traceId === id)) {
            toEnqueue.push(payloadOf(have));
          }
          prepared.push({ id, chain, seed: e.value, queue: queueName(chain), reused });
        }
      }
      results[it.idx].traceJobs = prepared;
    }

    await prisma.$transaction(
      async (tx) => {
        for (const part of chunk(cases, 1000)) await tx.case.createMany({ data: part });
        for (const part of chunk(complaints, 1000)) await tx.complaint.createMany({ data: part });
        for (const part of chunk(entryRows, 2000)) await tx.complaintAddress.createMany({ data: part });
        for (const part of chunk(newTraces, 1000)) await tx.traceJob.createMany({ data: part });
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    return { toEnqueue, casesCreated: cases.length, tracesNew: newTraces.length };
  }

  async function ingest(inputs: IngestInput[]): Promise<IngestResult> {
    const t0 = performance.now();
    const results: RowResult[] = inputs.map((i) => ({
      row: i.row,
      ackNo: (typeof i.raw?.ackNo === 'string' ? i.raw.ackNo.trim() : '') || null,
      status: 'INVALID',
      errors: [],
      warnings: [],
    }));

    // 1. normalise + validate (pure), and drop repeats of an acknowledgement number within the input
    let pending: { idx: number; c: NormalizedComplaint }[] = [];
    const firstSeen = new Set<string>();
    inputs.forEach((inp, idx) => {
      const r = results[idx];
      if (inp.error) {
        r.errors.push(inp.error);
        return;
      }
      const n = normalizeComplaint(inp.raw ?? {}, now());
      r.errors = n.errors;
      r.warnings = n.warnings;
      if (!n.value) return;
      r.ackNo = n.value.ackNo;
      if (firstSeen.has(n.value.ackNo)) {
        r.status = 'DUPLICATE';
        r.duplicateOf = 'file';
        return;
      }
      firstSeen.add(n.value.ackNo);
      pending.push({ idx, c: n.value });
    });

    // 2. deduplicate against complaints already stored (before any network probing)
    const dupCaseIds = new Set<string>();
    const dropExisting = async () => {
      const existing = await findExisting(pending.map((p) => p.c.ackNo));
      pending = pending.filter((p) => {
        const hit = existing.get(p.c.ackNo);
        if (!hit) return true;
        const r = results[p.idx];
        r.status = 'DUPLICATE';
        r.duplicateOf = 'existing';
        r.complaintId = hit.id;
        if (hit.caseId) {
          r.caseId = hit.caseId;
          dupCaseIds.add(hit.caseId);
        }
        return false;
      });
    };
    await dropExisting();

    // 3. chain detection: TRON/BTC by format, EVM ambiguity by network field then parallel probe
    const runner = createProbeRunner(deps.probe);
    let items: Item[] = await Promise.all(
      pending.map(async (p) => {
        const { entries, warnings } = await resolveEntries(p.c, runner);
        results[p.idx].warnings.push(...warnings);
        return { idx: p.idx, c: p.c, entries };
      }),
    );
    const validationMs = performance.now() - t0;

    // 4. persist (retry once if a concurrent import created the same acknowledgement number)
    const t1 = performance.now();
    let persisted = { toEnqueue: [] as TraceJobPayload[], casesCreated: 0, tracesNew: 0 };
    for (let attempt = 0; items.length; attempt++) {
      try {
        persisted = await persist(items, results, Date.now());
        break;
      } catch (e) {
        if (!isUniqueViolation(e) || attempt >= 2) throw e;
        for (const it of items) Object.assign(results[it.idx], { complaintId: undefined, caseId: undefined, caseCreated: undefined, linkedCaseIds: undefined, linkedAckNos: undefined, traceJobs: undefined });
        pending = items.map((i) => ({ idx: i.idx, c: i.c }));
        await dropExisting();
        const keep = new Set(pending.map((p) => p.idx));
        items = items.filter((i) => keep.has(i.idx));
      }
    }
    for (const it of items) {
      const r = results[it.idx];
      r.status = 'CREATED';
      r.entries = it.entries.map(({ raw, value, kind, chain, candidateChains, flags }) => ({ raw, value, kind, chain, candidateChains, flags }));
    }
    // duplicates re-assert their still-QUEUED trace jobs (same job id => no double enqueue)
    if (dupCaseIds.size) {
      const queued = await prisma.traceJob.findMany({
        where: { caseId: { in: [...dupCaseIds] }, status: 'QUEUED' },
        select: { id: true, caseId: true, seedChain: true, seedAddr: true },
      });
      const have = new Set(persisted.toEnqueue.map((p) => p.traceId));
      for (const t of queued) if (!have.has(t.id)) persisted.toEnqueue.push(payloadOf(t));
    }

    // 5. enqueue after commit; TRON jobs go first onto their own queue
    let queued = 0;
    let queueError: string | undefined;
    if (deps.queue && persisted.toEnqueue.length) {
      try {
        queued = await deps.queue.enqueue(persisted.toEnqueue);
      } catch (e) {
        queueError = e instanceof Error ? e.message : String(e); // rows stay QUEUED in PostgreSQL; a re-import re-enqueues them
      }
    }
    const persistMs = performance.now() - t1;

    const tracePrepared = results.flatMap((r) => (r.status === 'CREATED' ? (r.traceJobs ?? []) : []));
    return {
      rows: results,
      summary: {
        total: results.length,
        created: results.filter((r) => r.status === 'CREATED').length,
        duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
        invalid: results.filter((r) => r.status === 'INVALID').length,
        linked: results.filter((r) => r.status === 'CREATED' && r.linkedCaseIds?.length).length,
        casesCreated: persisted.casesCreated,
        traceJobsPrepared: persisted.tracesNew,
        tronTraceJobs: tracePrepared.filter((t) => t.chain === 'TRON' && !t.reused).length,
        queued,
        ...(queueError ? { queueError } : {}),
        timings: { validationMs: Math.round(validationMs), persistMs: Math.round(persistMs), totalMs: Math.round(performance.now() - t0) },
      },
    };
  }

  async function list(q: ListQuery) {
    const where: Prisma.ComplaintWhereInput = {
      ...(q.ackNo ? { ackNo: q.ackNo } : {}),
      ...(q.category ? { category: { contains: q.category, mode: 'insensitive' } } : {}),
      ...(q.caseId ? { caseId: q.caseId } : {}),
      ...(q.from || q.to ? { reportedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.chain ? { addresses: { some: { OR: [{ chain: q.chain }, { candidateChains: { has: q.chain } }] } } } : {}),
    };
    const [total, items] = await prisma.$transaction([
      prisma.complaint.count({ where }),
      prisma.complaint.findMany({
        where,
        include: { addresses: true, case: { select: { id: true, title: true, status: true } } },
        orderBy: [{ reportedAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items };
  }

  return { ingest, list };
}
export type IntakeService = ReturnType<typeof createIntakeService>;
