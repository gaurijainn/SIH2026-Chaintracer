import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useMatches } from 'react-router-dom';
import { DemoBanner } from '@/components/common/DemoModeBadge';
import type { RouteHandle } from './nav';
import { MobileNav, Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

function useRouteHandle(): RouteHandle | undefined {
  const matches = useMatches();
  return [...matches].reverse().find((m) => (m.handle as RouteHandle | undefined)?.title)?.handle as RouteHandle | undefined;
}

function Breadcrumbs({ handle }: { handle?: RouteHandle }) {
  const { t } = useTranslation();
  if (!handle) return null;
  return (
    <nav aria-label={t('Breadcrumb')} className="mb-3 flex items-center gap-1 text-xs text-muted-foreground print:hidden">
      <Link to="/dashboard" className="rounded hover:text-foreground">
        {t('Console')}
      </Link>
      {handle.parent && (
        <>
          <ChevronRight className="size-3" aria-hidden="true" />
          <Link to={handle.parent.to} className="rounded hover:text-foreground">
            {t(handle.parent.label)}
          </Link>
        </>
      )}
      <ChevronRight className="size-3" aria-hidden="true" />
      <span aria-current="page" className="font-medium text-foreground">
        {t(handle.title)}
      </span>
    </nav>
  );
}

/** Authenticated layout: sidebar + top bar + routed content. Print hides the chrome and leaves only the page. */
export function AppShell() {
  const handle = useRouteHandle();
  const { t } = useTranslation();
  const { pathname } = useLocation();

  useEffect(() => {
    document.title = handle ? `${t(handle.title)} · PS 26183` : 'PS 26183 · Crypto Fraud Tracing';
  }, [handle, t]);

  return (
    <div className="flex h-screen overflow-hidden print:block print:h-auto print:overflow-visible">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
        {t('Skip to main content')}
      </a>
      <Sidebar />
      <MobileNav />
      <div className="flex min-w-0 flex-1 flex-col print:block">
        <DemoBanner />
        <Topbar />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden focus:outline-none print:overflow-visible">
          <div key={pathname} className="page-enter mx-auto w-full max-w-[1600px] px-4 py-5 md:px-6">
            <Breadcrumbs handle={handle} />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
