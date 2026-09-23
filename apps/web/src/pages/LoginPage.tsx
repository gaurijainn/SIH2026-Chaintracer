import { Radar } from 'lucide-react';
import { Navigate, useLocation } from 'react-router-dom';
import { DemoModeBadge } from '@/components/common/DemoModeBadge';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth';

/**
 * F0 stub: the real sign-in form (react-hook-form + zod against POST /auth/login) is F1.
 * The dev-only button below opens the shell for visual work; it does not authenticate against the API,
 * carries no tokens, and is compiled out of production builds.
 */
export function LoginPage() {
  const user = useAuthStore((s) => s.user);
  const setSession = useAuthStore((s) => s.setSession);
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/dashboard';
  if (user) return <Navigate to={from} replace />;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <main className="w-full max-w-sm rounded-lg border bg-card p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <Radar className="size-6 text-primary" aria-hidden="true" />
          <div className="leading-tight">
            <h1 className="text-base font-semibold">Chain Tracer</h1>
            <p className="text-xs text-muted-foreground">PS 26183 · Fraud-linked exchange identification</p>
          </div>
        </div>
        <h2 className="text-sm font-semibold">Sign in</h2>
        <p className="mt-1 text-sm text-muted-foreground">Officer sign-in will be available here shortly. Access is role-based and audited.</p>
        <div className="mt-4">
          <DemoModeBadge />
        </div>
        {import.meta.env.DEV && (
          <div className="mt-5 border-t pt-4">
            <p className="mb-2 text-xs text-muted-foreground">Development only · no server session</p>
            <Button variant="outline" size="sm" onClick={() => setSession({ user: { id: 'dev-preview', email: 'preview@localhost', name: 'Preview user', role: 'VIEWER' }, accessToken: '', refreshToken: '' })}>
              Preview the console shell
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
