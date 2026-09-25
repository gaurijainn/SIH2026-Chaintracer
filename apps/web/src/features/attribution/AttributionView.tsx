import { ArrowRight, ExternalLink, Landmark } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChainBadge, StatusBadge } from '@/components/common/badges';
import { SectionCard } from '@/components/common/cards';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { useCan } from '@/features/auth/access';
import { NO_FILTERS, useTraceGraph } from '@/features/graph/api';
import { buildGraph, explorerUrl, formatUsdValue, formatWhen, shortAddr } from '@/features/graph/model';
import type { Chain } from '@/lib/tokens';
import { useVaspRegistry } from './api';
import { destinations, type Deposit, type Destination } from './derive';

const label = 'text-xs uppercase tracking-wide text-muted-foreground';

function MiniPath({ deposit }: { deposit: Deposit }) {
  if (!deposit.path) {
    return <p className="text-xs text-muted-foreground">No route from the seed address to this deposit address exists in this trace&apos;s transfers.</p>;
  }
  const last = deposit.path.length - 1;
  return (
    <ol aria-label="Path from seed address to deposit address" className="flex flex-wrap items-center gap-1.5 text-xs">
      {deposit.path.map((s, i) => (
        <li key={s.node.id} className="flex items-center gap-1.5">
          {s.via && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <ArrowRight className="size-3.5" aria-hidden="true" />
              {formatUsdValue(s.via.usd)}
            </span>
          )}
          <span className="rounded-md border bg-muted px-2 py-1 font-mono" title={s.node.addr}>
            <span className="mr-1 text-muted-foreground">{i === 0 ? 'Seed' : i === last ? 'Deposit' : `Hop ${s.via?.hopNo ?? i}`}</span>
            {shortAddr(s.node.addr)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function DepositBlock({ d }: { d: Deposit }) {
  const url = explorerUrl(d.node.chain, d.node.addr);
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChainBadge chain={d.node.chain as Chain} />
        <span className="break-all font-mono text-xs">{d.node.addr}</span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-info underline-offset-2 hover:underline" aria-label={`Open ${shortAddr(d.node.addr)} in the block explorer`}>
            Explorer <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        )}
      </div>
      <div>
        <div className={label}>Path from victim seed</div>
        <div className="mt-1">
          <MiniPath deposit={d} />
        </div>
      </div>
      <div>
        <div className={label}>Evidence</div>
        <ul className="mt-1 space-y-1 text-xs">
          <li>
            <span className="font-medium">Registry hot wallet</span> · source: {d.registry.source} · registry confidence: {d.registry.confidence}
          </li>
          {d.incoming.map((e) => (
            <li key={e.id} className="break-all">
              <span className="font-medium">Transfer in</span> · <span className="font-mono">{e.txHash}</span> · {e.amount} {e.token} ({formatUsdValue(e.usd)}) · hop {e.hopNo} · {formatWhen(e.ts)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function VaspCard({ d, caseId }: { d: Destination; caseId: string }) {
  const can = useCan();
  const v = d.vasp;
  return (
    <SectionCard className="print:break-inside-avoid" bodyClassName="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Landmark className="size-4 text-muted-foreground" aria-hidden="true" />
            {v.name}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {v.type.replace(/_/g, ' ').toLowerCase()} · {v.jurisdiction}
          </p>
        </div>
        <StatusBadge>
          FIU-IND: {v.fiuStatus}
          {v.fiuStatusDate ? ` (${v.fiuStatusDate.slice(0, 10)})` : ''}
        </StatusBadge>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <dt className={label}>Amount reached</dt>
          <dd className="text-lg font-semibold tabular-nums">{formatUsdValue(d.amountUsd)}</dd>
        </div>
        <div>
          <dt className={label}>Hop count</dt>
          <dd className="text-lg font-semibold tabular-nums">{d.hops ?? 'unknown'}</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className={label}>Attribution confidence</dt>
          <dd className="text-sm text-muted-foreground">Not provided by the API yet</dd>
        </div>
      </dl>
      <div className="space-y-3">
        {d.deposits.map((dep) => (
          <DepositBlock key={dep.node.id} d={dep} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        {can('notice:draft') ? (
          <Button asChild>
            <Link to={`/reports?caseId=${encodeURIComponent(caseId)}&vaspId=${encodeURIComponent(v.id)}`}>Draft freeze notice</Link>
          </Button>
        ) : (
          <>
            <Button disabled>Draft freeze notice</Button>
            <span className="text-xs text-muted-foreground">Your role cannot draft freeze notices.</span>
          </>
        )}
      </div>
    </SectionCard>
  );
}

/**
 * F6 destination-VASP view for one trace. Built only from existing endpoints: GET /traces/:id/graph (nodes, transfers) and
 * GET /vasps (registry). A destination is a registry hot wallet the trace reaches, joined on chain + address. Heuristic
 * evidence and attribution confidence are not exposed by any endpoint today, so neither is shown or computed here.
 */
export function AttributionView({ caseId, trace }: { caseId: string; trace: { id: string; seedChain: string; seedAddr: string } }) {
  const can = useCan();
  const graphQ = useTraceGraph(trace.id, NO_FILTERS);
  const registryQ = useVaspRegistry();
  const model = useMemo(() => (graphQ.data ? buildGraph(graphQ.data) : null), [graphQ.data]);
  const dests = useMemo(() => (model && registryQ.data ? destinations(model, registryQ.data, { chain: trace.seedChain, addr: trace.seedAddr }) : null), [model, registryQ.data, trace.seedChain, trace.seedAddr]);

  if (!can('vasp:read')) return null;
  return (
    <section aria-labelledby="attribution-heading" className="space-y-3">
      <div>
        <h2 id="attribution-heading" className="text-sm font-semibold">
          Where to send the notice
        </h2>
        <p className="text-xs text-muted-foreground">Destination VASPs matched from the VASP registry&apos;s hot wallets against this trace.</p>
      </div>
      {graphQ.error ? (
        // The fund-flow graph above already shows this failure with its own retry; do not repeat it.
        <p role="status" className="text-sm text-muted-foreground">
          Destination VASPs are matched against the trace graph, which could not be loaded.
        </p>
      ) : registryQ.error ? (
        <ErrorState error={registryQ.error} title="Could not load destination VASPs" onRetry={() => void registryQ.refetch()} />
      ) : !dests ? (
        <LoadingState rows={3} label="Loading destination VASPs" />
      ) : dests.length === 0 ? (
        <EmptyState icon={Landmark} title="No destination VASP found in this trace" description="None of the addresses in this trace match a hot wallet in the VASP registry." />
      ) : (
        <div className="grid gap-3">
          {dests.map((d) => (
            <VaspCard key={d.vasp.id} d={d} caseId={caseId} />
          ))}
        </div>
      )}
    </section>
  );
}
