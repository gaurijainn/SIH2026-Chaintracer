import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { Toaster } from '@/components/common/Toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createAppRouter } from '@/router';
import { useAuthStore } from '@/stores/auth';

/** Provider stack shared by the app and tests: query cache, tooltips, router, toasts. */
export function App({ queryClient, router }: { queryClient: QueryClient; router?: ReturnType<typeof createBrowserRouter> }) {
  const r = useMemo(() => router ?? createAppRouter(), [router]);
  // Never let one user's cached server data survive into the next session.
  useEffect(() => useAuthStore.subscribe((s, prev) => {
    if (prev.user && !s.user) queryClient.clear();
  }), [queryClient]);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={r} />
        <Toaster onNavigate={(to) => void r.navigate(to)} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
