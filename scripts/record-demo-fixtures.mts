/**
 * B11 replay fixtures for the golden + backup demo cases. Runs the REAL trace engine over the REAL provider layer in
 * record mode against the simulated providers in workers/adapters/demoCaseTransport.ts, so the shipped fixtures are
 * exactly the requests the engine makes (same URLs, same sha1 file names) and are flagged `synthetic: true`.
 * Idempotent; re-running rewrites identical files. No network access and no API keys are used.
 */
import { DEMO_CASES, DEMO_CASE_NOW, DEMO_T0, USDT_TRC20, loadEnv } from '../packages/shared/src/index.ts';
import { collectTransfers, createChainLayer } from '../workers/adapters/index.ts';
import { demoCaseTransport } from '../workers/adapters/demoCaseTransport.ts';
import { runTrace, type HopCreateInput, type TraceJobRow, type TracePrisma } from '../workers/trace/engine.ts';

const dir = process.env.FIXTURES_DIR ?? 'fixtures';
const layer = createChainLayer({
  env: { ...loadEnv({ DATA_MODE: 'record', TRONGRID_KEY: 'synthetic' }), FIXTURES_DIR: dir },
  transport: demoCaseTransport(),
  synthetic: true,
  now: () => DEMO_CASE_NOW,
  guard: { unlimited: true },
});

let total = 0;
for (const c of DEMO_CASES) {
  const hops: HopCreateInput[] = [];
  let state: TraceJobRow = { id: `rec-${c.key}`, caseId: c.key, seedChain: 'TRON', seedAddr: c.seed, status: 'QUEUED', taintModel: 'HAIRCUT', maxHops: 6, minValueUsd: 10, windowDays: 30, reportedAmount: null, createdAt: new Date(DEMO_T0) };
  const prisma: TracePrisma = {
    traceJob: {
      findUniqueOrThrow: async () => state,
      update: async ({ data }) => void (state = { ...state, ...(data as Partial<TraceJobRow>) }),
    },
    hop: { createMany: async ({ data }) => void hops.push(...data), count: async () => hops.length },
    // the exchange hot wallet is a labelled service, exactly as B5's registry load makes it in the demo stack
    label: { findFirst: async ({ where }) => (where.addr === c.vasp.hotWallet && where.category.in.includes('exchange') ? { category: 'exchange', name: c.vasp.name } : null) },
  };
  const res = await runTrace(state.id, { prisma, chainLayer: layer, writeGraphHops: async () => undefined, publish: async () => undefined, now: () => DEMO_CASE_NOW });
  // B5 attribution reads the deposit address's full in/out history through the same provider layer
  await collectTransfers(layer.tron, c.vasp.deposit, 'in');
  await collectTransfers(layer.tron, c.vasp.deposit, 'out');
  console.log(`${c.key}: ${hops.length} hops, terminals=${JSON.stringify(res.terminals.map((t) => t.reason))}`);
  total += hops.length;
}
void USDT_TRC20;
console.log(`recorded demo-case fixtures into ${dir} (${total} hops)`);
