import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '@/i18n';
import { cn } from '@/lib/cn';
import { useUiStore } from '@/stores/ui';

/** Two-way English / Hindi toggle. Selection is persisted with the other UI preferences (ps26183.ui). */
export function LanguageSwitch({ className }: { className?: string }) {
  const { t } = useTranslation();
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);
  return (
    <div role="group" aria-label={t('Language')} className={cn('inline-flex rounded-md border p-0.5', className)}>
      {LANGUAGES.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-pressed={language === code}
          onClick={() => setLanguage(code)}
          className={cn('h-7 rounded px-2 text-xs font-medium text-muted-foreground hover:text-foreground', language === code && 'bg-accent text-foreground')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
