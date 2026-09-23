import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { Toaster } from '@/components/common/Toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createAppRouter } from '@/router';

/** Provider stack shared by the app and tests: query cache, tooltips, router, toasts. */
export function App({ queryClient, router }: { queryClient: QueryClient; router?: ReturnType<typeof createBrowserRouter> }) {
  const r = useMemo(() => router ?? createAppRouter(), [router]);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={r} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
