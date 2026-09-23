import type { NoticeStatus, Prisma, PrismaClient } from '@prisma/client';
import { toIst } from '@ps26183/shared';
import type { AuditService } from '../audit/service';
import type { IntegrationAdapter } from '../integrations/types';
import { AlertNotFoundError, CaseNotFoundError, FreezeNoticeNotFoundError, InvalidNoticeTransitionError, VaspNotFoundError } from './errors';

export interface DraftFreezeNoticeInput {
  vaspId: string;
  alertId?: string;
  actorId?: string;
}

export interface EditFreezeNoticeInput {
  legalProvision?: string;
  body?: Record<string, unknown>;
}

export interface FreezeNoticeServiceDeps {
  prisma: PrismaClient;
  audit: AuditService;
  sahyog: IntegrationAdapter<Record<string, unknown>, { submissionId: string; sandbox: true; mode: string }>;
}

const EDITABLE_STATUSES: NoticeStatus[] = ['DRAFT', 'PENDING_APPROVAL'];

/**
 * B9 freeze-notice state machine: DRAFT -> PENDING_APPROVAL -> APPROVED -> SENT. `send` is only
 * reachable from APPROVED (the state machine itself is the "unapproved notice cannot be submitted"
 * guard -- no separate schema flag needed). `legalProvision` is never auto-populated with statutory
 * text; it starts `null` and only the IO's own `edit` call can set it.
 */
export class FreezeNoticeService {
  constructor(private readonly deps: FreezeNoticeServiceDeps) {}

  async draft(caseId: string, input: DraftFreezeNoticeInput) {
    const kase = await this.deps.prisma.case.findUnique({ where: { id: caseId } });
    if (!kase) throw new CaseNotFoundError(caseId);

    const vasp = await this.deps.prisma.vasp.findUnique({ where: { id: input.vaspId }, include: { addresses: true } });
    if (!vasp) throw new VaspNotFoundError(input.vaspId);

    let alert: Awaited<ReturnType<PrismaClient['alert']['findUnique']>> = null;
    if (input.alertId) {
      alert = await this.deps.prisma.alert.findUnique({ where: { id: input.alertId } });
      if (!alert || alert.caseId !== caseId) throw new AlertNotFoundError(input.alertId);
    }

    // Deposit addresses this notice concerns: from the specific alert's evidence when given
    // (Alert.metadata.landingAddress, per A2 -- see workers/monitor/rules.ts, read-only), else every
    // known address this VASP has on file (still real data, never invented).
    const depositAddresses = alert?.metadata && typeof alert.metadata === 'object' && 'landingAddress' in (alert.metadata as object)
      ? [String((alert.metadata as Record<string, unknown>).landingAddress)]
      : vasp.addresses.map((a) => a.addr);

    // Hops landing on any of those deposit addresses, scoped to this case's own traces.
    const traces = await this.deps.prisma.traceJob.findMany({ where: { caseId } });
    const traceIds = traces.map((t) => t.id);
    const hops = traceIds.length && depositAddresses.length
      ? await this.deps.prisma.hop.findMany({ where: { traceId: { in: traceIds }, toAddr: { in: depositAddresses } } })
      : [];

    const txHashes = [...new Set(hops.map((h) => h.txHash))];
    const amounts = hops.map((h) => ({ chain: h.chain, token: h.token, amount: h.amount.toString(), usd: h.usd ? h.usd.toString() : null, ts: { utc: h.ts.toISOString(), ist: toIst(h.ts) } }));

    const body = {
      vasp: { id: vasp.id, name: vasp.name, jurisdiction: vasp.jurisdiction, contactEmail: vasp.contactEmail, contactPortal: vasp.contactPortal },
      depositAddresses,
      txHashes,
      amounts,
      alertId: alert?.id ?? null,
      alertEvidence: alert?.metadata ?? null,
      requestedAt: { utc: new Date().toISOString(), ist: toIst(new Date()) },
      requests: {
        freeze: 'Request to freeze the identified deposit address(es)/account(s) pending investigation.',
        kyc: 'Request for KYC/onboarding records for the identified deposit address(es)/account(s).',
        logPreservation: 'Request to preserve transaction, login, and withdrawal logs for the identified deposit address(es)/account(s) pending a formal legal request.',
      },
    };

    const created = await this.deps.prisma.freezeNotice.create({
      data: {
        caseId,
        vaspId: input.vaspId,
        status: 'DRAFT',
        legalProvision: null,
        body: body as unknown as Prisma.InputJsonValue,
        createdById: input.actorId ?? null,
      },
    });

    await this.deps.audit.record({ actorId: input.actorId, action: 'freeze notice drafted', entity: 'FreezeNotice', entityId: created.id, meta: { caseId, vaspId: input.vaspId, alertId: input.alertId ?? null } });

    return created;
  }

  private async load(id: string) {
    const notice = await this.deps.prisma.freezeNotice.findUnique({ where: { id } });
    if (!notice) throw new FreezeNoticeNotFoundError(id);
    return notice;
  }

  async edit(id: string, input: EditFreezeNoticeInput, actorId?: string) {
    const notice = await this.load(id);
    if (!EDITABLE_STATUSES.includes(notice.status)) {
      throw new InvalidNoticeTransitionError(`freeze notice ${id} cannot be edited from status ${notice.status}`);
    }
    const updated = await this.deps.prisma.freezeNotice.update({
      where: { id },
      data: {
        legalProvision: input.legalProvision !== undefined ? input.legalProvision : undefined,
        body: input.body !== undefined ? (input.body as unknown as Prisma.InputJsonValue) : undefined,
      },
    });
    await this.deps.audit.record({ actorId, action: 'freeze notice edited', entity: 'FreezeNotice', entityId: id, meta: { fields: Object.keys(input) } });
    return updated;
  }

  async submitForApproval(id: string, actorId?: string) {
    const notice = await this.load(id);
    if (notice.status !== 'DRAFT') {
      throw new InvalidNoticeTransitionError(`freeze notice ${id} must be DRAFT to submit for approval (currently ${notice.status})`);
    }
    const updated = await this.deps.prisma.freezeNotice.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } });
    await this.deps.audit.record({ actorId, action: 'freeze notice submitted for approval', entity: 'FreezeNotice', entityId: id });
    return updated;
  }

  async approve(id: string, input: { approvedById?: string }, actorId?: string) {
    const notice = await this.load(id);
    if (notice.status !== 'PENDING_APPROVAL') {
      throw new InvalidNoticeTransitionError(`freeze notice ${id} must be PENDING_APPROVAL to approve (currently ${notice.status})`);
    }
    const updated = await this.deps.prisma.freezeNotice.update({
      where: { id },
      data: { status: 'APPROVED', approvedById: input.approvedById ?? null, approvedAt: new Date() },
    });
    await this.deps.audit.record({ actorId: actorId ?? input.approvedById, action: 'freeze notice approved', entity: 'FreezeNotice', entityId: id, meta: { approvedById: input.approvedById ?? null } });
    return updated;
  }

  /**
   * Only reachable from APPROVED -- this check IS the "unapproved notice cannot be submitted" guard.
   * Already-SENT-with-a-submissionId is treated as an idempotent no-op re-send rather than an
   * invalid transition, so retrying a send that already succeeded never double-submits to SAHYOG.
   */
  async send(id: string, actorId?: string) {
    const notice = await this.load(id);
    if (notice.status === 'SENT' && notice.submissionId) {
      await this.deps.audit.record({ actorId, action: 'freeze notice submission skipped (already sent)', entity: 'FreezeNotice', entityId: id, meta: { submissionId: notice.submissionId } });
      return notice;
    }
    if (notice.status !== 'APPROVED') {
      throw new InvalidNoticeTransitionError(`freeze notice ${id} must be APPROVED to send (currently ${notice.status})`);
    }

    await this.deps.audit.record({ actorId, action: 'freeze notice submission attempted', entity: 'FreezeNotice', entityId: id });

    try {
      const result = await this.deps.sahyog.submit(notice.body as Record<string, unknown>);
      const updated = await this.deps.prisma.freezeNotice.update({ where: { id }, data: { status: 'SENT', submissionId: result.submissionId, sentAt: new Date() } });
      await this.deps.audit.record({ actorId, action: 'freeze notice submitted', entity: 'FreezeNotice', entityId: id, meta: { submissionId: result.submissionId } });
      return updated;
    } catch (e) {
      await this.deps.audit.record({ actorId, action: 'freeze notice submission failed', entity: 'FreezeNotice', entityId: id, meta: { error: e instanceof Error ? e.message : String(e) } });
      throw e;
    }
  }
}
