import type { AxiosAdapter, AxiosInstance } from 'axios';
import { buildSecrets, createHttp, type DataMode } from '@ps26183/shared';

export type HttpFactory = (provider: string) => AxiosInstance;

export interface ProviderHttpOptions {
  mode: DataMode;
  fixturesDir: string;
  /** env-like object; every string value becomes a {NAME} secret substituted only into live requests */
  env: object;
  transport?: AxiosAdapter;
  synthetic?: boolean;
  timeoutMs?: number;
}

/**
 * One record/replay-aware axios instance per provider (B0 fixture system). URLs and headers are written with
 * {KEY_NAME} tokens, so fixtures are keyed and stored without any secret.
 */
export function createProviderHttp(opts: ProviderHttpOptions): HttpFactory {
  const secrets = buildSecrets(opts.env);
  const clients = new Map<string, AxiosInstance>();
  return (provider) => {
    let c = clients.get(provider);
    if (!c) {
      c = createHttp({
        provider,
        mode: opts.mode,
        fixturesDir: opts.fixturesDir,
        secrets,
        transport: opts.transport,
        synthetic: opts.synthetic,
        timeoutMs: opts.timeoutMs ?? 10_000,
      });
      clients.set(provider, c);
    }
    return c;
  };
}
