import { type AxiosAdapter } from 'axios';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ReplayMissError, createHttp, fixtureKey, substituteTokens } from './fixtures';

const okTransport = (data: unknown) =>
  vi.fn(async (config) => ({ data, status: 200, statusText: 'OK', headers: {}, config, request: {} }));

describe('fixture recorder', () => {
  it('keys fixtures by sha1 and separates POST bodies', () => {
    expect(fixtureKey('GET', 'https://x.test/a')).toMatch(/^[0-9a-f]{40}$/);
    expect(fixtureKey('POST', 'https://x.test/a', '{"a":1}')).not.toBe(fixtureKey('POST', 'https://x.test/a', '{"a":2}'));
  });

  it('substitutes secrets only when present', () => {
    expect(substituteTokens('u?k={A}&z={B}', { A: '1' })).toBe('u?k=1&z={B}');
  });

  it('record then replay returns identical data with the network unreachable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fx-'));
    const transport = okTransport({ hello: 'world' });
    const rec = createHttp({
      provider: 'demo', mode: 'record', fixturesDir: dir, secrets: { KEY: 's3cret' },
      transport: transport as unknown as AxiosAdapter,
    });
    const live = await rec.get('https://api.test/v1/x?apikey={KEY}');
    expect(live.data).toEqual({ hello: 'world' });
    // the secret is injected for the real call but never persisted or hashed
    expect(transport.mock.calls[0][0].url).toContain('s3cret');
    const files = await readdir(path.join(dir, 'demo'));
    expect(files).toHaveLength(1);
    expect(await readFile(path.join(dir, 'demo', files[0]), 'utf8')).not.toContain('s3cret');

    const offline = vi.fn(async () => {
      throw new Error('network must not be used in replay');
    });
    const rep = createHttp({ provider: 'demo', mode: 'replay', fixturesDir: dir, transport: offline as unknown as AxiosAdapter });
    const replayed = await rep.get('https://api.test/v1/x?apikey={KEY}');
    expect(replayed.data).toEqual(live.data);
    expect(offline).not.toHaveBeenCalled();
  });

  it('replay of an unrecorded request fails loudly', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fx-'));
    const rep = createHttp({ provider: 'demo', mode: 'replay', fixturesDir: dir });
    await expect(rep.get('https://api.test/none')).rejects.toBeInstanceOf(ReplayMissError);
  });

  it('live mode does not write fixtures', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fx-'));
    const c = createHttp({ provider: 'demo', mode: 'live', fixturesDir: dir, transport: okTransport(1) as unknown as AxiosAdapter });
    await c.get('https://api.test/y');
    expect(await readdir(dir)).toHaveLength(0);
  });
});
