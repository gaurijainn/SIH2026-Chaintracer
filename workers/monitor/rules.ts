import type { AlertRuleCode, AlertSeverityCode, Chain, MonitorEvent } from '@ps26183/shared';
import { DEFAULT_MONITOR_CONFIG, type MonitorConfig } from './config';

/** One fired rule, independent of which case(s)/WatchlistItem(s) it will fan out to. */
export interface RuleFinding {
  rule: AlertRuleCode;
  severity: AlertSeverityCode;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface VaspMatch {
  name: string;
}

export interface ObfuscationMatch {
  category: 'mixer' | 'bridge' | 'instant_swap';
  name: string;
}

export interface SharedMuleMatch {
  caseCount: number;
  caseIds: string[];
}

/**
 * Lookups injected so the rule functions stay pure and unit-testable with fakes -- no direct Prisma
 * or RiskService dependency here. The real implementations (workers/monitor/index.ts) reuse existing
 * B4/B5/B6/B7.6 read paths, per the task: this module never reimplements detection logic.
 */
export interface RuleContext {
  /** A2: Label lookup, same category:'exchange' pattern the B4 engine's stop condition already uses. */
  findVasp: (chain: Chain, addr: string) => Promise<VaspMatch | null>;
  /** A3: Label lookup for mixer/bridge/instant-swap categories. */
  findObfuscation: (chain: Chain, addr: string) => Promise<ObfuscationMatch | null>;
  config?: MonitorConfig;
}

export interface StateRuleContext {
  /** A4: existing B6 cross-case linkage (SharedMuleFlag), reused as-is -- not recomputed here. */
  getSharedMule: (chain: Chain, addr: string) => Promise<SharedMuleMatch | null>;
  /** A5: sanctioned (OFAC) label, or USDT stablecoin-blacklist flag on the address profile. */
  getBlacklistState: (chain: Chain, addr: string) => Promise<{ sanctioned: boolean; stablecoinBlacklisted: boolean } | null>;
  /** A5 dedup: an Alert with (chain, address, rule: A5_BLACKLIST) already exists, any status. See module docs. */
  a5AlreadyFired: (chain: Chain, addr: string) => Promise<boolean>;
  /** A4 dedup: same coarse mechanism as A5 -- an existing A4 alert for this (chain, addr) already covers it. */
  a4AlreadyFired: (chain: Chain, addr: string) => Promise<boolean>;
}

const usd = (v: number | null): number => v ?? 0;

/**
 * Transfer-triggered rules (A1/A2/A3), evaluated once per observed MonitorEvent (a new transfer
 * touching a watched address). Multiple rules can fire on the same event -- e.g. an outbound transfer
 * above the HIGH threshold that also lands on a VASP-attributed address fires both A1 and A2.
 */
export async function evaluateTransferRules(event: MonitorEvent, ctx: RuleContext): Promise<RuleFinding[]> {
  const cfg = ctx.config ?? DEFAULT_MONITOR_CONFIG;
  const findings: RuleFinding[] = [];

  // A1 Movement: the watched wallet SENDS above a threshold.
  if (event.direction === 'out') {
    const amountUsd = usd(event.usd);
    if (amountUsd >= cfg.a1Movement.highUsd) {
      findings.push({
        rule: 'A1_MOVEMENT',
        severity: 'HIGH',
        message: `Watched wallet ${event.addr} sent ~$${amountUsd.toFixed(2)} (tx ${event.txHash}) to ${event.counterparty}`,
      });
    } else if (amountUsd >= cfg.a1Movement.mediumUsd) {
      findings.push({
        rule: 'A1_MOVEMENT',
        severity: 'MEDIUM',
        message: `Watched wallet ${event.addr} sent ~$${amountUsd.toFixed(2)} (tx ${event.txHash}) to ${event.counterparty}`,
      });
    }
  }

  // A2 VASP landing: the far side of an outbound transfer is exchange-attributed.
  if (event.direction === 'out') {
    const vasp = await ctx.findVasp(event.chain, event.counterparty);
    if (vasp) {
      findings.push({
        rule: 'A2_VASP_LANDING',
        severity: 'CRITICAL',
        message: `Tainted funds from ${event.addr} reached exchange-attributed address ${event.counterparty} (${vasp.name}), tx ${event.txHash}`,
        metadata: {
          vaspName: vasp.name,
          freezeWindowOpen: true, // B9 consumes this: the state that a freeze notice can now be drafted against
          landingAddress: event.counterparty,
          txHash: event.txHash,
        },
      });
    }
  }

  // A3 Obfuscation: funds enter a mixer/bridge/instant-swap. Trace continuation on the far side is
  // B4's job (existing bridge-resolver / re-trace path); this rule only raises the alert and flags
  // that a continuation is warranted -- it does not re-run tracing itself.
  if (event.direction === 'out') {
    const obf = await ctx.findObfuscation(event.chain, event.counterparty);
    if (obf) {
      findings.push({
        rule: 'A3_OBFUSCATION',
        severity: 'HIGH',
        message: `Funds from ${event.addr} entered a ${obf.category} (${obf.name}), tx ${event.txHash}`,
        metadata: { obfuscationCategory: obf.category, obfuscationName: obf.name, continueTraceRecommended: true, txHash: event.txHash },
      });
    }
  }

  return findings;
}

/**
 * State-triggered rules (A4/A5), evaluated per polling pass over a watched (chain, addr) rather than
 * per transfer -- these are about what the address *is*, not what it just did.
 *
 * A5 "newly observed" dedup: rather than a separate blacklist-state-history table, we treat "an
 * Alert with (chain, address, rule: A5_BLACKLIST) already exists (any status)" as "already known" --
 * a coarse but correct approximation of "newly observed transition" (see StateRuleContext docs).
 * A4 uses the same coarse mechanism.
 */
export async function evaluateStateRules(chain: Chain, addr: string, ctx: StateRuleContext): Promise<RuleFinding[]> {
  const findings: RuleFinding[] = [];

  const shared = await ctx.getSharedMule(chain, addr);
  if (shared && shared.caseCount > 1 && !(await ctx.a4AlreadyFired(chain, addr))) {
    findings.push({
      rule: 'A4_LINKAGE',
      severity: 'HIGH',
      message: `${addr} is linked to ${shared.caseCount} cases via existing cluster analysis (B6 cross-case linkage)`,
      metadata: { linkedCaseIds: shared.caseIds },
    });
  }

  const blacklist = await ctx.getBlacklistState(chain, addr);
  if (blacklist && (blacklist.sanctioned || blacklist.stablecoinBlacklisted) && !(await ctx.a5AlreadyFired(chain, addr))) {
    findings.push({
      rule: 'A5_BLACKLIST',
      severity: blacklist.sanctioned ? 'HIGH' : 'INFO',
      message: blacklist.sanctioned
        ? `${addr} appears in an OFAC sanctions update`
        : `${addr} became USDT stablecoin-blacklisted`,
      metadata: { sanctioned: blacklist.sanctioned, stablecoinBlacklisted: blacklist.stablecoinBlacklisted, recomputeRisk: true },
    });
  }

  return findings;
}
