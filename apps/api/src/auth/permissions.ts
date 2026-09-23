import type { Role } from '@prisma/client';

/**
 * One permission per real action exposed under /api/v1 (no speculative ones). Route -> permission:
 *
 *   complaint:read    GET  /complaints                          complaint:create  POST /complaints, /complaints/import
 *   case:read         GET  /cases/:id  (audited)                graph:read        GET  /traces/:id/graph
 *   risk:read         GET  /addresses/:chain/:addr/risk         mule:read         GET  /cases/:id/mule/*, /addresses/:chain/:addr/shared-mule
 *   mule:analyze      POST /cases/:id/mule/analyze              watchlist:read    GET  /watchlist
 *   watchlist:write   POST /watchlist, DELETE /watchlist/:id    alert:read        GET  /alerts
 *   alert:update      PATCH /alerts/:id                         report:generate   POST /cases/:id/reports (audited export)
 *   notice:draft      POST /cases/:id/freeze-notices, PATCH /freeze-notices/:id, POST .../submit
 *   notice:approve    POST /freeze-notices/:id/approve          notice:send       POST /freeze-notices/:id/send, POST /integrations/*
 *   label:write       POST /labels, DELETE /labels/:id (audited)
 *   vasp:read         GET  /vasps                               vasp:write        POST /vasps (audited)
 *
 * GET /verify/:hash and /auth/login|refresh|logout are public by design (third parties verify a report via its QR code).
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
// Approving/sending a freeze notice is the supervisor's gate (plan F-section: "only a Supervisor sees Approve and send").
const SUPERVISOR: Permission[] = [...INVESTIGATOR, 'notice:approve', 'notice:send'];
// Admin is a configuration role (VASP registry + labels) with read visibility everywhere; it deliberately does NOT
// create investigations or approve/send notices -- separation of duties between configuring and acting on a case.
const ADMIN: Permission[] = [...VIEWER, 'label:write', 'vasp:write'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER),
  INVESTIGATOR: new Set(INVESTIGATOR),
  SUPERVISOR: new Set(SUPERVISOR),
  ADMIN: new Set(ADMIN),
};

export const can = (role: Role, permission: Permission): boolean => ROLE_PERMISSIONS[role]?.has(permission) ?? false;
