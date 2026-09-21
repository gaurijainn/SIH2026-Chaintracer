import axios from 'axios';
import neo4j from 'neo4j-driver';
import pg from 'pg';
import { Redis } from 'ioredis';
import {
  WORKER_HEARTBEAT_KEY,
  buildSecrets,
  createHttp,
  type Env,
  type ProviderDef,
} from '@ps26183/shared';
import type { HealthDeps } from './health';

export function buildDeps(env: Env): { deps: HealthDeps; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2, connectionTimeoutMillis: 3000 });
  const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD), {
    connectionTimeout: 3000,
  });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });
  redis.on('error', () => undefined); // surfaced through the health check, not as an unhandled event

  const secrets = buildSecrets(env);
  const clients = new Map<string, ReturnType<typeof createHttp>>();
  const http = (id: string) => {
    let c = clients.get(id);
    if (!c) clients.set(id, (c = createHttp({ provider: id, mode: env.DATA_MODE, fixturesDir: env.FIXTURES_DIR, secrets })));
    return c;
  };

  const deps: HealthDeps = {
    mode: env.DATA_MODE,
    core: {
      postgres: async () => {
        await pool.query('SELECT 1');
      },
      neo4j: async () => {
        await driver.verifyConnectivity();
        const s = driver.session();
        try {
          await s.run('RETURN 1');
        } finally {
          await s.close();
        }
      },
      redis: async () => {
        if (redis.status === 'wait') await redis.connect();
        if ((await redis.ping()) !== 'PONG') throw new Error('bad PING reply');
      },
      ml: async () => {
        const r = await axios.get(`${env.ML_URL}/health`, { timeout: 3000 });
        return `model ${r.data?.modelVersion ?? 'n/a'}`;
      },
      workers: async () => {
        if (redis.status === 'wait') await redis.connect();
        const hb = await redis.get(WORKER_HEARTBEAT_KEY);
        if (!hb) throw new Error('no worker heartbeat');
      },
    },
    probeProvider: async (p: ProviderDef) => {
      const { method, url, headers, data } = p.probe;
      await http(p.id).request({ method, url, headers, data });
    },
    hasKey: (p) => Boolean(p.keyEnv && secrets[p.keyEnv]),
  };

  return {
    deps,
    close: async () => {
      await pool.end().catch(() => undefined);
      await driver.close().catch(() => undefined);
      redis.disconnect();
    },
  };
}
