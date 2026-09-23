import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '@ps26183/shared';
import type { AlertEventEnvelope } from '@ps26183/shared';
import { createChainLayer, collectTransfers } from '../adapters/index';
import { DEMO } from '../adapters/testing';
import type { CreatedAlert, AlertPersistPrisma } from './alerts';
import { persistAndPublishAlert } from './alerts';
import { evaluateTransferRules, type RuleContext } from './rules';

/**
 * B8 report item 5 (TRON B0 replay gap): the B8 golden test (apps/api/src/monitor/b8Golden.int.test.ts)
 * exercises the poller/rules/alert pipeline against hand-built B8 fixture JSON (fixtures/monitor/*),
 * not against an actual recorded-shape TronGrid response. This test closes that gap using the REAL
 * TronAdapter (workers/adapters/tron.ts, unchanged) in DATA_MODE=replay against the repo's existing,
 * already-checked-in B0/B3 fixtures (fixtures/trongrid/*.json -- see scripts/seed-fixtures-b3.mts;
 * these are the project's own committed demo fixtures, flagged `synthetic: true`, not a live capture).
 * No live or record call against a real provider is made here or anywhere in this test.
 *
 * One real limitation this test surfaces (documented in the B8 report rather than papered over): the
 * checked-in fixtures were recorded via `collectTransfers(adapter, addr, 'out')` with NO `since`
 * (scripts/seed-fixtures-b3.mts / smoke-lib.ts's DEMO_READ), so their fixture filenames are keyed to a
 * TronGrid URL with no `min_timestamp` param. `pollDueTronAddresses` (tronPoller.ts) always calls
 * `collectTransfers(..., { since: d.since })` with a numeric `since` (0 on a first-ever poll, per
 * checkpoint.ts) -- a URL that ALWAYS includes `min_timestamp`, and so never matches the checked-in
 * fixture's filename. Recording a new fixture for that exact URL was out of scope here (no new
 * recording without explicit authorization, per the B8 report instructions), so this test calls the
 * real adapter the same way the existing checked-in fixture supports (`since` omitted) and then runs
 * the exact same downstream code `pollDueTronAddresses` composes (`evaluateTransferRules` +
 * `persistAndPublishAlert`) -- proving the real parse-to-alert path end to end, short of the poller's
 * own since-parameterized fetch call. See the B8 report's "known limitations" for the one-line fix
 * (pre-seed a MonitorCheckpoint fixture, or record one additional fixture for the since-parameterized
 * URL) if this gap should be closed fully in a follow-up with recording authorization.
 */

function fakeAlertPrisma() {
  const alerts: (CreatedAlert & { metadata?: unknown })[] = [];
  let idSeq = 0;
  const prisma: AlertPersistPrisma = {
    alert: {
      create: async ({ data }) => {
        const created = { id: `alert${++idSeq}`, caseId: data.caseId as string, rule: data.rule as never, severity: data.severity as never, chain: data.chain as string, address: data.address as string, amount: (data.amount as string) ?? null, metadata: data.metadata } as CreatedAlert & { metadata?: unknown };
        alerts.push(created);
        return created;
      },
    },
  };
  const published: AlertEventEnvelope[] = [];
  const publish = vi.fn(async (e: AlertEventEnvelope) => {
    published.push(e);
  });
  return { prisma, alerts, published, publish };
}

function noopRuleCtx(): RuleContext {
  return { findVasp: vi.fn().mockResolvedValue(null), findObfuscation: vi.fn().mockResolvedValue(null) };
}

/** The repo-root fixtures/ dir (not the workers/ package cwd) -- same idiom as b8Golden.int.test.ts. */
const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));

describe('B0 replay gap: a recorded (checked-in, synthetic) TronGrid fixture, played through the REAL TronAdapter, reaches B8 rule evaluation and alert persistence', () => {
  it('DATA_MODE=replay against the repo\'s fixtures/trongrid (no network) -> real TronAdapter parsing -> A1 rule -> Alert -> alert.new', async () => {
    const env = { ...loadEnv({ DATA_MODE: 'replay' }), FIXTURES_DIR: fixturesDir };
    const layer = createChainLayer({ env, guard: { unlimited: true } });

    // Real adapter, real (checked-in) fixture, real pagination -- the exact call shape B3's own
    // smoke/seed script uses, which is what the checked-in fixture set was recorded against.
    const { items } = await collectTransfers(layer.adapter('TRON'), DEMO.tronBusy, 'out', {});
    expect(items).toHaveLength(DEMO.tronBusyTotal);
    expect(items.every((t) => t.from === DEMO.tronBusy)) .toBe(true);

    const sys = fakeAlertPrisma();
    const ruleCtx = noopRuleCtx();
    // Same low-threshold override pollDueTronAddresses would apply via its own `config` param -- the
    // demo dataset's transfers top out well under the production defaults (config.ts), so this proves
    // the rule engine really does fire against real (replayed) transfer data without fabricating one.
    const config = { a1Movement: { mediumUsd: 1, highUsd: 500 } };
    let alertsCreated = 0;
    for (const t of items) {
      const findings = await evaluateTransferRules({ chain: 'TRON', addr: t.from, direction: 'out', counterparty: t.to, txHash: t.txHash, token: t.token, amount: t.amount, usd: t.usd ?? null, ts: t.ts }, { ...ruleCtx, config });
      for (const f of findings) {
        await persistAndPublishAlert({ prisma: sys.prisma, publish: sys.publish }, { caseId: 'case1', rule: f.rule, severity: f.severity, chain: 'TRON', address: t.from, amount: t.amount, message: f.message, metadata: f.metadata });
        alertsCreated++;
      }
    }

    expect(alertsCreated).toBeGreaterThan(0);
    expect(sys.alerts.every((a) => a.rule === 'A1_MOVEMENT')).toBe(true);
    expect(sys.alerts[0].address).toBe(DEMO.tronBusy);
    expect(sys.published).toHaveLength(sys.alerts.length);
    expect(sys.published[0].event).toBe('alert.new');
  });
});
