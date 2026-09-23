import type { AlertEventPublisher } from './events';
import { advanceCheckpoint, findDueTronAddresses, type MonitorPrisma } from './checkpoint';
import { DEFAULT_MONITOR_CONFIG, type MonitorConfig } from './config';
import { persistAndPublishAlert, type AlertPersistPrisma } from './alerts';
import { evaluateStateRules, evaluateTransferRules, type RuleContext, type StateRuleContext } from './rules';
import type { ChainAdapter, MonitorEvent } from '@ps26183/shared';
import { collectTransfers } from '../adapters/index';

export interface TronPollerDeps {
  prisma: MonitorPrisma & AlertPersistPrisma;
  tronAdapter: ChainAdapter;
  publish: AlertEventPublisher;
  ruleCtx: RuleContext;
  stateCtx: StateRuleContext;
  config?: MonitorConfig;
  now?: () => number;
  /** A5 fires a best-effort, non-blocking RiskService recompute (B7.6 reuse); failures never block the alert. */
  onA5Fired?: (chain: 'TRON', addr: string) => void;
}

export interface PollResult {
  addressesDue: number;
  transfersSeen: number;
  alertsCreated: number;
}

/**
 * B8 adaptive TRON polling: one pass over every "due" watched TRON address (per tier interval, see
 * checkpoint.ts), fetching only transfers since the last checkpoint via the existing B3
 * `ChainAdapter.getTransfers({since})` incremental-poll support -- no new HTTP adapter code.
 *
 * Dedup/restart-safety: the checkpoint is advanced to (latest transfer ts + 1ms) only after that
 * transfer's alerts have been persisted, so a re-run (including after a worker restart, since the
 * checkpoint is a Postgres row, not in-memory state) never re-fetches or re-alerts an already-seen
 * transfer -- `since` is inclusive, so +1ms excludes exactly the last-seen instant.
 */
export async function pollDueTronAddresses(deps: TronPollerDeps): Promise<PollResult> {
  const now = deps.now ?? Date.now;
  const config = deps.config ?? DEFAULT_MONITOR_CONFIG;
  const nowMs = now();

  const due = await findDueTronAddresses(deps.prisma, nowMs, config);
  let transfersSeen = 0;
  let alertsCreated = 0;

  for (const d of due) {
    const collected = await collectTransfers(deps.tronAdapter, d.addr, 'out', { since: d.since });

    for (const t of collected.items) {
      transfersSeen++;
      const event: MonitorEvent = {
        chain: 'TRON',
        addr: d.addr,
        direction: 'out',
        counterparty: t.to,
        txHash: t.txHash,
        token: t.token,
        amount: t.amount,
        usd: t.usd ?? null,
        ts: t.ts,
      };
      const findings = await evaluateTransferRules(event, deps.ruleCtx);
      for (const caseId of d.caseIds) {
        for (const f of findings) {
          await persistAndPublishAlert(
            { prisma: deps.prisma, publish: deps.publish },
            { caseId, rule: f.rule, severity: f.severity, chain: 'TRON', address: d.addr, amount: t.amount, message: f.message, metadata: f.metadata },
          );
          alertsCreated++;
        }
      }
    }

    // State rules (A4/A5) evaluated once per due address per pass, not per transfer.
    const stateFindings = await evaluateStateRules('TRON', d.addr, deps.stateCtx);
    for (const caseId of d.caseIds) {
      for (const f of stateFindings) {
        await persistAndPublishAlert(
          { prisma: deps.prisma, publish: deps.publish },
          { caseId, rule: f.rule, severity: f.severity, chain: 'TRON', address: d.addr, amount: null, message: f.message, metadata: f.metadata },
        );
        alertsCreated++;
        if (f.rule === 'A5_BLACKLIST') deps.onA5Fired?.('TRON', d.addr);
      }
    }

    // Checkpoint to the poll's own clock (not the latest transfer's ts): this is both the tier
    // due-check anchor and the next poll's `since` -- using "now" naturally excludes every transfer
    // already seen this pass (their ts <= now) without re-deriving a same-instant boundary, and keeps
    // the tier interval ticking off wall-clock time rather than drifting backwards to a stale
    // transfer timestamp (which would make an address perpetually "due" once anything old is polled).
    await advanceCheckpoint(deps.prisma, 'TRON', d.addr, nowMs, collected.items.at(-1)?.txHash ?? null);
  }

  return { addressesDue: due.length, transfersSeen, alertsCreated };
}
