import { buildSecrets, createHttp, type Env } from '@ps26183/shared';
import type { IntegrationAdapter } from './types';

/**
 * SAHYOG freeze-notice submission adapter. Mirrors apps/api/src/intake/ncrp.ts's
 * createHttp+DATA_MODE+env-templated-URL convention with a new provider id ('sahyog'). There is no
 * real SAHYOG endpoint to call -- this always talks to the sandbox mock server described by
 * mocks/openapi/sahyog.yaml (mocks/mock-server/src/app.ts), whatever DATA_MODE/SAHYOG_MODE say;
 * SAHYOG_MODE only changes the `mode` field surfaced in the response so the UI can distinguish
 * sandbox from a hypothetical future real submission.
 */
export interface SahyogSubmitResult {
  submissionId: string;
  mode: 'sandbox';
  sandbox: true;
}

export const sahyogSubmitUrl = () => `{SAHYOG_BASE_URL}/sahyog/v1/submissions`;

export function createSahyogAdapter(env: Pick<Env, 'DATA_MODE' | 'FIXTURES_DIR' | 'SAHYOG_MODE'> & Record<string, unknown>, timeoutMs = 8000): IntegrationAdapter<Record<string, unknown>, SahyogSubmitResult> {
  const http = createHttp({ provider: 'sahyog', mode: env.DATA_MODE, fixturesDir: env.FIXTURES_DIR, secrets: buildSecrets(env), timeoutMs });
  return {
    async submit(payload) {
      const { data } = await http.post(sahyogSubmitUrl(), { notice: payload });
      if (!data || typeof data.submissionId !== 'string') throw new Error('SAHYOG submit: unexpected response shape');
      return { submissionId: data.submissionId, mode: 'sandbox', sandbox: true };
    },
  };
}
