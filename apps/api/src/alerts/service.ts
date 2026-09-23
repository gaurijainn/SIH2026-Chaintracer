import type { AlertSeverity, AlertStatus, PrismaClient } from '@prisma/client';
import { AlertNotFoundError, InvalidAlertTransitionError } from './errors';

export interface ListAlertsFilter {
  caseId?: string;
  severity?: AlertSeverity;
  status?: AlertStatus;
}

export interface UpdateAlertInput {
  /** 'acknowledge' -> ACKNOWLEDGED, 'assign' -> ASSIGNED (requires assigneeId), 'snooze' -> SNOOZED (requires snoozedUntil). */
  action: 'acknowledge' | 'assign' | 'snooze';
  assigneeId?: string;
  snoozedUntil?: string; // ISO datetime
}

export interface AlertServiceDeps {
  prisma: PrismaClient;
}

/** B8/F7 read/update service: list; acknowledge, assign, snooze. */
export class AlertService {
  constructor(private readonly deps: AlertServiceDeps) {}

  async list(filter: ListAlertsFilter) {
    return this.deps.prisma.alert.findMany({
      where: {
        caseId: filter.caseId,
        severity: filter.severity,
        status: filter.status,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(id: string, input: UpdateAlertInput) {
    const existing = await this.deps.prisma.alert.findUnique({ where: { id } });
    if (!existing) throw new AlertNotFoundError(id);

    const data: Record<string, unknown> = {};
    if (input.action === 'acknowledge') {
      data.status = 'ACKNOWLEDGED';
    } else if (input.action === 'assign') {
      if (!input.assigneeId) throw new InvalidAlertTransitionError('assign requires assigneeId');
      data.status = 'ASSIGNED';
      data.assigneeId = input.assigneeId;
    } else if (input.action === 'snooze') {
      if (!input.snoozedUntil) throw new InvalidAlertTransitionError('snooze requires snoozedUntil');
      const d = new Date(input.snoozedUntil);
      if (Number.isNaN(d.getTime())) throw new InvalidAlertTransitionError('snoozedUntil must be a valid ISO datetime');
      data.status = 'SNOOZED';
      data.snoozedUntil = d;
    }

    // Not-found is already handled above (existing check); anything update() throws here (e.g. a
    // foreign-key violation on a bogus assigneeId) is a real error and must propagate, not be masked
    // as a 404.
    return this.deps.prisma.alert.update({ where: { id }, data });
  }
}
