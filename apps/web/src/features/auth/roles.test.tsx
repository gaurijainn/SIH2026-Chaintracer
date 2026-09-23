import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_LABELS, type Permission } from '@/lib/permissions';
import type { Role } from '@/stores/auth';
import { mountApp, resetAppState, signInAs } from '@/test/utils';
import { Can, useCan } from './access';

beforeEach(resetAppState);

const ALL_NAV = ['Dashboard', 'Intake', 'Cases', 'Alerts', 'Watchlist', 'VASP Registry', 'Reports', 'Settings'];
// Derived by hand from apps/api/src/auth/permissions.ts, not from the frontend table under test.
const NAV: Record<Role, string[]> = {
  VIEWER: ['Dashboard', 'Cases', 'Alerts', 'Watchlist', 'VASP Registry', 'Settings'],
  INVESTIGATOR: ALL_NAV,
  SUPERVISOR: ALL_NAV,
  ADMIN: ['Dashboard', 'Cases', 'Alerts', 'Watchlist', 'VASP Registry', 'Settings'],
};
const ROLES: Role[] = ['VIEWER', 'INVESTIGATOR', 'SUPERVISOR', 'ADMIN'];
const ROLE_TITLE: Record<Role, string> = { VIEWER: 'Viewer', INVESTIGATOR: 'Investigator', SUPERVISOR: 'Supervisor', ADMIN: 'Admin' };

describe.each(ROLES)('%s', (role) => {
  it('shows exactly the navigation the backend matrix allows', () => {
    signInAs(role);
    mountApp('/dashboard');
    const links = within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('link').map((a) => a.textContent);
    expect(links).toEqual(NAV[role]);
  });

  it('shows the signed-in identity and role in the user menu', async () => {
    signInAs(role);
    mountApp('/dashboard');
    const trigger = screen.getByRole('button', { name: /account menu/i });
    expect(trigger).toHaveAccessibleName(new RegExp(ROLE_TITLE[role]));
    await userEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText(`${role === 'ADMIN' ? 'admin' : role.toLowerCase()}@demo.local`)).toBeInTheDocument();
    expect(within(menu).getByText(ROLE_TITLE[role])).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });
});

describe('route gating', () => {
  it.each([
    ['VIEWER', '/intake', false],
    ['ADMIN', '/intake', false],
    ['INVESTIGATOR', '/intake', true],
    ['SUPERVISOR', '/intake', true],
    ['VIEWER', '/reports', false],
    ['ADMIN', '/reports', false],
    ['INVESTIGATOR', '/reports', true],
    ['SUPERVISOR', '/reports', true],
    ['VIEWER', '/cases/x', true],
    ['ADMIN', '/vasps', true],
    ['VIEWER', '/watchlist', true],
  ] as [Role, string, boolean][])('%s opening %s: allowed=%s', (role, path, allowed) => {
    signInAs(role);
    mountApp(path);
    const denied = screen.queryByText('Not available for your role');
    if (allowed) {
      expect(denied).not.toBeInTheDocument();
      expect(screen.getByText(/^Planned ·/)).toBeInTheDocument();
    } else {
      expect(denied).toBeInTheDocument();
      expect(screen.queryByText(/^Planned ·/)).not.toBeInTheDocument();
    }
  });
});

describe('read-only state', () => {
  const ro = () => screen.queryByText('Read-only access');
  it.each([
    ['/watchlist', { VIEWER: true, INVESTIGATOR: false, SUPERVISOR: false, ADMIN: true }],
    ['/alerts', { VIEWER: true, INVESTIGATOR: false, SUPERVISOR: false, ADMIN: true }],
    ['/cases', { VIEWER: true, INVESTIGATOR: false, SUPERVISOR: false, ADMIN: true }],
    // only Admin can write the VASP registry
    ['/vasps', { VIEWER: true, INVESTIGATOR: true, SUPERVISOR: true, ADMIN: false }],
  ] as [string, Record<Role, boolean>][])('%s', (path, expected) => {
    for (const role of ROLES) {
      resetAppState();
      signInAs(role);
      const { unmount } = mountApp(path);
      expect(!!ro(), `${role} on ${path}`).toBe(expected[role]);
      unmount();
    }
  });
});

const ACTIONS: { permission: Permission; label: string }[] = [
  { permission: 'notice:approve', label: 'Approve notice' },
  { permission: 'notice:send', label: 'Send notice' },
  { permission: 'watchlist:write', label: 'Add to watchlist' },
  { permission: 'vasp:write', label: 'Register VASP' },
  { permission: 'label:write', label: 'Edit label' },
  { permission: 'complaint:create', label: 'New complaint' },
];

function ActionBar() {
  const can = useCan();
  return (
    <div>
      {ACTIONS.map((a) => (
        <Can key={a.permission} permission={a.permission}>
          <button>{a.label}</button>
        </Can>
      ))}
      <button disabled={!can('notice:send')}>Send (disabled variant)</button>
    </div>
  );
}

describe('role-gated components (rendered)', () => {
  const EXPECTED: Record<Role, string[]> = {
    VIEWER: [],
    INVESTIGATOR: ['Add to watchlist', 'Edit label', 'New complaint'],
    SUPERVISOR: ['Approve notice', 'Send notice', 'Add to watchlist', 'Edit label', 'New complaint'],
    // Admin: registry + labels only. NOT approve/send, NOT create complaints, NOT watchlist writes.
    ADMIN: ['Register VASP', 'Edit label'],
  };
  it.each(ROLES)('%s sees only permitted actions', (role) => {
    signInAs(role);
    mountApp('/login'); // ensures providers/stores are wired; the harness below reads the same store
    render(<ActionBar />);
    const shown = ACTIONS.map((a) => a.label).filter((l) => screen.queryByRole('button', { name: l }));
    expect(shown.sort()).toEqual([...EXPECTED[role]].sort());
    const send = screen.getByRole('button', { name: 'Send (disabled variant)' });
    expect(send.hasAttribute('disabled')).toBe(role !== 'SUPERVISOR');
  });
});

describe('Your access panel', () => {
  it.each(ROLES)('%s: lists allowed and not-allowed actions', (role) => {
    signInAs(role);
    mountApp('/settings');
    const panel = screen.getByText('Your access').closest('section')!;
    const item = (label: string) => within(panel).getByText(label).closest('li')!;
    const allowed = (perm: Permission) => item(PERMISSION_LABELS.find((p) => p.permission === perm)!.label).textContent!.includes('(allowed)');

    expect(allowed('notice:approve')).toBe(role === 'SUPERVISOR');
    expect(allowed('notice:send')).toBe(role === 'SUPERVISOR');
    expect(allowed('vasp:write')).toBe(role === 'ADMIN');
    expect(allowed('complaint:create')).toBe(role === 'INVESTIGATOR' || role === 'SUPERVISOR');
    expect(allowed('label:write')).toBe(role !== 'VIEWER');
    expect(allowed('case:read')).toBe(true);
  });
});

describe('suggested next steps', () => {
  it.each([
    ['VIEWER', false],
    ['ADMIN', false],
    ['INVESTIGATOR', true],
    ['SUPERVISOR', true],
  ] as [Role, boolean][])('%s: "Go to intake" link visible=%s', (role, visible) => {
    signInAs(role);
    mountApp('/dashboard');
    expect(!!screen.queryByRole('link', { name: 'Go to intake' })).toBe(visible);
  });
});
