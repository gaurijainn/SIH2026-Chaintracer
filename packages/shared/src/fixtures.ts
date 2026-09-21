import axios, { AxiosError, type AxiosAdapter, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DataMode } from './constants';

export interface FixtureFile {
  provider: string;
  request: { method: string; url: string; body?: string };
  response: { status: number; data: unknown };
  recordedAt: string;
  /** true for hand-written seed fixtures that were not captured from a live provider */
  synthetic?: boolean;
}

export class ReplayMissError extends Error {
  constructor(public provider: string, public file: string, public url: string) {
    super(`replay fixture missing for ${provider}: ${url} (expected ${file})`);
    this.name = 'ReplayMissError';
  }
}

/** fixtures/<provider>/<sha1(url)>.json — GET hashes the URL; other methods also hash method + body. */
export function fixtureKey(method: string, url: string, body?: string): string {
  const m = method.toUpperCase();
  const material = m === 'GET' ? url : `${m} ${url} ${body ?? ''}`;
  return createHash('sha1').update(material).digest('hex');
}

export function fixturePath(dir: string, provider: string, key: string): string {
  return path.join(dir, provider, `${key}.json`);
}

/** Replace `{NAME}` tokens with real secrets. Called only right before a live network request. */
export function substituteTokens(input: string, secrets: Record<string, string>): string {
  return input.replace(/\{([A-Z0-9_]+)\}/g, (whole, name: string) => secrets[name] ?? whole);
}

export function buildSecrets(env: object): Record<string, string> {
  const s: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') s[k] = v;
  const cb = s.CHAINABUSE_KEY;
  if (cb) s.CHAINABUSE_BASIC = Buffer.from(`${cb}:${cb}`).toString('base64');
  return s;
}

export interface HttpOptions {
  provider: string;
  mode: DataMode;
  fixturesDir: string;
  secrets?: Record<string, string>;
  timeoutMs?: number;
  /** Underlying transport; defaults to axios' node http adapter. Injectable for tests. */
  transport?: AxiosAdapter;
}

/**
 * axios instance that records or replays every external response.
 *  - replay: served purely from disk, never touches the network
 *  - record: real call, response saved to fixtures/
 *  - live:   real call, nothing saved
 */
export function createHttp(opts: HttpOptions): AxiosInstance {
  const { provider, mode, fixturesDir, secrets = {} } = opts;

  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const method = (config.method ?? 'get').toUpperCase();
    const url = axios.getUri(config);
    const body = typeof config.data === 'string' ? config.data : undefined;
    const file = fixturePath(fixturesDir, provider, fixtureKey(method, url, body));

    if (mode === 'replay') {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        throw new ReplayMissError(provider, file, url);
      }
      const fx = JSON.parse(raw) as FixtureFile;
      const response = { data: fx.response.data, status: fx.response.status, statusText: 'OK', headers: {}, config, request: {} };
      const ok = config.validateStatus ? config.validateStatus(response.status) : response.status < 300;
      if (!ok) throw new AxiosError(`Request failed with status code ${response.status}`, String(response.status), config, {}, response);
      return response;
    }

    const transport = opts.transport ?? axios.getAdapter('http');
    const live = {
      ...config,
      url: config.url ? substituteTokens(config.url, secrets) : config.url,
      baseURL: config.baseURL ? substituteTokens(config.baseURL, secrets) : config.baseURL,
      data: typeof config.data === 'string' ? substituteTokens(config.data, secrets) : config.data,
    } as InternalAxiosRequestConfig;
    for (const h of Object.keys(config.headers ?? {})) {
      const v = config.headers.get(h);
      if (typeof v === 'string') live.headers.set(h, substituteTokens(v, secrets));
    }
    const res = await transport(live);

    if (mode === 'record' && res.status >= 200 && res.status < 300) {
      const fx: FixtureFile = {
        provider,
        request: { method, url, body },
        response: { status: res.status, data: res.data },
        recordedAt: new Date().toISOString(),
      };
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(fx, null, 2));
    }
    return res;
  };

  return axios.create({ adapter, timeout: opts.timeoutMs ?? 8000 });
}
