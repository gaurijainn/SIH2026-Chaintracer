import type { PrismaClient } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import { toIst } from '@ps26183/shared';
import { getCaseSubgraph } from '../graph/graph';
import { CaseNotFoundError } from './errors';
import type { EvidenceV1 } from './schema';

export interface CollectorDeps {
  prisma: PrismaClient;
  driver: Driver;
}

/** Per-chain block-explorer URL templates. TRON/BTC differ in path shape from the EVM chains. */
const EXPLORER_TX_URL: Record<string, (tx: string) => string> = {
  TRON: (tx) => `https://tronscan.org/#/transaction/${tx}`,
  ETH: (tx) => `https://etherscan.io/tx/${tx}`,
  BSC: (tx) => `https://bscscan.com/tx/${tx}`,
  POLYGON: (tx) => `https://polygonscan.com/tx/${tx}`,
  BTC: (tx) => `https://blockstream.info/tx/${tx}`,
};

function explorerUrl(chain: string, tx: string): string | null {
  const fn = EXPLORER_TX_URL[chain];
  return fn ? fn(tx) : null;
}

/**
 * Static system-limitation notes relevant to the chains B9 supports. Deliberately generic/factual
 * (not case-specific speculation) -- these describe known properties of the pipeline, not claims
 * about this particular case's evidence.
 */
const LIMITATIONS: string[] = [
  'Attribution confidence reflects heuristic matching against known VASP address lists and may not reflect ground truth control of an address.',
  'USD/INR conversions use best-effort historical rate data where available; hops without a resolvable rate show a null value rather than an estimate.',
  'The trace is bounded by the taint model, maximum hop count, minimum value threshold, and time window recorded under "methodology" below; funds moved outside those bounds are not represented.',
  'Risk scores and typology labels are produced by an automated model (see modelVersion per entry) and are investigative leads, not legal conclusions.',
  'Graph snapshot data reflects the state of the trace/graph store at report-generation time and is not re-verified against the source chain at read time.',
];

function methodologyDescription(taintModel: string | null, maxHops: number | null, minValueUsd: string | null, windowDays: number | null): string {
  const parts: string[] = [];
  if (taintModel) parts.push(`Funds were traced using the "${taintModel}" taint-propagation model`);
  if (maxHops !== null) parts.push(`up to ${maxHops} hops`);
  if (minValueUsd !== null) parts.push(`stopping when transfer value fell below $${minValueUsd} USD`);
  if (windowDays !== null) parts.push(`within a ${windowDays}-day window from the seed transaction`);
  return parts.length ? `${parts.join(', ')}.` : 'No trace parameters were recorded for this case.';
}

/**
 * Assembles the `evidence.v1` object for one case from existing B0-B8 tables only. Every field
 * without backing data is `null`/an empty array -- nothing here invents evidence. See
 * apps/api/src/reports/schema.ts for the exact shape and apps/api/src/reports/errors.ts for
 * CaseNotFoundError.
 */
export async function collectEvidence(deps: CollectorDeps, caseId: string): Promise<EvidenceV1> {
  const kase = await deps.prisma.case.findUnique({ where: { id: caseId } });
  if (!kase) throw new CaseNotFoundError(caseId);

  const [complaints, traces] = await Promise.all([
    deps.prisma.complaint.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' }, include: { addresses: true } }),
    deps.prisma.traceJob.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' } }),
  ]);

  const firstComplaint = complaints[0] ?? null;
  const firstAddress = firstComplaint?.addresses.find((a) => a.kind === 'ADDRESS') ?? firstComplaint?.addresses[0] ?? null;

  const victimTransaction: EvidenceV1['victimTransaction'] = firstComplaint
    ? {
        chain: firstAddress?.chain ?? null,
        address: firstAddress?.address ?? null,
        ackNo: firstComplaint.ackNo,
        amountInr: firstComplaint.amountInr.toString(),
        reportedAt: firstComplaint.reportedAt.toISOString(),
      }
    : null;

  const traceIds = traces.map((t) => t.id);
  const hops = traceIds.length ? await deps.prisma.hop.findMany({ where: { traceId: { in: traceIds } }, orderBy: [{ traceId: 'asc' }, { hopNo: 'asc' }] }) : [];

  const hopEntries: EvidenceV1['hops'] = hops.map((h) => {
    const ist = toIst(h.ts);
    return {
      hopNo: h.hopNo,
      chain: h.chain,
      from: h.fromAddr,
      to: h.toAddr,
      txHash: h.txHash,
      token: h.token,
      amount: h.amount.toString(),
      usd: h.usd ? h.usd.toString() : null,
      // Best-effort USD -> INR: only ever derived from data already on the row (never invented). No
      // INR conversion rate is currently persisted per-hop, so this is null until a rate source is
      // wired up; see plan note "best-effort via existing rate data, else null".
      amountInr: null,
      tsUtc: h.ts.toISOString(),
      tsIst: ist,
      explorerUrl: explorerUrl(h.chain, h.txHash),
    };
  });

  const txHashes = [...new Set(hops.map((h) => h.txHash))];
  const graph = txHashes.length ? await getCaseSubgraph(deps.driver, caseId, txHashes) : { nodes: [], edges: [] };

  const addrPairs = [...new Set(hops.flatMap((h) => [`${h.chain}\u0000${h.fromAddr}`, `${h.chain}\u0000${h.toAddr}`]))].map((k) => {
    const [chain, addr] = k.split('\u0000');
    return { chain, addr };
  });

  const attributionRows = addrPairs.length
    ? await deps.prisma.attribution.findMany({
        where: { OR: addrPairs.map((p) => ({ chain: p.chain, addr: p.addr })) },
        include: { vasp: true },
      })
    : [];
  const attribution: EvidenceV1['attribution'] = attributionRows.map((a) => ({
    chain: a.chain,
    addr: a.addr,
    vaspId: a.vaspId,
    vaspName: a.vasp.name,
    confidence: Number(a.confidence),
    heuristics: a.heuristics,
  }));

  // Most recent RiskScore per (chain, addr).
  const riskRows = addrPairs.length
    ? await deps.prisma.riskScore.findMany({
        where: { OR: addrPairs.map((p) => ({ chain: p.chain, addr: p.addr })) },
        orderBy: { createdAt: 'desc' },
      })
    : [];
  const seenRisk = new Set<string>();
  const risk: EvidenceV1['risk'] = [];
  for (const r of riskRows) {
    const key = `${r.chain}\u0000${r.addr}`;
    if (seenRisk.has(key)) continue;
    seenRisk.add(key);
    risk.push({
      chain: r.chain,
      addr: r.addr,
      score: r.score,
      band: r.band,
      factors: r.factors,
      typology: r.typology ?? null,
      typologyConfidence: r.typologyConfidence ? Number(r.typologyConfidence) : null,
      modelVersion: r.modelVersion,
      createdAt: r.createdAt.toISOString(),
    });
  }

  // One source entry per external provider actually touched by this case's own rows: attribution
  // heuristics/risk factors don't name a provider explicitly in this schema, so the honest, non-
  // invented source list is "the trace/complaint intake itself", each with its own row's createdAt
  // as the best-available retrieval timestamp.
  const sources: EvidenceV1['sources'] = [
    ...(firstComplaint ? [{ provider: 'ncrp-intake', retrievedAt: firstComplaint.createdAt.toISOString() }] : []),
    ...traces.map((t) => ({ provider: `chain-trace:${t.seedChain}`, retrievedAt: t.createdAt.toISOString() })),
  ];

  const primaryTrace = traces[0] ?? null;
  const methodology: EvidenceV1['methodology'] = {
    taintModel: primaryTrace?.taintModel ?? null,
    maxHops: primaryTrace?.maxHops ?? null,
    minValueUsd: primaryTrace ? primaryTrace.minValueUsd.toString() : null,
    windowDays: primaryTrace?.windowDays ?? null,
    description: methodologyDescription(primaryTrace?.taintModel ?? null, primaryTrace?.maxHops ?? null, primaryTrace ? primaryTrace.minValueUsd.toString() : null, primaryTrace?.windowDays ?? null),
  };

  return {
    schemaVersion: 'evidence.v1',
    generatedAt: new Date().toISOString(),
    case: {
      id: kase.id,
      title: kase.title,
      status: kase.status,
      firNumber: kase.firNumber ?? null,
      ackNo: firstComplaint?.ackNo ?? null,
    },
    victimTransaction,
    hops: hopEntries,
    graph,
    attribution,
    risk,
    sources,
    methodology,
    limitations: LIMITATIONS,
  };
}
