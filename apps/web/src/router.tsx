import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from 'react-router-dom';
import { ProtectedRoute } from '@/features/auth/ProtectedRoute';
import { AppShell } from '@/layouts/AppShell';
import type { RouteHandle } from '@/layouts/nav';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { AlertsPage, CaseDetailPage, CasesPage, DashboardPage, IntakePage, ReportsPage, VaspsPage, WatchlistPage } from '@/pages/placeholders';
import { SettingsPage } from '@/pages/SettingsPage';

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
          { path: '/intake', element: <IntakePage />, handle: h('Intake') },
          { path: '/cases', element: <CasesPage />, handle: h('Cases') },
          { path: '/cases/:id', element: <CaseDetailPage />, handle: h('Case', { label: 'Cases', to: '/cases' }) },
          { path: '/alerts', element: <AlertsPage />, handle: h('Alerts') },
          { path: '/watchlist', element: <WatchlistPage />, handle: h('Watchlist') },
          { path: '/vasps', element: <VaspsPage />, handle: h('VASP Registry') },
          { path: '/reports', element: <ReportsPage />, handle: h('Reports') },
          { path: '/settings', element: <SettingsPage />, handle: h('Settings') },
          { path: '*', element: <NotFoundPage />, handle: h('Not found') },
        ],
      },
    ],
  },
];

export const createAppRouter = () => createBrowserRouter(routes);
export const createTestRouter = (initialEntries: string[]) => createMemoryRouter(routes, { initialEntries });
