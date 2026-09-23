import type { Chain } from '@ps26183/shared';
import type { Prisma, RiskBand } from '@prisma/client';
import { assembleAddressFeatures, type FeatureAssemblyPrisma } from './featureAssembly';
import { mapBand, toRawFeatureVector } from './mapping';
import type { MlClient, ScoreFactor } from './mlClient';
import { MlResponseError, RiskPersistError, UnsupportedChainError } from './errors';

/** The exact subset of PrismaClient the risk service needs, beyond `FeatureAssemblyPrisma`. */
export interface RiskServicePrisma extends FeatureAssemblyPrisma {
  riskScore: {
    create(args: { data: Record<string, unknown> }): Promise<{
      id: string;
      chain: string;
      addr: string;
      score: number;
      band: RiskBand;
      modelVersion: string;
      traceId: string | null;
      createdAt: Date;
    }>;
  };
}

export interface RiskServiceDeps {
  prisma: RiskServicePrisma;
  mlClient: MlClient;
}

export interface AddressRiskResult {
  id: string;
  chain: string;
  addr: string;
  score: number;
  band: RiskBand;
  factors: ScoreFactor[];
  overrides: string[];
  typology: string | null;
  typologyConfidence: number | null;
  modelVersion: string;
  traceId: string | null;
  createdAt: Date;
}

/** Only TRON has a trained v1 model (services/ml/app/inference/schemas.py: `chain: Literal["TRON"]`). */
const SUPPORTED_CHAINS: readonly Chain[] = ['TRON'];

/**
 * B7.6 orchestrator for `GET /addresses/:chain/:addr/risk`: assembles the 15 B6 features for one
 * live address (optionally scoped by `traceId`) -> looks up sanction/blacklist evidence -> calls the
 * real B7.5 ML service's `POST /score` (single-element batch) -> best-effort `POST /typology` ->
 * maps the response onto the Prisma `RiskBand` enum -> persists an append-only `RiskScore` row
 * (`create`, never `upsert` -- this table has no unique constraint by design) -> returns the result.
 */
export class RiskService {
  constructor(private readonly deps: RiskServiceDeps) {}

  async getAddressRisk(chain: Chain, addr: string, traceId?: string): Promise<AddressRiskResult> {
    if (!SUPPORTED_CHAINS.includes(chain)) throw new UnsupportedChainError(chain);

    const assembled = await assembleAddressFeatures(this.deps, chain, addr, traceId);
    const rawFeatures = toRawFeatureVector(assembled.features);

    const scored = await this.deps.mlClient.score([
      {
        chain: 'TRON',
        addr,
        features: rawFeatures,
        sanctioned: assembled.evidence.sanctioned,
        stablecoinBlacklisted: assembled.evidence.stablecoinBlacklisted,
      },
    ]);
    const result = scored[0];
    if (!result) throw new MlResponseError('ML /score returned an empty array for a single-address request');

    // Typology is a secondary signal for this route (the PDF's "Score, band, SHAP reasons, typology"
    // contract still expects it on the same response, but a typology-service hiccup should never
    // block the risk score itself, which is the primary and time-sensitive result).
    let typology: string | null = null;
    let typologyConfidence: number | null = null;
    try {
      const typologyResult = await this.deps.mlClient.typology({
        caseFeatures: assembled.typologyContext.caseFeatures,
        complaintCategory: assembled.typologyContext.complaintCategory,
      });
      typology = typologyResult.label;
      typologyConfidence = typologyResult.confidence;
    } catch {
      // leave typology/typologyConfidence null; the risk score itself is still valid and persisted.
    }

    const band = mapBand(result.band);

    let created;
    try {
      created = await this.deps.prisma.riskScore.create({
        data: {
          chain,
          addr,
          score: result.score,
          band,
          factors: result.factors as unknown as Prisma.InputJsonValue,
          overrides: result.overrides,
          typology,
          typologyConfidence: typologyConfidence == null ? null : typologyConfidence.toFixed(3),
          modelVersion: result.modelVersion,
          traceId: traceId ?? null,
        },
      });
    } catch (err) {
      throw new RiskPersistError('failed to persist RiskScore', { cause: err });
    }

    return {
      id: created.id,
      chain: created.chain,
      addr: created.addr,
      score: created.score,
      band: created.band,
      factors: result.factors,
      overrides: result.overrides,
      typology,
      typologyConfidence,
      modelVersion: created.modelVersion,
      traceId: created.traceId,
      createdAt: created.createdAt,
    };
  }
}
