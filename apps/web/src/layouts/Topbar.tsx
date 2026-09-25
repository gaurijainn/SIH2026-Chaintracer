import { Bell, Menu, Moon, PanelLeft, Sun } from 'lucide-react';
import { useEffect, useRef, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LanguageSwitch } from '@/components/common/LanguageSwitch';
import { SearchInput } from '@/components/common/SearchInput';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { toast } from '@/stores/toast';
import { resolveDark, useUiStore } from '@/stores/ui';
import { UserMenu } from './UserMenu';

export function Topbar() {
  const { t } = useTranslation();
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setMobileNavOpen = useUiStore((s) => s.setMobileNavOpen);
  const searchRef = useRef<HTMLInputElement>(null);
  const dark = resolveDark(theme);

  // Ctrl/Cmd+K focuses global search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    toast.info('Search is not connected yet', 'Address and transaction lookup arrives with case intake.');
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 md:px-4 print:hidden">
      <Button variant="ghost" size="icon" className="md:hidden" aria-label={t('Open navigation')} onClick={() => setMobileNavOpen(true)}>
        <Menu />
      </Button>
      <Button variant="ghost" size="icon" className="hidden md:inline-flex" aria-label={t('Toggle sidebar')} onClick={toggleSidebar}>
        <PanelLeft />
      </Button>

      <form role="search" onSubmit={onSearch} className="min-w-[8rem] max-w-md flex-1">
        <SearchInput ref={searchRef} label={t('Search address or transaction hash')} placeholder={t('Search address or tx hash…')} />
      </form>
      <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground lg:inline">Ctrl K</kbd>

      <div className="ml-auto flex items-center gap-1.5">
        <LanguageSwitch />
        <Tooltip label={t('Alerts')} side="bottom">
          <Button asChild variant="ghost" size="icon" className="hidden sm:inline-flex">
            <Link to="/alerts" aria-label={t('Alerts')}>
              <Bell />
            </Link>
          </Button>
        </Tooltip>
        <Tooltip label={t(dark ? 'Switch to light theme' : 'Switch to dark theme')} side="bottom">
          <Button variant="ghost" size="icon" aria-label={t('Toggle theme')} onClick={toggleTheme}>
            {dark ? <Sun /> : <Moon />}
          </Button>
        </Tooltip>
        <div className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
        <UserMenu />
      </div>
    </header>
  );
}
