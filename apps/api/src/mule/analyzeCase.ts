import type { PrismaClient } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import type { Chain } from '@ps26183/shared';
import { findSharedMules, persistSharedMuleFlags, type CaseTouch, type SharedMuleCandidate, type SharedMulePrisma } from './crossCase';
import { DEFAULT_MULE_RULE_CONFIG, type MuleRuleConfig } from './config';
import { detectMuleActivity } from './detect';
import { computeMuleFeatures } from './features';
import { analyzeCaseGraph, type CommunityResult } from './gds';
import { bfsDepths, hopsToNearest } from './graphDistance';
import { persistMuleFlags, type MulePrisma } from './persist';
import { detectBtcPeelChain } from './rules/peelChain';
import type { HopLike, MuleFeatures, MuleFlagResult } from './types';

/** Label categories that make an address a stop condition/exit point (mirrors workers/trace/stopConditions.ts). */
const SERVICE_CATEGORIES = new Set(['exchange', 'mixer', 'bridge']);

const addrKey = (chain: string, addr: string): string => `${chain}:${addr}`;
function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

export interface AnalyzeCaseResult {
  addresses: number;
  flags: MuleFlagResult[];
  features: Record<string, MuleFeatures>;
  communities: CommunityResult[];
  sharedMules: SharedMuleCandidate[];
}

export interface AnalyzeCaseDeps {
  prisma: PrismaClient;
  driver?: Driver;
  config?: MuleRuleConfig;
}

/**
 * B6 top-level orchestrator: for one case, computes per-address mule/layering rules and Appendix B
 * features from its existing traced hops (B4) and account/label metadata (B1/B5), runs Neo4j GDS
 * (WCC, Louvain, degree, betweenness) on that case's subgraph, and checks every touched address for
 * cross-case (shared-mule) linkage. Every persisted row is upserted by a natural key, so calling this
 * again for the same case is idempotent and safe.
 */
export async function analyzeMuleRings(deps: AnalyzeCaseDeps, caseId: string): Promise<AnalyzeCaseResult> {
  const cfg = deps.config ?? DEFAULT_MULE_RULE_CONFIG;
  const mulePrisma: MulePrisma = { muleFlag: { upsert: (args) => deps.prisma.muleFlag.upsert(args as never) } };
  const sharedMulePrisma: SharedMulePrisma = { sharedMuleFlag: { upsert: (args) => deps.prisma.sharedMuleFlag.upsert(args as never) } };

  const hopRows = await deps.prisma.hop.findMany({ where: { trace: { caseId } }, orderBy: { ts: 'asc' } });
  if (hopRows.length === 0) return { addresses: 0, flags: [], features: {}, communities: [], sharedMules: [] };

  const traces = await deps.prisma.traceJob.findMany({
    where: { id: { in: [...new Set(hopRows.map((h) => h.traceId))] } },
    select: { id: true, seedChain: true, seedAddr: true },
  });
  const traceById = new Map(traces.map((t) => [t.id, t]));

  const hops = hopRows.map((h) => ({
    traceId: h.traceId,
    chain: h.chain as Chain,
    txHash: h.txHash,
    idx: h.idx,
    fromAddr: h.fromAddr,
    toAddr: h.toAddr,
    token: h.token,
    amount: h.amount.toFixed(),
    usd: h.usd ? h.usd.toFixed() : null,
    ts: h.ts,
  }));

  const inboundByAddr = new Map<string, typeof hops>();
  const outboundByAddr = new Map<string, typeof hops>();
  for (const h of hops) {
    const inKey = addrKey(h.chain, h.toAddr);
    const outKey = addrKey(h.chain, h.fromAddr);
    inboundByAddr.set(inKey, [...(inboundByAddr.get(inKey) ?? []), h]);
    outboundByAddr.set(outKey, [...(outboundByAddr.get(outKey) ?? []), h]);
  }
  const allAddrKeys = new Set([...inboundByAddr.keys(), ...outboundByAddr.keys()]);
  const addrsByChain = new Map<string, Set<string>>();
  for (const key of allAddrKeys) {
    const [chain, addr] = splitKey(key);
    addrsByChain.set(chain, new Set([...(addrsByChain.get(chain) ?? []), addr]));
  }
  const addrOrList = [...allAddrKeys].map((k) => { const [chain, addr] = splitKey(k); return { chain, addr }; });

  const [profiles, labels] = await Promise.all([
    addrOrList.length ? deps.prisma.addressProfile.findMany({ where: { OR: addrOrList } }) : Promise.resolve([]),
    addrOrList.length ? deps.prisma.label.findMany({ where: { OR: addrOrList } }) : Promise.resolve([]),
  ]);
  const profileByKey = new Map(profiles.map((p) => [addrKey(p.chain, p.addr), p]));
  const labelsByKey = new Map<string, typeof labels>();
  for (const l of labels) {
    const k = addrKey(l.chain, l.addr);
    labelsByKey.set(k, [...(labelsByKey.get(k) ?? []), l]);
  }
  const sanctionedAddrsByChain = new Map<string, Set<string>>();
  const vaspAddrsByChain = new Map<string, Set<string>>();
  for (const l of labels) {
    if (l.category === 'sanctioned') sanctionedAddrsByChain.set(l.chain, new Set([...(sanctionedAddrsByChain.get(l.chain) ?? []), l.addr]));
    if (SERVICE_CATEGORIES.has(l.category)) vaspAddrsByChain.set(l.chain, new Set([...(vaspAddrsByChain.get(l.chain) ?? []), l.addr]));
  }

  const edgesByTrace = new Map<string, { fromAddr: string; toAddr: string }[]>();
  for (const h of hops) edgesByTrace.set(h.traceId, [...(edgesByTrace.get(h.traceId) ?? []), { fromAddr: h.fromAddr, toAddr: h.toAddr }]);

  // --- cross-case linkage (independent of this case's rule firings) ---
  const touchesWhere = [...addrsByChain.entries()].map(([chain, addrs]) => ({
    chain,
    OR: [{ fromAddr: { in: [...addrs] } }, { toAddr: { in: [...addrs] } }],
  }));
  const touches = touchesWhere.length
    ? await deps.prisma.hop.findMany({ where: { OR: touchesWhere }, select: { chain: true, fromAddr: true, toAddr: true, trace: { select: { caseId: true } } } })
    : [];
  const caseTouches: CaseTouch[] = [];
  for (const t of touches) {
    if (allAddrKeys.has(addrKey(t.chain, t.fromAddr))) caseTouches.push({ chain: t.chain as Chain, addr: t.fromAddr, caseId: t.trace.caseId });
    if (allAddrKeys.has(addrKey(t.chain, t.toAddr))) caseTouches.push({ chain: t.chain as Chain, addr: t.toAddr, caseId: t.trace.caseId });
  }
  const caseIdsByKey = new Map<string, Set<string>>();
  for (const t of caseTouches) {
    const k = addrKey(t.chain, t.addr);
    caseIdsByKey.set(k, new Set([...(caseIdsByKey.get(k) ?? []), t.caseId]));
  }
  const sharedMules = findSharedMules(caseTouches);
  await persistSharedMuleFlags({ prisma: sharedMulePrisma }, sharedMules);

  // --- per-address rules ---
  const flags: MuleFlagResult[] = [];
  const accountCreatedAtByKey = new Map<string, number | null>();
  const firstTaintedAtByKey = new Map<string, number | null>();

  for (const key of allAddrKeys) {
    const [chain, addr] = splitKey(key);
    const inbound = inboundByAddr.get(key) ?? [];
    const outbound = outboundByAddr.get(key) ?? [];
    const profile = profileByKey.get(key);
    const accountCreatedAtMs = profile?.createdAt ? profile.createdAt.getTime() : null;
    const firstTaintedAtMs = inbound.length ? Math.min(...inbound.map((h) => h.ts.getTime())) : null;
    accountCreatedAtByKey.set(key, accountCreatedAtMs);
    firstTaintedAtByKey.set(key, firstTaintedAtMs);

    flags.push(...detectMuleActivity({ chain: chain as Chain, addr, inbound, outbound, accountCreatedAtMs, firstTaintedAtMs, config: cfg }));
  }

  // Bitcoin peel chains span multiple addresses; detect per trace and fold into the same flags list.
  const btcHopsByTrace = new Map<string, HopLike[]>();
  for (const h of hops) if (h.chain === 'BTC') btcHopsByTrace.set(h.traceId, [...(btcHopsByTrace.get(h.traceId) ?? []), h]);
  for (const btcHops of btcHopsByTrace.values()) {
    for (const match of detectBtcPeelChain(btcHops, cfg.peelChain)) {
      for (const addr of match.addresses) flags.push({ chain: 'BTC', addr, rule: 'PEEL_CHAIN', confidence: match.confidence, evidence: match.evidence });
    }
  }

  await persistMuleFlags({ prisma: mulePrisma }, flags);

  // --- Appendix B feature vector per address (informational; some fields need live provider data B6 does not fetch) ---
  const muleCandidateKeys = new Set(flags.map((f) => addrKey(f.chain, f.addr)));
  const features: Record<string, MuleFeatures> = {};
  for (const key of allAddrKeys) {
    const [chain, addr] = splitKey(key);
    const inbound = inboundByAddr.get(key) ?? [];
    const outbound = outboundByAddr.get(key) ?? [];
    const profile = profileByKey.get(key);
    const addrLabelCategories = (labelsByKey.get(key) ?? []).map((l) => l.category);
    const profileFlags = (profile?.flags as Record<string, unknown> | null) ?? null;
    const externalFlags = [...addrLabelCategories, ...(profileFlags ? Object.entries(profileFlags).filter(([, v]) => v === true).map(([k]) => k) : [])];

    let hopsFromVictim: number | null = null;
    let hopsToVasp: number | null = null;
    let sanctionExposure: number | null = null;
    const relevantTraceIds = new Set([...inbound, ...outbound].map((h) => h.traceId));
    for (const traceId of relevantTraceIds) {
      const edges = edgesByTrace.get(traceId) ?? [];
      const trace = traceById.get(traceId);
      if (trace) {
        const d = bfsDepths(edges, trace.seedAddr).get(addr);
        if (d != null && (hopsFromVictim == null || d < hopsFromVictim)) hopsFromVictim = d;
      }
      const vaspTargets = vaspAddrsByChain.get(chain) ?? new Set<string>();
      const dv = hopsToNearest(edges, addr, vaspTargets);
      if (dv != null && (hopsToVasp == null || dv < hopsToVasp)) hopsToVasp = dv;
      const sanctionTargets = sanctionedAddrsByChain.get(chain) ?? new Set<string>();
      const ds = hopsToNearest(edges, addr, sanctionTargets);
      if (ds != null && ds <= 2 && (sanctionExposure == null || ds < sanctionExposure)) sanctionExposure = ds;
    }

    const counterparties = new Set([...inbound.map((h) => h.fromAddr), ...outbound.map((h) => h.toAddr)]);
    let sharedMuleCps = 0;
    for (const cp of counterparties) if (muleCandidateKeys.has(addrKey(chain, cp))) sharedMuleCps++;

    const activatorAddr = profile?.activator ?? null;
    const activatorLabel = activatorAddr ? (labelsByKey.get(addrKey(chain, activatorAddr))?.[0]?.category ?? null) : null;

    features[key] = computeMuleFeatures({
      chain: chain as Chain,
      addr,
      inbound,
      outbound,
      accountCreatedAtMs: accountCreatedAtByKey.get(key) ?? null,
      firstTaintedAtMs: firstTaintedAtByKey.get(key) ?? null,
      activatorLabel,
      sanctionExposure,
      externalFlags,
      trxDustUsdt: flags.some((f) => f.rule === 'TRX_DUST_USDT' && addrKey(f.chain, f.addr) === key),
      hopsFromVictim,
      hopsToVasp,
      sharedMuleCps,
      crossCaseCount: caseIdsByKey.get(key)?.size ?? 1,
    });
  }

  // --- Neo4j GDS on the case subgraph ---
  const txHashes = [...new Set(hops.map((h) => h.txHash))];
  const communities = deps.driver ? await analyzeCaseGraph(deps.driver, caseId, txHashes) : [];
  for (const c of communities) {
    await deps.prisma.addressCommunity.upsert({
      where: { caseId_chain_addr: { caseId, chain: c.chain, addr: c.addr } },
      create: { caseId, chain: c.chain, addr: c.addr, wccId: c.wccId, louvainId: c.louvainId, degree: c.degree, betweenness: c.betweenness },
      update: { wccId: c.wccId, louvainId: c.louvainId, degree: c.degree, betweenness: c.betweenness },
    });
  }

  return { addresses: allAddrKeys.size, flags, features, communities, sharedMules };
}
