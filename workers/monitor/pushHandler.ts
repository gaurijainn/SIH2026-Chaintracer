import type { AlertEventPublisher } from './events';
import type { AlertPersistPrisma } from './alerts';
import { persistAndPublishAlert } from './alerts';
import { evaluateStateRules, evaluateTransferRules, type RuleContext, type StateRuleContext } from './rules';
import type { Chain, MonitorEvent } from '@ps26183/shared';

/** The exact subset of PrismaClient the EVM/BTC push handler needs. */
export interface PushHandlerPrisma extends AlertPersistPrisma {
  watchlistItem: {
    findMany(args: { where: { chain: string; addr: string } }): Promise<{ caseId: string }[]>;
  };
}

export interface PushHandlerDeps {
  prisma: PushHandlerPrisma;
  publish: AlertEventPublisher;
  ruleCtx: RuleContext;
  stateCtx: StateRuleContext;
  /** A5 fires a best-effort, non-blocking RiskService recompute (B7.6 reuse); failures never block the alert. */
  onA5Fired?: (chain: Chain, addr: string) => void;
  /**
   * Idempotency guard for transfer-triggered rules (A1-A3): returns true the FIRST time a given key is
   * seen and false on every repeat, e.g. `redis.set(key, '1', 'EX', ttl, 'NX')`. A1-A3 have no DB-level
   * uniqueness (unlike A4/A5, which use the alreadyFired existence-check pattern -- see rules.ts), so
   * without this guard a redelivered WS message (provider retransmit, reconnect racing a still-in-flight
   * message, at-least-once delivery) would persist a duplicate Alert for the exact same transfer.
   */
  isNewEvent: (key: string) => Promise<boolean>;
}

function dedupKey(event: MonitorEvent): string {
  return `b8:evt:${event.chain}:${event.txHash}:${event.direction}:${event.addr}`;
}

/**
 * B8 EVM/BTC push-monitoring event handler: the production logic behind workers/src/index.ts's
 * `handleMonitorEvent`, extracted so it can be exercised directly by tests (including the mock
 * WebSocket wire-protocol tests for the Alchemy/mempool.space clients) without booting the whole
 * worker process.
 *
 * Runs both transfer-triggered rules (A1-A3, same as the TRON poller) AND state rules (A4/A5) for
 * every observed event -- A4 (cross-case linkage) and A5 (blacklist) are chain-independent per the
 * B8 rule table (neither is scoped to TRON in the requirements), so a watched EVM/BTC address must
 * get the same A4/A5 coverage a TRON address gets each poll pass. Here, "once per poll pass" becomes
 * "once per observed event" -- state rules are re-evaluated on each push, but a4AlreadyFired/
 * a5AlreadyFired (existence checks against persisted Alerts) keep that idempotent.
 */
export async function handlePushMonitorEvent(deps: PushHandlerDeps, event: MonitorEvent): Promise<void> {
  if (!(await deps.isNewEvent(dedupKey(event)))) return;

  const items = await deps.prisma.watchlistItem.findMany({ where: { chain: event.chain, addr: event.addr } });
  if (items.length === 0) return;

  const findings = await evaluateTransferRules(event, deps.ruleCtx);
  for (const item of items) {
    for (const f of findings) {
      await persistAndPublishAlert(
        { prisma: deps.prisma, publish: deps.publish },
        { caseId: item.caseId, rule: f.rule, severity: f.severity, chain: event.chain, address: event.addr, amount: event.amount, message: f.message, metadata: f.metadata },
      );
    }
  }

  const stateFindings = await evaluateStateRules(event.chain, event.addr, deps.stateCtx);
  for (const item of items) {
    for (const f of stateFindings) {
      await persistAndPublishAlert(
        { prisma: deps.prisma, publish: deps.publish },
        { caseId: item.caseId, rule: f.rule, severity: f.severity, chain: event.chain, address: event.addr, amount: null, message: f.message, metadata: f.metadata },
      );
      if (f.rule === 'A5_BLACKLIST') deps.onA5Fired?.(event.chain, event.addr);
    }
  }
}
