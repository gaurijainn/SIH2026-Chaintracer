import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@ps26183/shared';

const apiDir = fileURLToPath(new URL('../../', import.meta.url));
const tempDb = `ps26183_mig_${Date.now()}`;
const base = new URL(loadEnv().DATABASE_URL);
const urlFor = (db: string) => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
};
const prisma = (args: string[], db: string) =>
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', ...args], {
    cwd: apiDir, env: { ...process.env, DATABASE_URL: urlFor(db) }, encoding: 'utf8', shell: process.platform === 'win32',
  });

const MODELS = ['User', 'Complaint', 'ComplaintAddress', 'Case', 'TraceJob', 'Hop', 'AddressProfile', 'Label', 'Vasp', 'VaspAddress', 'RiskScore', 'Alert', 'WatchlistItem', 'Report', 'FreezeNotice', 'AuditLog'];

let admin: pg.Client;
beforeAll(async () => {
  admin = new pg.Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${tempDb}`);
});
afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${tempDb} WITH (FORCE)`);
  await admin.end();
});

describe('migrations', () => {
  it('prisma validate passes', () => {
    expect(prisma(['validate'], tempDb)).toContain('is valid');
  });

  it('applies cleanly to an empty database and creates all 16 tables', async () => {
    expect(readdirSync(`${apiDir}prisma/migrations`).filter((d) => /^\d+_/.test(d)).length).toBeGreaterThanOrEqual(1);
    prisma(['migrate', 'deploy'], tempDb);
    const c = new pg.Client({ connectionString: urlFor(tempDb) });
    await c.connect();
    try {
      const { rows } = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
      const names = rows.map((r) => r.table_name);
      for (const m of MODELS) expect(names, m).toContain(m);
      const idx = await c.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'Hop'`);
      expect(idx.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(['Hop_traceId_txHash_fromAddr_toAddr_key', 'Hop_toAddr_idx']));
    } finally {
      await c.end();
    }
  });

  it('is re-runnable and the migrations match schema.prisma exactly (no drift)', () => {
    expect(prisma(['migrate', 'deploy'], tempDb)).toContain('No pending migrations');
    // exit code 0 = empty diff; a non-empty diff makes execFileSync throw
    prisma(['migrate', 'diff', '--from-url', urlFor(tempDb), '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], tempDb);
  });
});
