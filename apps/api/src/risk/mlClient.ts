import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';
import { MlHttpError, MlResponseError, MlTimeoutError, MlUnavailableError } from './errors';

/** Raw (snake_case) B7 Appendix-B feature vector, exactly `services/ml/app/features/schema.py`'s FeatureVector. */
export interface RawFeatureVector {
  dwell_median_min: number | null;
  fan_out_1h: number;
  fan_in_unique: number;
  passthrough_ratio: number | null;
  age_at_taint_days: number | null;
  activator_label: string | null;
  trx_dust_usdt: boolean;
  round_amount_ratio: number;
  burst_tx_per_hour: number;
  hops_from_victim: number | null;
  hops_to_vasp: number | null;
  sanction_exposure: number | null;
  external_flags: string[];
  shared_mule_cps: number;
  cross_case_count: number;
}

export interface ScoreRequestAddress {
  chain: 'TRON';
  addr: string;
  features: RawFeatureVector;
  /** `undefined` means "unknown" -- only an explicit `true` fires a hard override on the ML side. */
  sanctioned?: boolean;
  stablecoinBlacklisted?: boolean;
}

export interface ScoreFactor {
  feature: string;
  impact: number;
  reason: string;
}

export type RiskBandString = 'Low' | 'Medium' | 'High' | 'Critical';

export interface AddressScoreResponse {
  addr: string;
  score: number;
  band: RiskBandString;
  factors: ScoreFactor[];
  overrides: string[];
  modelVersion: string;
  mlProbability: number;
  ruleScore: number;
  explanationStatus: string;
  datasetVersion: string;
}

export interface TypologyRequestBody {
  caseFeatures?: Record<string, boolean | undefined>;
  complaintCategory?: string | null;
}

export interface TypologyResponse {
  label: string;
  confidence: number;
  signals: string[];
}

export interface MlClient {
  score(addresses: ScoreRequestAddress[]): Promise<AddressScoreResponse[]>;
  typology(body: TypologyRequestBody): Promise<TypologyResponse>;
}

// --- runtime response validation (the ML service is a different codebase/language; never trust its JSON blindly) ---

const scoreFactorSchema = z.object({ feature: z.string(), impact: z.number(), reason: z.string() });
const addressScoreResponseSchema = z.object({
  addr: z.string(),
  score: z.number(),
  band: z.enum(['Low', 'Medium', 'High', 'Critical']),
  factors: z.array(scoreFactorSchema),
  overrides: z.array(z.string()),
  modelVersion: z.string(),
  mlProbability: z.number(),
  ruleScore: z.number(),
  explanationStatus: z.string(),
  datasetVersion: z.string(),
});
const scoreResponseSchema = z.array(addressScoreResponseSchema);
const typologyResponseSchema = z.object({ label: z.string(), confidence: z.number(), signals: z.array(z.string()) });

/**
 * 5s: /score does one XGBoost inference + SHAP explanation for a single address (sub-second in
 * practice per B7.5's own tests) and /typology is pure rule logic over a handful of booleans --
 * both are fast, synchronous, in-process calls on the Python side. 5s gives generous headroom for
 * cold starts/GC pauses without leaving an HTTP client (and the caller behind it) hanging indefinitely.
 */
const DEFAULT_TIMEOUT_MS = 5000;

/** Lightweight axios-with-timeout ML client (mirrors deps.ts's bare `axios.get(ML_URL/health)` style;
 * intentionally NOT the workers-package fixture/record-replay HTTP machinery, which is for chain
 * data providers, not this internal service-to-service call). */
export class HttpMlClient implements MlClient {
  private readonly http: AxiosInstance;

  constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.http = axios.create({ baseURL: baseUrl, timeout: timeoutMs });
  }

  async score(addresses: ScoreRequestAddress[]): Promise<AddressScoreResponse[]> {
    const data = await this.post('/score', { addresses });
    const parsed = scoreResponseSchema.safeParse(data);
    if (!parsed.success) throw new MlResponseError(`malformed /score response: ${parsed.error.message}`);
    return parsed.data;
  }

  async typology(body: TypologyRequestBody): Promise<TypologyResponse> {
    const data = await this.post('/typology', body);
    const parsed = typologyResponseSchema.safeParse(data);
    if (!parsed.success) throw new MlResponseError(`malformed /typology response: ${parsed.error.message}`);
    return parsed.data;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    try {
      const res = await this.http.post(path, body);
      return res.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        if (err.code === 'ECONNABORTED' || err.message.toLowerCase().includes('timeout')) {
          throw new MlTimeoutError(`ML service timed out calling ${path}`);
        }
        if (!err.response) {
          throw new MlUnavailableError(`ML service unreachable at ${path}: ${err.message}`);
        }
        throw new MlHttpError(err.response.status, `ML service returned ${err.response.status} for ${path}`);
      }
      throw err;
    }
  }
}
