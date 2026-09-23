import type { Chain } from '@ps26183/shared';
import { computeMuleFeatures } from '../mule/features';
import { bfsDepths, hopsToNearest } from '../mule/graphDistance';
import type { HopLike, MuleFeatures } from '../mule/types';
import { TraceNotFoundError } from './errors';
import { lookupSanctionEvidence, type SanctionEvidence, type SanctionLookupPrisma } from './sanctionLookup';

/** Label categories that make an address a stop condition/exit point (mirrors mule/analyzeCase.ts). */
const SERVICE_CATEGORIES = new Set(['exchange', 'mixer', 'bridge']);

interface HopRow {
  chain: string;
  txHash: string;
  idx: number;
  fromAddr: string;
  toAddr: string;
  token: string;
  amount: unknown; // Prisma.Decimal, .toFixed() below
  usd: unknown | null;
  ts: Date;
  /** present only when the query asked for it via `include: { trace: { select: { caseId: true } } }`. */
  trace?: { caseId: string };
}

interface ProfileRow {
  createdAt: Date | null;
  activator: string | null;
}

interface LabelRow {
  addr: string;
  category: string;
  name: string;
}

interface TraceRow {
  id: string;
  seedChain: string;
  seedAddr: string;
  caseId: string;
}

/** The exact subset of PrismaClient this module needs (structural, matches the mule/* module convention). */
export interface FeatureAssemblyPrisma extends SanctionLookupPrisma {
  traceJob: { findUnique(args: { where: { id: string } }): Promise<TraceRow | null> };
  hop: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      include?: Record<string, unknown>;
    }): Promise<HopRow[]>;
  };
  addressProfile: { findUnique(args: { where: { chain_addr: { chain: string; addr: string } } }): Promise<ProfileRow | null> };
  label: SanctionLookupPrisma['label'] & { findMany(args: { where: Record<string, unknown> }): Promise<LabelRow[]> };
  muleFlag: {
    findMany(args: { where: Record<string, unknown> }): Promise<{ addr: string }[]>;
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
  };
  complaint: { findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }): Promise<{ category: string } | null> };
}

export interface TypologyContext {
  /** Only fields we genuinely know are set; everything else is left absent (never guessed). */
  caseFeatures: Record<string, boolean | undefined>;
  complaintCategory?: string;
}

export interface AssembledFeatures {
  features: MuleFeatures;
  evidence: SanctionEvidence;
  typologyContext: TypologyContext;
}

function toHopLike(row: HopRow): HopLike {
  const amount = row.amount as { toFixed(): string } | string | number;
  const usd = row.usd as { toFixed(): string } | string | number | null;
  return {
    txHash: row.txHash,
    idx: row.idx,
    fromAddr: row.fromAddr,
    toAddr: row.toAddr,
    token: row.token,
    amount: typeof amount === 'object' && amount !== null ? amount.toFixed() : amount,
    usd: usd == null ? null : typeof usd === 'object' ? usd.toFixed() : usd,
    ts: row.ts,
  };
}

/**
 * Builds the 15-field B6 Appendix-B feature vector for one live address, plus sanction/blacklist
 * evidence and whatever typology-relevant case signals genuinely exist, for `POST /addresses/:chain/:addr/risk`.
 *
 * Mirrors `mule/analyzeCase.ts`'s per-address derivation (BFS depth to seed/VASP/sanctioned addresses,
 * shared-mule candidate counts, label prefetch by category) but scoped to a single target address
 * instead of every address touched by a case.
 *
 * With `traceId`: `hopsFromVictim`/`hopsToVasp`/`sharedMuleCps`/`crossCaseCount` are derived from
 * that trace's own hop graph (case-graph context). Without it: those four are set to their "no
 * context available" value -- null for the two hop-distance fields, 0 for the two count fields --
 * exactly mirroring `mule/bootstrap/tracedAddressProvider.ts`'s "never invented" convention (a
 * count of 0 known instances is honest; a guessed hop-distance is not, so those stay null).
 * All other fields (dwell/fan-out/fan-in/passthrough/age/activator/round-amount/burst/dust/flags)
 * are always derived from this address's own real Hop/AddressProfile/Label rows, with or without a traceId.
 */
export async function assembleAddressFeatures(
  deps: { prisma: FeatureAssemblyPrisma },
  chain: Chain,
  addr: string,
  traceId?: string,
): Promise<AssembledFeatures> {
  const { prisma } = deps;

  let trace: TraceRow | null = null;
  if (traceId) {
    trace = await prisma.traceJob.findUnique({ where: { id: traceId } });
    if (!trace) throw new TraceNotFoundError(traceId);
  }

  const hopRows: HopRow[] = trace
    ? await prisma.hop.findMany({ where: { traceId, chain }, orderBy: { ts: 'asc' } })
    : await prisma.hop.findMany({ where: { chain, OR: [{ fromAddr: addr }, { toAddr: addr }] }, orderBy: { ts: 'asc' } });

  const inboundRows = hopRows.filter((h) => h.toAddr === addr);
  const outboundRows = hopRows.filter((h) => h.fromAddr === addr);
  const inbound = inboundRows.map(toHopLike);
  const outbound = outboundRows.map(toHopLike);

  const [profile, ownLabels] = await Promise.all([
    prisma.addressProfile.findUnique({ where: { chain_addr: { chain, addr } } }),
    prisma.label.findMany({ where: { chain, addr } }),
  ]);

  const accountCreatedAtMs = profile?.createdAt ? profile.createdAt.getTime() : null;
  const firstTaintedAtMs = inbound.length ? Math.min(...inbound.map((h) => (h.ts as Date).getTime())) : null;
  const externalFlags = ownLabels.map((l) => l.category);

  let activatorLabel: string | null = null;
  if (profile?.activator) {
    const activatorLabels = await prisma.label.findMany({ where: { chain, addr: profile.activator } });
    activatorLabel = activatorLabels[0]?.category ?? null;
  }

  const evidence = await lookupSanctionEvidence(deps, chain, addr);

  // trxDustUsdt: does a persisted B6 flag already say so for this address? (Reuses persisted state
  // rather than re-running detectMuleActivity's own rule logic here, which is B6 core and read-only.)
  const trxDustFlag = await prisma.muleFlag.findFirst({ where: { chain, addr, rule: 'TRX_DUST_USDT' } });
  const trxDustUsdt = Boolean(trxDustFlag);

  let hopsFromVictim: number | null = null;
  let hopsToVasp: number | null = null;
  let sanctionExposure: number | null = null;
  let sharedMuleCps = 0;
  let crossCaseCount = 0;
  let bitcoinHeavy: boolean | undefined;
  let complaintCategory: string | undefined;

  if (trace) {
    const edges = hopRows.map((h) => ({ fromAddr: h.fromAddr, toAddr: h.toAddr }));
    const touchedAddrs = new Set<string>();
    for (const e of edges) {
      touchedAddrs.add(e.fromAddr);
      touchedAddrs.add(e.toAddr);
    }
    const touchedLabels = touchedAddrs.size
      ? await prisma.label.findMany({ where: { OR: [...touchedAddrs].map((a) => ({ chain, addr: a })) } })
      : [];
    const sanctionedTargets = new Set(touchedLabels.filter((l) => l.category === 'sanctioned').map((l) => l.addr));
    const vaspTargets = new Set(touchedLabels.filter((l) => SERVICE_CATEGORIES.has(l.category)).map((l) => l.addr));

    const d = bfsDepths(edges, trace.seedAddr).get(addr);
    hopsFromVictim = d ?? null;
    hopsToVasp = hopsToNearest(edges, addr, vaspTargets);
    const ds = hopsToNearest(edges, addr, sanctionedTargets);
    sanctionExposure = ds != null && ds <= 2 ? ds : null;

    const counterparties = new Set([...inbound.map((h) => h.fromAddr), ...outbound.map((h) => h.toAddr)]);
    if (counterparties.size) {
      const cpFlags = await prisma.muleFlag.findMany({ where: { chain, addr: { in: [...counterparties] } } });
      sharedMuleCps = new Set(cpFlags.map((f) => f.addr)).size;
    }

    const caseTouches = await prisma.hop.findMany({
      where: { chain, OR: [{ fromAddr: addr }, { toAddr: addr }] },
      include: { trace: { select: { caseId: true } } },
    });
    const caseIds = new Set(caseTouches.map((t) => t.trace?.caseId).filter((id): id is string => Boolean(id)));
    crossCaseCount = caseIds.size;

    if (chain === 'BTC') bitcoinHeavy = true; // directly derivable from the chain itself, never guessed for non-BTC

    const complaint = await prisma.complaint.findFirst({ where: { caseId: trace.caseId }, orderBy: { createdAt: 'desc' } });
    if (complaint?.category) complaintCategory = complaint.category;
  }

  const features = computeMuleFeatures({
    chain,
    addr,
    inbound,
    outbound,
    accountCreatedAtMs,
    firstTaintedAtMs,
    activatorLabel,
    sanctionExposure,
    externalFlags,
    trxDustUsdt,
    hopsFromVictim,
    hopsToVasp,
    sharedMuleCps,
    crossCaseCount,
  });

  const caseFeatures: Record<string, boolean | undefined> = {};
  if (bitcoinHeavy !== undefined) caseFeatures.bitcoin_heavy = bitcoinHeavy;

  return {
    features,
    evidence,
    typologyContext: { caseFeatures, complaintCategory },
  };
}
