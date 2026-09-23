import { zodResolver } from '@hookform/resolvers/zod';
import { Radar, TriangleAlert } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { DemoModeBadge } from '@/components/common/DemoModeBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/skeleton';
import { loginSchema, type LoginValues } from '@/features/auth/loginSchema';
import { safeReturnPath, useLogin } from '@/features/auth/session';
import { errorMessage } from '@/lib/api/errors';
import { useAuthStore } from '@/stores/auth';

export function LoginPage() {
  const user = useAuthStore((s) => s.user);
  const endReason = useAuthStore((s) => s.endReason);
  const from = safeReturnPath((useLocation().state as { from?: string } | null)?.from);
  const navigate = useNavigate();
  const login = useLogin();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });

  // Already signed in (including the moment right after a successful login): go to the requested page.
  if (user) return <Navigate to={from} replace />;

  const submit = handleSubmit((values) => {
    login.mutate(values, { onSuccess: () => navigate(from, { replace: true }) });
  });
  const busy = login.isPending;

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
        <p className="mt-1 text-sm text-muted-foreground">Use your officer account. Access is role-based and audited.</p>

        {endReason === 'expired' && !login.isError && (
          <p role="status" className="mt-4 rounded-md border border-risk-medium/40 bg-risk-medium-soft px-3 py-2 text-sm text-risk-medium">
            Your session has expired. Please sign in again.
          </p>
        )}
        {login.isError && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-md border border-risk-critical/50 bg-risk-critical-soft px-3 py-2 text-sm text-risk-critical">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{errorMessage(login.error)}</span>
          </div>
        )}

        <form onSubmit={submit} noValidate className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <Input id="email" type="email" autoComplete="username" autoFocus disabled={busy} aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-error' : undefined} {...register('email')} />
            {errors.email && (
              <p id="email-error" className="text-xs text-risk-critical">
                {errors.email.message}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input id="password" type="password" autoComplete="current-password" disabled={busy} aria-invalid={!!errors.password} aria-describedby={errors.password ? 'password-error' : undefined} {...register('password')} />
            {errors.password && (
              <p id="password-error" className="text-xs text-risk-critical">
                {errors.password.message}
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={busy} aria-busy={busy}>
            {busy && <Spinner label="Signing in" className="border-primary-foreground/40 border-t-primary-foreground" />}
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <div className="mt-4">
          <DemoModeBadge />
        </div>
      </main>
    </div>
  );
}
