import { PROVIDERS, type DataMode, type ProviderDef } from '@ps26183/shared';

export type CheckStatus = 'ok' | 'down' | 'unconfigured';
export interface CheckResult {
  status: CheckStatus;
  latencyMs: number;
  detail?: string;
}

export interface HealthDeps {
  mode: DataMode;
  core: Record<'postgres' | 'neo4j' | 'redis' | 'ml' | 'workers', () => Promise<string | void>>;
  /** Performs the provider's probe request (through the record/replay client). */
  probeProvider: (p: ProviderDef) => Promise<void>;
  hasKey: (p: ProviderDef) => boolean;
  /** Live-mode provider results are cached so /health polling cannot burn free-tier quota. */
  providerCacheMs?: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  mode: DataMode;
  checkedAt: string;
  checks: Record<string, CheckResult>;
  providers: Record<string, CheckResult>;
}

async function timed(fn: () => Promise<string | void>): Promise<CheckResult> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    return { status: 'ok', latencyMs: Math.round(performance.now() - t0), ...(detail ? { detail } : {}) };
  } catch (e) {
    return { status: 'down', latencyMs: Math.round(performance.now() - t0), detail: e instanceof Error ? e.message : String(e) };
  }
}

const providerCache = new WeakMap<HealthDeps, Map<string, { at: number; result: CheckResult }>>();

async function checkProvider(deps: HealthDeps, p: ProviderDef): Promise<CheckResult> {
  if (deps.mode !== 'replay' && p.keyEnv && !p.keyOptional && !deps.hasKey(p)) {
    return { status: 'unconfigured', latencyMs: 0, detail: `${p.keyEnv} not set` };
  }
  const ttl = deps.mode === 'replay' ? 0 : (deps.providerCacheMs ?? 60_000);
  let cache = providerCache.get(deps);
  if (!cache) providerCache.set(deps, (cache = new Map()));
  const hit = cache.get(p.id);
  if (ttl && hit && Date.now() - hit.at < ttl) return hit.result;
  const result = await timed(async () => {
    await deps.probeProvider(p);
    return deps.mode === 'replay' ? 'replay fixture' : undefined;
  });
  if (ttl) cache.set(p.id, { at: Date.now(), result });
  return result;
}

export async function runHealth(deps: HealthDeps): Promise<HealthReport> {
  const coreNames = Object.keys(deps.core) as (keyof HealthDeps['core'])[];
  const [coreRes, provRes] = await Promise.all([
    Promise.all(coreNames.map((n) => timed(deps.core[n]))),
    Promise.all(PROVIDERS.map((p) => checkProvider(deps, p))),
  ]);
  const checks = Object.fromEntries(coreNames.map((n, i) => [n, coreRes[i]]));
  const providers = Object.fromEntries(PROVIDERS.map((p, i) => [p.id, provRes[i]]));

  const coreDown = coreRes.some((r) => r.status !== 'ok');
  const provBad = provRes.some((r) => r.status !== 'ok');
  return {
    status: coreDown ? 'down' : provBad ? 'degraded' : 'ok',
    mode: deps.mode,
    checkedAt: new Date().toISOString(),
    checks,
    providers,
  };
}
