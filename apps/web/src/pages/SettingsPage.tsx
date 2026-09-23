import { Check, Minus, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { ChainBadge, RiskBadge } from '@/components/common/badges';
import { PageHeader } from '@/components/common/PageHeader';
import { SectionCard } from '@/components/common/cards';
import { cn } from '@/lib/cn';
import { can, PERMISSION_LABELS, ROLE_LABELS } from '@/lib/permissions';
import { CHAINS, RISK_BANDS, type Chain, type RiskBand } from '@/lib/tokens';
import { useAuthStore } from '@/stores/auth';
import { useUiStore, type ThemePreference } from '@/stores/ui';

const THEMES: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
];

export function SettingsPage() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const user = useAuthStore((s) => s.user);
  return (
    <>
      <PageHeader title="Settings" description="Display preferences for this browser." />
      {user && (
        <SectionCard
          className="mb-4"
          title="Your access"
          description={`Signed in as ${user.name} (${ROLE_LABELS[user.role]}). This mirrors what the server allows for your role; the server checks every request.`}
        >
          <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {PERMISSION_LABELS.map(({ permission, label }) => {
              const allowed = can(user.role, permission);
              return (
                <li key={permission} className={cn('flex items-center gap-2 text-sm', !allowed && 'text-muted-foreground')}>
                  {allowed ? <Check className="size-4 text-risk-low" aria-hidden="true" /> : <Minus className="size-4" aria-hidden="true" />}
                  <span>{label}</span>
                  <span className="sr-only">{allowed ? '(allowed)' : '(not allowed)'}</span>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Appearance" description="Dark is the default. Light is used for printing.">
          <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-md border p-0.5">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => setTheme(value)}
                className={cn('inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm font-medium text-muted-foreground hover:text-foreground', theme === value && 'bg-accent text-foreground')}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </SectionCard>
        <SectionCard title="Risk and chain key" description="How risk bands and chains are shown across the console.">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(RISK_BANDS) as RiskBand[]).map((b) => (
                <RiskBadge key={b} band={b} />
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(CHAINS) as Chain[]).map((c) => (
                <ChainBadge key={c} chain={c} />
              ))}
            </div>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
