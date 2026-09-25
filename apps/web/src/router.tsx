import type { ReactElement } from 'react';
import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from 'react-router-dom';
import { RequirePermission } from '@/features/auth/access';
import { ProtectedRoute } from '@/features/auth/ProtectedRoute';
import { AppShell } from '@/layouts/AppShell';
import { INTAKE_ACCESS, REPORT_ACCESS, type RouteHandle } from '@/layouts/nav';
import type { Permission } from '@/lib/permissions';
import { IntakePage } from '@/features/intake/IntakePage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { CaseDetailPage } from '@/features/cases/CaseDetailPage';
import { AlertsPage } from '@/features/alerts/AlertsPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { CasesPage, VaspsPage, WatchlistPage } from '@/pages/placeholders';
import { SettingsPage } from '@/pages/SettingsPage';

const gate = (permission: Permission, el: ReactElement) => <RequirePermission permission={permission}>{el}</RequirePermission>;

const h = (title: string, parent?: RouteHandle['parent']): RouteHandle => ({ title, parent });

/** /login is public; every other route sits under ProtectedRoute and renders inside the shell. */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: '/', element: <Navigate to="/dashboard" replace /> },
          { path: '/dashboard', element: <DashboardPage />, handle: h('Dashboard') },
          { path: '/intake', element: <RequirePermission anyOf={INTAKE_ACCESS}><IntakePage /></RequirePermission>, handle: h('Intake') },
          { path: '/cases', element: gate('case:read', <CasesPage />), handle: h('Cases') },
          { path: '/cases/:id', element: gate('case:read', <CaseDetailPage />), handle: h('Case', { label: 'Cases', to: '/cases' }) },
          { path: '/alerts', element: gate('alert:read', <AlertsPage />), handle: h('Alerts') },
          { path: '/watchlist', element: gate('watchlist:read', <WatchlistPage />), handle: h('Watchlist') },
          { path: '/vasps', element: gate('vasp:read', <VaspsPage />), handle: h('VASP Registry') },
          { path: '/reports', element: <RequirePermission anyOf={REPORT_ACCESS}><ReportsPage /></RequirePermission>, handle: h('Reports') },
          { path: '/settings', element: <SettingsPage />, handle: h('Settings') },
          { path: '*', element: <NotFoundPage />, handle: h('Not found') },
        ],
      },
    ],
  },
];

export const createAppRouter = () => createBrowserRouter(routes);
export const createTestRouter = (initialEntries: string[]) => createMemoryRouter(routes, { initialEntries });
