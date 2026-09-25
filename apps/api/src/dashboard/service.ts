import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

/** Calendar days for tracesPerDay are IST (Asia/Kolkata, UTC+5:30, no DST), the same zone the B9 evidence report uses. */
export const DASHBOARD_TIME_ZONE = 'Asia/Kolkata';

const count = z.number().int().nonnegative();

/** Response contract. Parsing every response through it guarantees integers, finite numbers and no leaked DB objects. */
export const dashboardSummarySchema = z
  .object({
    openCases: count,
    tracesPerDay: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count }).strict()),
    tracedValueUsd: z.number().finite().nonnegative(),
    vaspsIdentified: count,
    typologyMix: z.array(z.object({ typology: z.string().min(1), count }).strict()),
    timeToAttributionMedianSeconds: z.number().finite().nonnegative().nullable(),
    chainSplit: z.array(z.object({ chain: z.string().min(1), count }).strict()),
  })
  .strict();
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

/**
 * Read-only aggregates for the F3 command dashboard. Six SELECT statements run in one read transaction (one snapshot);
 * nothing is written, no per-case audit entry is recorded, and neither the ML service nor any provider is called.
 */
export class DashboardService {
  constructor(private readonly deps: { prisma: PrismaClient }) {}

  async summary(): Promise<DashboardSummary> {
    const { prisma } = this.deps;
    const [openCases, perDay, tracedValue, vasps, typologies, chains] = await prisma.$transaction([
      // Case.status is the CaseStatus enum (OPEN | TRACING | ATTRIBUTED | CLOSED): open = anything but CLOSED.
      prisma.case.count({ where: { status: { not: 'CLOSED' } } }),
      // TraceJob.createdAt is timestamptz; AT TIME ZONE converts to IST wall-clock before taking the date.
      prisma.$queryRaw<{ day: string; count: number }[]>`
        SELECT to_char(("createdAt" AT TIME ZONE ${DASHBOARD_TIME_ZONE})::date, 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM "TraceJob" GROUP BY 1 ORDER BY 1 ASC`,
      // Hop is unique per (traceId, txHash, from, to), so the same on-chain transfer seen by two traces is stored twice.
      // Count each transfer once (Neo4j's TRANSFER key: chain + txHash + idx + from + to). Hop.usd is nullable; SUM skips nulls.
      prisma.$queryRaw<{ total: number | null }[]>`
        SELECT round(sum(usd), 2)::float8 AS total FROM (
          SELECT DISTINCT ON (chain, "txHash", idx, "fromAddr", "toAddr") usd
          FROM "Hop" ORDER BY chain, "txHash", idx, "fromAddr", "toAddr", ts) t`,
      // Attribution has one row per (chain, addr, vaspId): many addresses can point at one VASP, so count distinct vaspId.
      prisma.$queryRaw<{ n: number }[]>`SELECT count(DISTINCT "vaspId")::int AS n FROM "Attribution"`,
      // RiskScore is append-only (one row per scoring run). Take each address's latest score so re-scoring
      // does not inflate a typology, then group; null / empty typologies are ignored.
      prisma.$queryRaw<{ typology: string; count: number }[]>`
        SELECT typology, count(*)::int AS count FROM (
          SELECT DISTINCT ON (chain, addr) typology FROM "RiskScore" ORDER BY chain, addr, "createdAt" DESC, id DESC) latest
        WHERE typology IS NOT NULL AND btrim(typology) <> ''
        GROUP BY typology ORDER BY count DESC, typology ASC`,
      // Suspect wallet addresses from complaints (not tx hashes) whose chain intake resolved; distinct per chain.
      prisma.$queryRaw<{ chain: string; count: number }[]>`
        SELECT chain, count(DISTINCT address)::int AS count FROM "ComplaintAddress"
        WHERE kind = 'ADDRESS' AND chain IS NOT NULL GROUP BY chain ORDER BY count DESC, chain ASC`,
    ]);

    return dashboardSummarySchema.parse({
      openCases,
      tracesPerDay: perDay.map((r) => ({ day: r.day, count: Number(r.count) })),
      tracedValueUsd: Number(tracedValue[0]?.total ?? 0),
      vaspsIdentified: Number(vasps[0]?.n ?? 0),
      typologyMix: typologies.map((r) => ({ typology: r.typology, count: Number(r.count) })),
      // Not defined: Attribution is keyed by (chain, addr, vaspId) and has no case link, and "complaint submitted" could be
      // Complaint.reportedAt or createdAt. Returning null is deliberate rather than an arbitrary timestamp subtraction.
      timeToAttributionMedianSeconds: null,
      chainSplit: chains.map((r) => ({ chain: r.chain, count: Number(r.count) })),
    });
  }
}
