import { ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { can, canAny, ROLE_LABELS, type Permission } from '@/lib/permissions';
import { useAuthStore } from '@/stores/auth';

/** Returns a checker bound to the signed-in role. Use for disabling controls: `disabled={!can('notice:send')}`. */
export function useCan() {
  const role = useAuthStore((s) => s.user?.role);
  return (permission: Permission) => can(role, permission);
}

/** Renders children only when the role holds the permission (or any of `anyOf`); otherwise `fallback` (default: nothing). */
export function Can({ permission, anyOf, fallback = null, children }: { permission?: Permission; anyOf?: readonly Permission[]; fallback?: ReactNode; children: ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  const allowed = permission ? can(role, permission) : canAny(role, anyOf ?? []);
  return <>{allowed ? children : fallback}</>;
}

/** Route-level gate: shows a "not available for your role" page instead of the route. The API still enforces access. */
export function RequirePermission({ permission, anyOf, children }: { permission?: Permission; anyOf?: readonly Permission[]; children: ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  return (
    <Can permission={permission} anyOf={anyOf} fallback={<Forbidden role={role ? ROLE_LABELS[role] : undefined} />}>
      {children}
    </Can>
  );
}

function Forbidden({ role }: { role?: string }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={ShieldOff}
      title="Not available for your role"
      description={`${role ? `Your ${role} role does not include this area.` : 'Your role does not include this area.'} Contact your administrator if you need access.`}
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard">{t('Back to dashboard')}</Link>
        </Button>
      }
      className="mt-8"
    />
  );
}

/** Small "Read-only" pill for pages where the user can look but not change. */
export function ReadOnlyNotice({ writePermission }: { writePermission: Permission }) {
  return (
    <Can permission={writePermission} fallback={<span className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">Read-only access</span>}>
      {null}
    </Can>
  );
}
