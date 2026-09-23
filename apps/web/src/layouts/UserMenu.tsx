import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, CircleUser, LogOut } from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatusBadge } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { signOut } from '@/features/auth/session';
import { ROLE_LABELS } from '@/lib/permissions';
import { useAuthStore } from '@/stores/auth';

/** Signed-in identity: name and role on the button, email + role + sign out in the menu. */
export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  if (!user) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" className="gap-2 px-2" aria-label={`Account menu, ${user.name}, ${ROLE_LABELS[user.role]}`}>
          <CircleUser aria-hidden="true" />
          <span className="hidden max-w-32 truncate text-sm font-medium lg:inline">{user.name}</span>
          <StatusBadge tone="info" className="hidden sm:inline-flex">
            {ROLE_LABELS[user.role]}
          </StatusBadge>
          <ChevronDown className="!size-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-md print:hidden">
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            <StatusBadge tone="info" className="mt-2">
              {ROLE_LABELS[user.role]}
            </StatusBadge>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild>
            <Link to="/settings" className="flex h-8 cursor-pointer items-center gap-2 rounded px-2.5 text-sm outline-none data-[highlighted]:bg-accent">
              <CircleUser className="size-4" aria-hidden="true" />
              Your access
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={signOut} className="flex h-8 cursor-pointer items-center gap-2 rounded px-2.5 text-sm outline-none data-[highlighted]:bg-accent">
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
