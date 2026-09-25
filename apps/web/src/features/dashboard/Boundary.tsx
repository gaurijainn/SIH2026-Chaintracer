import { ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';

interface QueryLike {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => unknown;
}

/** A query that is pending but idle never started: the hook skipped it because the role lacks the read permission. */
export const isSkipped = (q: Pick<QueryLike, 'isPending' | 'fetchStatus'>) => q.isPending && q.fetchStatus === 'idle';

/** Loading, error and permission states shared by every dashboard panel; children render only with data. */
export function Boundary({ queries, loadingRows = 3, children }: { queries: QueryLike[]; loadingRows?: number; children: () => ReactNode }) {
  const failed = queries.find((q) => q.isError);
  if (failed) return <ErrorState error={failed.error} title="Could not load this panel" onRetry={() => queries.filter((q) => q.isError).forEach((q) => void q.refetch())} className="py-8" />;
  if (queries.some(isSkipped)) return <EmptyState icon={ShieldOff} title="Not available for your role" description="Your role does not include the data this panel reads." className="py-8" />;
  if (queries.some((q) => q.isPending)) return <LoadingState rows={loadingRows} label="Loading panel" />;
  return <>{children()}</>;
}
