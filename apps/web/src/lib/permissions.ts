import type { Role } from '@/stores/auth';

/**
 * Frontend mirror of the B10 permission matrix in apps/api/src/auth/permissions.ts (one permission per real
 * /api/v1 action). It only decides what the UI OFFERS; the API enforces every request, and permissions.test.ts
 * fails if this table drifts from the backend's.
 */
export type Permission =
  | 'complaint:read' | 'complaint:create'
  | 'case:read' | 'graph:read' | 'risk:read' | 'mule:read' | 'mule:analyze'
  | 'watchlist:read' | 'watchlist:write'
  | 'alert:read' | 'alert:update'
  | 'report:generate'
  | 'notice:draft' | 'notice:approve' | 'notice:send'
  | 'label:write'
  | 'vasp:read' | 'vasp:write';

const VIEWER: Permission[] = ['complaint:read', 'case:read', 'graph:read', 'risk:read', 'mule:read', 'watchlist:read', 'alert:read', 'vasp:read'];
const INVESTIGATOR: Permission[] = [...VIEWER, 'complaint:create', 'mule:analyze', 'watchlist:write', 'alert:update', 'report:generate', 'notice:draft', 'label:write'];
// Approve/send is the supervisor's gate.
const SUPERVISOR: Permission[] = [...INVESTIGATOR, 'notice:approve', 'notice:send'];
// Admin configures (VASP registry, labels) and can read everything; it does NOT create investigations or approve/send notices.
const ADMIN: Permission[] = [...VIEWER, 'label:write', 'vasp:write'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER),
  INVESTIGATOR: new Set(INVESTIGATOR),
  SUPERVISOR: new Set(SUPERVISOR),
  ADMIN: new Set(ADMIN),
};

export const ROLE_LABELS: Record<Role, string> = { VIEWER: 'Viewer', INVESTIGATOR: 'Investigator', SUPERVISOR: 'Supervisor', ADMIN: 'Admin' };

/** Unknown / missing role gets nothing. */
export const can = (role: Role | null | undefined, permission: Permission): boolean => (role ? (ROLE_PERMISSIONS[role]?.has(permission) ?? false) : false);

/** True when the role holds at least one of the permissions. */
export const canAny = (role: Role | null | undefined, permissions: readonly Permission[]): boolean => permissions.some((p) => can(role, p));

/** Plain-language list of what each permission lets someone do, for the "Your access" panel. */
export const PERMISSION_LABELS: { permission: Permission; label: string }[] = [
  { permission: 'case:read', label: 'View cases, traces and wallet risk' },
  { permission: 'alert:read', label: 'View alerts and the watchlist' },
  { permission: 'vasp:read', label: 'View the VASP registry' },
  { permission: 'complaint:create', label: 'Register complaints (single and bulk)' },
  { permission: 'mule:analyze', label: 'Run mule-network analysis' },
  { permission: 'watchlist:write', label: 'Add and remove watchlist entries' },
  { permission: 'alert:update', label: 'Acknowledge and update alerts' },
  { permission: 'report:generate', label: 'Generate evidence reports' },
  { permission: 'notice:draft', label: 'Draft and submit freeze notices' },
  { permission: 'notice:approve', label: 'Approve freeze notices' },
  { permission: 'notice:send', label: 'Send freeze notices' },
  { permission: 'label:write', label: 'Manage address labels' },
  { permission: 'vasp:write', label: 'Manage the VASP registry' },
];
