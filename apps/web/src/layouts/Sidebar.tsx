import { Radar } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { canAny } from '@/lib/permissions';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { NAV_ITEMS } from './nav';

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4', collapsed && 'justify-center px-0')}>
      <Radar className="size-5 shrink-0 text-primary" aria-hidden="true" />
      {!collapsed && (
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold">Chain Tracer</p>
          <p className="truncate text-[0.6875rem] text-muted-foreground">PS 26183 · Investigations</p>
        </div>
      )}
    </div>
  );
}

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const role = useAuthStore((s) => s.user?.role);
  const items = NAV_ITEMS.filter((i) => !i.anyOf || canAny(role, i.anyOf));
  return (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
      <ul className="space-y-0.5">
        {items.map(({ to, label, icon: Icon }) => {
          const link = (
            <NavLink
              to={to}
              onClick={onNavigate}
              aria-label={collapsed ? label : undefined}
              className={({ isActive }) =>
                cn(
                  'relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                  collapsed && 'justify-center px-0',
                  isActive && 'bg-accent text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary',
                )
              }
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">{label}</span>}
            </NavLink>
          );
          return <li key={to}>{collapsed ? <Tooltip label={label}>{link}</Tooltip> : link}</li>;
        })}
      </ul>
    </nav>
  );
}

/** Desktop/tablet rail (md and up); collapse state comes from the UI store. */
export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  return (
    <aside className={cn('hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-150 md:flex print:hidden', collapsed ? 'w-14' : 'w-60')}>
      <Brand collapsed={collapsed} />
      <NavList collapsed={collapsed} />
    </aside>
  );
}

/** Below md the same navigation opens as a left drawer. */
export function MobileNav() {
  const open = useUiStore((s) => s.mobileNavOpen);
  const setOpen = useUiStore((s) => s.setMobileNavOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent variant="left" title="Navigation" description="Main navigation">
        <div className="flex h-full flex-col">
          <Brand collapsed={false} />
          <NavList collapsed={false} onNavigate={() => setOpen(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
