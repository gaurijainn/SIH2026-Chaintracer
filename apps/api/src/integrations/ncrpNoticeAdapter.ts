import { buildSecrets, createHttp, type Env } from '@ps26183/shared';
import type { IntegrationAdapter } from './types';

/**
 * Outbound NCRP notice/sync adapter: `POST /integrations/ncrp/sync`. This is a different concern
 * from apps/api/src/intake/ncrp.ts (inbound complaint feed polling) -- that file is untouched. Same
 * createHttp+DATA_MODE convention, same NCRP_BASE_URL the intake feed already uses (a single mock
 * server backs both concerns' contracts; see mocks/openapi/ncrp-notice.yaml).
 */
export interface NcrpSyncResult {
  syncId: string;
  mode: 'sandbox';
  sandbox: true;
}

export const ncrpSyncUrl = () => `{NCRP_BASE_URL}/ncrp/v1/notices/sync`;

export function createNcrpNoticeAdapter(env: Pick<Env, 'DATA_MODE' | 'FIXTURES_DIR'> & Record<string, unknown>): IntegrationAdapter<Record<string, unknown>, NcrpSyncResult> {
  const http = createHttp({ provider: 'ncrp-notice', mode: env.DATA_MODE, fixturesDir: env.FIXTURES_DIR, secrets: buildSecrets(env), timeoutMs: 8000 });
  return {
    async submit(payload) {
      const { data } = await http.post(ncrpSyncUrl(), { notice: payload });
      if (!data || typeof data.syncId !== 'string') throw new Error('NCRP sync: unexpected response shape');
      return { syncId: data.syncId, mode: 'sandbox', sandbox: true };
    },
  };
}
