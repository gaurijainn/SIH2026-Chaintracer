import { z } from 'zod';

/**
 * Backend contract, read from the code (not assumed):
 *  - GET /api/v1/alerts?caseId=&severity=&status= -> { alerts: Alert[] }  (apps/api/src/alerts/routes.ts, raw Prisma rows, no pagination)
 *  - PATCH /api/v1/alerts/:id { action: 'acknowledge' | 'assign' | 'snooze', assigneeId?, snoozedUntil? } -> { alert }
 *  - Socket.IO `alert.new` { id, rule, severity, caseId, chain, address, amount } to room `case:<caseId>` (packages/shared monitorEvents.ts)
 */
export const ALERT_SEVERITIES = ['INFO', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const ALERT_STATUSES = ['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'SNOOZED'] as const;
export const ALERT_RULES = ['A1_MOVEMENT', 'A2_VASP_LANDING', 'A3_OBFUSCATION', 'A4_LINKAGE', 'A5_BLACKLIST'] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export type AlertRule = (typeof ALERT_RULES)[number];

const severityEnum = z.enum(ALERT_SEVERITIES);
const statusEnum = z.enum(ALERT_STATUSES);
const ruleEnum = z.enum(ALERT_RULES);
const decimal = z.union([z.string(), z.number()]);

/** One row of GET /alerts. `chain` is a free string in the database, so it is not narrowed to the five known chains. */
export const alertSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  rule: ruleEnum,
  severity: severityEnum,
  status: statusEnum,
  chain: z.string().min(1),
  address: z.string().min(1),
  amount: decimal.nullable().optional(),
  message: z.string(),
  metadata: z.unknown().optional(),
  hopId: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  snoozedUntil: z.string().nullable().optional(),
  createdAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp'),
});
export type Alert = z.infer<typeof alertSchema>;

export const alertsResponseSchema = z.object({ alerts: z.array(alertSchema) });
export const alertResponseSchema = z.object({ alert: alertSchema });

/** Socket.IO `alert.new` payload. It carries no message, hopId or status: those come from GET /alerts. */
export const alertNewEventSchema = z.object({
  id: z.string().min(1),
  rule: ruleEnum,
  severity: severityEnum,
  caseId: z.string().min(1),
  chain: z.string().min(1),
  address: z.string().min(1),
  amount: decimal.nullable().optional(),
});
export type AlertNewEvent = z.infer<typeof alertNewEventSchema>;

export const RULE_LABELS: Record<AlertRule, string> = {
  A1_MOVEMENT: 'Movement above threshold',
  A2_VASP_LANDING: 'Landed at a VASP',
  A3_OBFUSCATION: 'Obfuscation service',
  A4_LINKAGE: 'Linked to another case',
  A5_BLACKLIST: 'Blacklist / sanctions hit',
};

export const SEVERITY_LABELS: Record<AlertSeverity, string> = { INFO: 'Info', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' };
export const STATUS_LABELS: Record<AlertStatus, string> = { NEW: 'New', ACKNOWLEDGED: 'Acknowledged', ASSIGNED: 'Assigned', SNOOZED: 'Snoozed' };

export interface AlertFilters {
  /** A case id from the case list the dashboard already derives. Empty = every case. */
  caseId: string;
  severity: AlertSeverity | '';
  status: AlertStatus | '';
}
export const NO_ALERT_FILTERS: AlertFilters = { caseId: '', severity: '', status: '' };
export const alertFiltersActive = (f: AlertFilters) => !!(f.caseId || f.severity || f.status);

/** Snooze presets. The API takes any ISO instant, so these are just convenient client-chosen durations. */
export const SNOOZE_OPTIONS = [
  { label: '1 hour', ms: 3_600_000 },
  { label: '4 hours', ms: 4 * 3_600_000 },
  { label: '24 hours', ms: 24 * 3_600_000 },
] as const;

export const formatAmount = (a: string | number | null | undefined) => {
  if (a === null || a === undefined || a === '') return null;
  const n = Number(a);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(a);
};
