import type { AlertEventPublisher } from './events';
import type { AlertRuleCode, AlertSeverityCode, Chain } from '@ps26183/shared';

export interface AlertCreateInput {
  caseId: string;
  rule: AlertRuleCode;
  severity: AlertSeverityCode;
  chain: Chain;
  address: string;
  amount: string | null;
  message: string;
  metadata?: Record<string, unknown> | null;
  hopId?: string | null;
}

export interface CreatedAlert {
  id: string;
  caseId: string;
  rule: AlertRuleCode;
  severity: AlertSeverityCode;
  chain: string;
  address: string;
  amount: string | null;
}

/** The exact subset of PrismaClient this module needs. */
export interface AlertPersistPrisma {
  alert: {
    create(args: { data: Record<string, unknown> }): Promise<CreatedAlert>;
  };
}

/**
 * Persist-then-publish, in that order and never the other way round: a failed Redis publish must
 * never erase a persisted Alert (the row is the source of truth; GET /alerts still returns it even
 * if the live Socket.IO push was missed), and a failed DB write must never emit an "alert.new" for
 * something that doesn't exist.
 */
export async function persistAndPublishAlert(
  deps: { prisma: AlertPersistPrisma; publish: AlertEventPublisher },
  input: AlertCreateInput,
): Promise<CreatedAlert> {
  const created = await deps.prisma.alert.create({
    data: {
      caseId: input.caseId,
      rule: input.rule,
      severity: input.severity,
      chain: input.chain,
      address: input.address,
      amount: input.amount,
      message: input.message,
      metadata: input.metadata ?? undefined,
      hopId: input.hopId ?? undefined,
    },
  });

  try {
    await deps.publish({
      event: 'alert.new',
      payload: {
        id: created.id,
        rule: created.rule,
        severity: created.severity,
        caseId: created.caseId,
        chain: created.chain as Chain,
        address: created.address,
        amount: created.amount,
      },
    });
  } catch (e) {
    console.error('alert.new publish failed (alert already persisted, row is the source of truth)', e);
  }

  return created;
}
