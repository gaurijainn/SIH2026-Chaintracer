import type { PrismaClient } from '@prisma/client';
import type { Driver } from 'neo4j-driver';
import type { DemoCase } from '@ps26183/shared';
import type { ChainLayer } from '@ps26183/workers/adapters';
import { upsertLabel } from '../attribution/labelStore';
import { upsertVasp } from '../attribution/vaspRegistry';
import type { AuditService } from '../audit/service';
import type { PiiCipher } from '../auth/pii';
import { createIntakeService } from '../intake/service';
import { LabelAdminService } from '../labels/service';
import { WatchlistService } from '../watchlist/service';
import { runDemoAttribution, runDemoMonitor, runDemoTrace } from './pipeline';

export interface SeedDemoDeps {
  prisma: PrismaClient;
  driver: Driver;
  audit: AuditService;
  pii?: PiiCipher;
  layer?: ChainLayer;
  /** the acting analyst recorded on the audited steps (an existing User id) */
  actorId: string;
}

export interface SeededDemoCase {
  caseId: string;
  traceId: string;
  hops: number;
  attributedVasp: string | null;
  alerts: { rule: string; severity: string }[];
}

/**
 * Materialises one demo case end to end in replay mode (no network): registry -> complaint -> trace -> attribution ->
 * analyst confirms the attribution as a label -> watchlist -> monitor pass (A2 CRITICAL VASP landing). Idempotent:
 * every step upserts or is skipped when already done, so re-running never duplicates rows or alerts.
 */
export async function seedDemoCase(deps: SeedDemoDeps, c: DemoCase): Promise<SeededDemoCase> {
  const { prisma } = deps;

  const vaspId = await upsertVasp(prisma as never, {
    name: c.vasp.name,
    type: c.vasp.type,
    jurisdiction: c.vasp.jurisdiction,
    fiuStatus: c.vasp.fiuStatus,
    fiuSource: 'synthetic demo data',
    contactEmail: 'legal@demo-exchange.invalid',
    hotWallets: [{ chain: 'TRON', addr: c.vasp.hotWallet, source: 'demo-fixture', confidence: 0.95 }],
  });
  // the registry's hot wallet is a labelled service: the trace stops there (B4 stop condition)
  await upsertLabel(prisma as never, { chain: 'TRON', addr: c.vasp.hotWallet, name: c.vasp.name, category: 'exchange', source: 'manual', confidence: 0.95, vaspId });

  const intake = createIntakeService({ prisma, queue: null, probe: null, defaults: { maxHops: 6, minValueUsd: 10, windowDays: 30, taintModel: 'HAIRCUT' }, pii: deps.pii });
  const { rows } = await intake.ingest([
    { row: 1, raw: { ackNo: c.ackNo, reportedAt: c.reportedAt, category: c.category, amountInr: c.amountInr, network: 'TRC20', addresses: [c.seed], firNumber: c.firNumber } },
  ]);
  const caseId = rows[0].caseId;
  if (!caseId) throw new Error(`demo complaint ${c.ackNo} was not accepted: ${JSON.stringify(rows[0])}`);
  await prisma.case.update({ where: { id: caseId }, data: { title: c.title } });
  const trace = await prisma.traceJob.findFirstOrThrow({ where: { caseId }, orderBy: { createdAt: 'asc' } });

  await runDemoTrace(deps, trace.id);
  const candidates = await runDemoAttribution(deps, c);

  // the analyst confirms the attribution (audited): the deposit address becomes an exchange-attributed label
  await new LabelAdminService({ prisma, audit: deps.audit }).upsertManual(
    { chain: 'TRON', addr: c.vasp.deposit, name: c.vasp.name, category: 'exchange', confidence: candidates[0]?.confidence ?? 0.9, vaspId, evidence: { basis: 'H1 deposit-sweep attribution confirmed by analyst', synthetic: true } },
    deps.actorId,
  );

  await new WatchlistService({ prisma }).create({ caseId, chain: 'TRON', addr: c.watch, reason: 'manual', tier: 'HOT', addedById: deps.actorId });
  await runDemoMonitor({ prisma }, [c]);

  const alerts = await prisma.alert.findMany({ where: { caseId }, orderBy: { createdAt: 'asc' }, select: { rule: true, severity: true } });
  return { caseId, traceId: trace.id, hops: await prisma.hop.count({ where: { traceId: trace.id } }), attributedVasp: candidates[0]?.vaspName ?? null, alerts };
}
