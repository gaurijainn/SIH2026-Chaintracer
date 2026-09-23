import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVIDERS, buildSecrets, createHttp, loadEnv } from '@ps26183/shared';
import { createApp } from './app';
import type { HealthDeps, HealthReport } from './health';
import { testSecurity } from './auth/testkit';

const ok = async () => undefined;
const fixturesDir = fileURLToPath(new URL('../../../fixtures', import.meta.url));

function makeDeps(over: Partial<HealthDeps['core']> = {}, mode: HealthDeps['mode'] = 'replay'): HealthDeps {
  const secrets = buildSecrets(loadEnv({ DATA_MODE: mode }));
  return {
    mode,
    core: { postgres: ok, neo4j: ok, redis: ok, ml: ok, workers: ok, ...over },
    probeProvider: async (p) => {
      const { method, url, headers, data } = p.probe;
      await createHttp({ provider: p.id, mode: 'replay', fixturesDir, secrets }).request({ method, url, headers, data });
    },
    hasKey: () => false,
  };
}

async function get(deps: HealthDeps) {
  const server = createApp(deps, {}, testSecurity()).listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return { status: res.status, body: (await res.json()) as HealthReport };
  } finally {
    server.close();
  }
}

describe('/health', () => {
  it('is all green in replay mode with every provider served from fixtures', async () => {
    const { status, body } = await get(makeDeps());
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(Object.keys(body.providers)).toHaveLength(PROVIDERS.length);
    for (const r of Object.values<{ status: string }>(body.providers)) expect(r.status).toBe('ok');
    expect(Object.keys(body.checks).sort()).toEqual(['ml', 'neo4j', 'postgres', 'redis', 'workers']);
  });

  it('returns 503 when a core service is down', async () => {
    const { status, body } = await get(
      makeDeps({ neo4j: async () => { throw new Error('boom'); } }),
    );
    expect(status).toBe(503);
    expect(body.status).toBe('down');
    expect(body.checks.neo4j).toMatchObject({ status: 'down', detail: 'boom' });
  });

  it('reports missing provider keys as unconfigured (degraded) in live mode', async () => {
    const { status, body } = await get(makeDeps({}, 'live'));
    expect(status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.providers.trongrid.status).toBe('unconfigured');
  });
});
