import { describe, expect, it, vi } from 'vitest';
import { RiskPersistError, UnsupportedChainError } from './errors';
import type { MlClient, ScoreFactor } from './mlClient';
import { RiskService, type RiskServicePrisma } from './service';

function makePrisma(overrides: Partial<RiskServicePrisma> = {}): RiskServicePrisma {
  const create = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'risk-1',
    chain: data.chain,
    addr: data.addr,
    score: data.score,
    band: data.band,
    modelVersion: data.modelVersion,
    traceId: data.traceId ?? null,
    createdAt: new Date('2026-09-23T00:00:00Z'),
  }));
  return {
    traceJob: { findUnique: vi.fn().mockResolvedValue(null) },
    hop: { findMany: vi.fn().mockResolvedValue([]) },
    addressProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    label: { findMany: vi.fn().mockResolvedValue([]) },
    muleFlag: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    complaint: { findFirst: vi.fn().mockResolvedValue(null) },
    riskScore: { create },
    ...overrides,
  } as RiskServicePrisma;
}

const factors: ScoreFactor[] = [{ feature: 'fan_out_1h', impact: 0.31, reason: 'high fan-out within 1 hour' }];

function makeMlClient(overrides: Partial<MlClient> = {}): MlClient {
  return {
    score: vi.fn().mockResolvedValue([
      {
        addr: 'W1',
        score: 62,
        band: 'High',
        factors,
        overrides: ['STABLECOIN_BLACKLIST'],
        modelVersion: 'tron-xgb-v1',
        mlProbability: 0.61,
        ruleScore: 55,
        explanationStatus: 'ok',
        datasetVersion: 'tron-bootstrap-v1',
      },
    ]),
    typology: vi.fn().mockResolvedValue({ label: 'pig_butchering', confidence: 0.72, signals: ['escalating deposits'] }),
    ...overrides,
  };
}

describe('RiskService.getAddressRisk', () => {
  it('rejects unsupported chains before touching prisma or the ML client', async () => {
    const prisma = makePrisma();
    const mlClient = makeMlClient();
    const service = new RiskService({ prisma, mlClient });

    await expect(service.getAddressRisk('ETH', 'W1')).rejects.toBeInstanceOf(UnsupportedChainError);
    expect(mlClient.score).not.toHaveBeenCalled();
    expect(prisma.riskScore.create).not.toHaveBeenCalled();
  });

  it('happy path: scores, persists via create (never upsert), and returns the mapped result', async () => {
    const prisma = makePrisma();
    const mlClient = makeMlClient();
    const service = new RiskService({ prisma, mlClient });

    const result = await service.getAddressRisk('TRON', 'W1');

    expect(result.score).toBe(62);
    expect(result.band).toBe('HIGH');
    expect(result.factors).toEqual(factors);
    expect(result.overrides).toEqual(['STABLECOIN_BLACKLIST']);
    expect(result.typology).toBe('pig_butchering');
    expect(result.typologyConfidence).toBe(0.72);
    expect(result.modelVersion).toBe('tron-xgb-v1');
    expect(result.traceId).toBeNull();

    expect(prisma.riskScore.create).toHaveBeenCalledTimes(1);
    const createArgs = (prisma.riskScore.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      chain: 'TRON',
      addr: 'W1',
      score: 62,
      band: 'HIGH',
      overrides: ['STABLECOIN_BLACKLIST'],
      typology: 'pig_butchering',
      modelVersion: 'tron-xgb-v1',
      traceId: null,
    });
    expect(createArgs.data.factors).toEqual(factors);
  });

  it('calling twice creates two separate RiskScore rows (append-only, no dedup/upsert)', async () => {
    const prisma = makePrisma();
    const mlClient = makeMlClient();
    const service = new RiskService({ prisma, mlClient });

    await service.getAddressRisk('TRON', 'W1');
    await service.getAddressRisk('TRON', 'W1');

    expect(prisma.riskScore.create).toHaveBeenCalledTimes(2);
  });

  it('propagates ML score errors without persisting anything', async () => {
    const prisma = makePrisma();
    const mlClient = makeMlClient({ score: vi.fn().mockRejectedValue(new Error('boom')) });
    const service = new RiskService({ prisma, mlClient });

    await expect(service.getAddressRisk('TRON', 'W1')).rejects.toThrow('boom');
    expect(prisma.riskScore.create).not.toHaveBeenCalled();
  });

  it('a typology failure does not block the risk score: typology fields are null, score is still persisted', async () => {
    const prisma = makePrisma();
    const mlClient = makeMlClient({ typology: vi.fn().mockRejectedValue(new Error('typology down')) });
    const service = new RiskService({ prisma, mlClient });

    const result = await service.getAddressRisk('TRON', 'W1');

    expect(result.typology).toBeNull();
    expect(result.typologyConfidence).toBeNull();
    expect(result.score).toBe(62);
    expect(prisma.riskScore.create).toHaveBeenCalledTimes(1);
  });

  it('wraps a Prisma persistence failure as RiskPersistError', async () => {
    const prisma = makePrisma({ riskScore: { create: vi.fn().mockRejectedValue(new Error('db down')) } });
    const mlClient = makeMlClient();
    const service = new RiskService({ prisma, mlClient });

    await expect(service.getAddressRisk('TRON', 'W1')).rejects.toBeInstanceOf(RiskPersistError);
  });
});
