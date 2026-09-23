import { describe, expect, it } from 'vitest';
// The backend's source of truth. permissions.ts only has a type import from @prisma/client, so this loads without a DB.
import { ROLE_PERMISSIONS as BACKEND } from '../../../api/src/auth/permissions';
import { can, canAny, ROLE_PERMISSIONS } from './permissions';

describe('frontend permission table', () => {
  it('is identical to the backend B10 matrix for every role', () => {
    for (const role of ['VIEWER', 'INVESTIGATOR', 'SUPERVISOR', 'ADMIN'] as const) {
      expect([...ROLE_PERMISSIONS[role]].sort(), role).toEqual([...BACKEND[role]].sort());
    }
  });

  it('keeps separation of duties: Admin is not a Supervisor', () => {
    expect(can('ADMIN', 'notice:approve')).toBe(false);
    expect(can('ADMIN', 'notice:send')).toBe(false);
    expect(can('ADMIN', 'complaint:create')).toBe(false);
    expect(can('ADMIN', 'vasp:write')).toBe(true);
    expect(can('SUPERVISOR', 'vasp:write')).toBe(false);
    expect(can('INVESTIGATOR', 'notice:approve')).toBe(false);
  });

  it('gives Viewer read-only access and unknown roles nothing', () => {
    for (const p of ROLE_PERMISSIONS.VIEWER) expect(p.endsWith(':read'), p).toBe(true);
    expect(can(undefined, 'case:read')).toBe(false);
    expect(can('ROOT' as never, 'case:read')).toBe(false);
    expect(canAny('VIEWER', [])).toBe(false);
  });
});
