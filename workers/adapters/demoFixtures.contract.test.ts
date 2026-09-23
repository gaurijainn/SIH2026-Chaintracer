import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEMO_CASES, DEMO_CASE_NOW, DEMO_T0, demoTransfers, loadEnv } from '@ps26183/shared';
import { collectTransfers, createChainLayer } from './index';
import { demoCaseTransport } from './demoCaseTransport';

const fixturesDir = fileURLToPath(new URL('../../fixtures', import.meta.url));
const replay = () => createChainLayer({ env: { ...loadEnv({ DATA_MODE: 'replay' }), FIXTURES_DIR: fixturesDir }, now: () => DEMO_CASE_NOW });
const pick = (t: { txHash: string; from: string; to: string; amount: string; usd?: number; ts: number; token: string }) => ({ txHash: t.txHash, from: t.from, to: t.to, amount: t.amount, usd: t.usd, ts: t.ts, token: t.token });

/**
 * Adapter contract test against RECORDED fixtures: the TRON adapter reading the demo-case fixtures in DATA_MODE=replay
 * must yield exactly the normalised transfers the cases define -- so a change to the adapter's request shape or parsing
 * (which would orphan or misread the recordings) fails here, offline, without any provider call.
 */
describe('TRON adapter contract against the recorded demo-case fixtures (DATA_MODE=replay)', () => {
  for (const c of DEMO_CASES) {
    it(`${c.key}: the engine's and attribution's reads replay the recorded transfers exactly`, async () => {
      const layer = replay();
      const all = demoTransfers(c);
      // the reads the trace engine (seed, windowed from the incident start) and attribution (deposit, full history) make
      for (const [addr, dir, since] of [[c.seed, 'out', DEMO_T0], [c.vasp.deposit, 'in', undefined], [c.vasp.deposit, 'out', undefined]] as const) {
        const got = (await collectTransfers(layer.tron, addr, dir, since === undefined ? {} : { since })).items.map(pick).sort((a, b) => a.ts - b.ts);
        const want = all.filter((t) => (dir === 'out' ? t.from === addr : t.to === addr)).map(pick).sort((a, b) => a.ts - b.ts);
        expect(got, `${addr} ${dir}`).toEqual(want);
      }
    });
  }

  it('the replay layer never reaches for the network: an unrecorded request fails instead of being fetched', async () => {
    const layer = replay();
    await expect(layer.tron.getTransfers('TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'in')).rejects.toThrow();
  });

  it('the recordings are exactly what the simulator + adapter produce today (no drift between script and fixtures)', async () => {
    // Re-derive one case's history from the simulated provider through the live adapter path and compare with replay.
    const live = createChainLayer({ env: { ...loadEnv({ DATA_MODE: 'live', TRONGRID_KEY: 'k' }), FIXTURES_DIR: 'unused' }, transport: demoCaseTransport(), guard: { unlimited: true, sleep: async () => undefined, random: () => 0 }, now: () => DEMO_CASE_NOW });
    const c = DEMO_CASES[0];
    const fromSim = (await collectTransfers(live.tron, c.vasp.deposit, 'in')).items.map(pick).sort((a, b) => a.ts - b.ts);
    const fromFixtures = (await collectTransfers(replay().tron, c.vasp.deposit, 'in')).items.map(pick).sort((a, b) => a.ts - b.ts);
    expect(fromFixtures).toEqual(fromSim);
  });
});
