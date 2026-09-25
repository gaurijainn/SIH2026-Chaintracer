import { Check, Copy, ExternalLink, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChainBadge, StatusBadge } from '@/components/common/badges';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useCan } from '@/features/auth/access';
import { explorerUrl, formatUsdValue, formatWhen, shortAddr, type GNode, type GraphModel } from '@/features/graph/model';
import { cn } from '@/lib/cn';
import { CHAINS } from '@/lib/tokens';
import { riskSupported, useAddressRisk, type AddressRisk } from './api';
import { counterparties, dailyActivity, walletTransfers } from './derive';
import { RiskGauge } from './RiskGauge';

const axisTick = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 };
const tooltipStyle = { background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 6, color: 'hsl(var(--popover-foreground))', fontSize: 12 };

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const OVERRIDE_LABELS: Record<string, string> = { SANCTIONED: 'Sanctioned', STABLECOIN_BLACKLIST: 'Stablecoin blacklist' };

/** Score, band, typology and reasons: one request, opened for this wallet only. */
function RiskSection({ risk, chain }: { risk: ReturnType<typeof useAddressRisk>; chain: string }) {
  const can = useCan();
  if (!can('risk:read')) return <EmptyState title="Not available for your role" description="Your role does not include wallet risk scores." className="py-6" />;
  if (!riskSupported(chain)) return <EmptyState title={`No risk score for ${chain}`} description="The v1 risk model is trained for TRON only, so the backend cannot score this chain." className="py-6" />;
  if (risk.isError) return <ErrorState error={risk.error} title="Could not load the risk score" onRetry={() => void risk.refetch()} className="py-6" />;
  if (risk.isPending) return <LoadingState rows={4} label="Loading risk score" />;
  return <RiskDetails risk={risk.data} />;
}

function RiskDetails({ risk }: { risk: AddressRisk }) {
  const max = Math.max(...risk.factors.map((f) => Math.abs(f.impact)), 0);
  const factors = [...risk.factors].sort((a, b) => b.impact - a.impact);
  const typologyKnown = risk.typology !== null;
  return (
    <div className="space-y-5">
      <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,15rem)_1fr]">
        <RiskGauge score={risk.score} band={risk.band} />
        <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Typology</dt>
          <dd data-testid="typology">{typologyKnown ? <span className="capitalize">{risk.typology!.replace(/_/g, ' ')}</span> : <span className="text-muted-foreground">Unavailable</span>}</dd>
          <dt className="text-muted-foreground">Confidence</dt>
          <dd data-testid="typology-confidence">{risk.typologyConfidence === null ? <span className="text-muted-foreground">Not returned</span> : pct(risk.typologyConfidence)}</dd>
          <dt className="text-muted-foreground">Scored</dt>
          <dd>{formatWhen(Date.parse(risk.createdAt))}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd className="font-mono text-xs">{risk.modelVersion}</dd>
        </dl>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-semibold">Model factors</h4>
        {factors.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-reasons">
            The model returned no risk-raising reasons for this wallet.
          </p>
        ) : (
          <>
            <ul aria-label="Reasons" className="space-y-3">
              {factors.map((f) => (
                <li key={f.feature} data-testid="reason">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span>{f.reason}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">+{f.impact.toFixed(3)}</span>
                  </div>
                  <div className="mt-1 h-2 rounded bg-muted" role="img" aria-label={`Contribution ${f.impact.toFixed(3)}, ${max > 0 ? Math.round((Math.abs(f.impact) / max) * 100) : 0} percent of the largest reason`}>
                    <div className="h-2 rounded bg-primary" style={{ width: `${max > 0 ? Math.max(3, (Math.abs(f.impact) / max) * 100) : 0}%` }} />
                  </div>
                  <div className="mt-0.5 text-[0.7rem] text-muted-foreground">
                    Model feature <span className="font-mono">{f.feature}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {factors.length} {factors.length === 1 ? 'factor' : 'factors'} returned by the risk model; the longest bar is the largest returned impact. The API returns no separate feature values and no evidence links, so these reasons are the model&apos;s statements, not independently verified here.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Only the `overrides` the risk endpoint returned. Nothing else is shown as checked, and no source or fetch time is claimed. */
function OverridesSection({ risk }: { risk: ReturnType<typeof useAddressRisk> }) {
  if (!risk.data) return <p className="text-sm text-muted-foreground">Overrides come from the risk model and are unavailable while the risk score is {risk.isError ? 'unavailable' : 'not loaded'}.</p>;
  const overrides = risk.data.overrides;
  if (overrides.length === 0)
    return (
      <p className="text-sm" data-testid="no-flags">
        No overrides returned by the risk model.
      </p>
    );
  return (
    <ul aria-label="Overrides" className="divide-y rounded-md border text-sm">
      {overrides.map((o) => (
        <li key={o} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span>{OVERRIDE_LABELS[o] ?? o}</span>
          <span className="font-mono text-xs text-muted-foreground">{o}</span>
        </li>
      ))}
    </ul>
  );
}

function ActivitySection({ graph, node }: { graph: GraphModel; node: GNode }) {
  const transfers = walletTransfers(graph, node);
  if (transfers.length === 0) return <p className="text-sm text-muted-foreground">No transfers for this wallet in the loaded trace.</p>;
  const days = dailyActivity(transfers).map((d) => ({ ...d, label: d.day.slice(5) }));
  const shown = transfers.slice(-50);
  return (
    <div className="space-y-3">
      <div role="img" aria-label={`Activity by day (IST): ${days.map((d) => `${d.day} in ${d.inUsd.toFixed(0)} out ${d.outUsd.toFixed(0)} USD`).join('; ')}`} className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 176 }}>
          <BarChart data={days} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
            <XAxis dataKey="label" tick={axisTick} stroke="hsl(var(--border))" />
            <YAxis width={44} tick={axisTick} stroke="hsl(var(--border))" />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => [formatUsdValue(Number(v))]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="inUsd" name="Inbound (USD)" fill="hsl(var(--primary))" isAnimationActive={false} />
            <Bar dataKey="outUsd" name="Outbound (USD)" fill="hsl(var(--risk-medium))" isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ol aria-label="Transfers" className="max-h-56 divide-y overflow-y-auto rounded-md border text-xs">
        {shown.map((t) => (
          <li key={t.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
            <span className={cn('w-16 shrink-0 font-semibold', t.direction === 'in' ? 'text-primary' : 'text-risk-medium')}>{t.direction === 'in' ? '↓ Inbound' : '↑ Outbound'}</span>
            <span className="tabular-nums">
              {formatUsdValue(t.usd)} <span className="text-muted-foreground">({t.amount} {t.token})</span>
            </span>
            <span className="text-muted-foreground">{formatWhen(t.ts)}</span>
            <span className="w-full text-muted-foreground">
              {t.direction === 'in' ? 'from' : 'to'} <span className="font-mono">{shortAddr(t.counterparty)}</span> · tx <span className="font-mono">{shortAddr(t.txHash)}</span>
              {t.crossChain ? ' · cross-chain' : ''}
            </span>
          </li>
        ))}
      </ol>
      {transfers.length > shown.length && <p className="text-xs text-muted-foreground">Showing the latest {shown.length} of {transfers.length} transfers.</p>}
    </div>
  );
}

function CounterpartiesSection({ graph, node }: { graph: GraphModel; node: GNode }) {
  const rows = counterparties(graph, node);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No counterparties for this wallet in the loaded trace.</p>;
  return (
    <div className="table-scroll relative">
      <table className="w-full min-w-max border-collapse text-xs">
        <caption className="sr-only">Counterparties of this wallet in this trace</caption>
        <thead className="bg-muted/60 text-left uppercase tracking-wide text-muted-foreground">
          <tr>
            {['Counterparty', 'Chain', 'Direction', 'Transfers', 'In (USD)', 'Out (USD)', 'Latest'].map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((c) => {
            const url = explorerUrl(c.chain, c.address);
            return (
              <tr key={c.id}>
                <td className="px-3 py-2">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" title={c.address}>
                      {shortAddr(c.address)}
                      <span className="sr-only"> (opens explorer)</span>
                    </a>
                  ) : (
                    <span className="font-mono">{shortAddr(c.address)}</span>
                  )}
                  {c.label && <div className="text-muted-foreground">{c.label}</div>}
                </td>
                <td className="px-3 py-2">{c.chain}</td>
                <td className="px-3 py-2">{c.inCount > 0 && c.outCount > 0 ? 'In and out' : c.inCount > 0 ? 'Sent to this wallet' : 'Received from this wallet'}</td>
                <td className="px-3 py-2 tabular-nums">{c.transfers}</td>
                <td className="px-3 py-2 tabular-nums">{formatUsdValue(c.inUsd)}</td>
                <td className="px-3 py-2 tabular-nums">{formatUsdValue(c.outUsd)}</td>
                <td className="whitespace-nowrap px-3 py-2">{formatWhen(c.latest)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** No backend endpoint records feedback on a model label, so these controls are display-only and disabled: nothing is sent or stored. */
function LabelFeedback() {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled aria-describedby="label-feedback-note">
          <ThumbsUp className="size-4" aria-hidden="true" /> Confirm label
        </Button>
        <Button type="button" size="sm" variant="outline" disabled aria-describedby="label-feedback-note">
          <ThumbsDown className="size-4" aria-hidden="true" /> Dispute label
        </Button>
      </div>
      <p id="label-feedback-note" className="text-xs text-muted-foreground" data-testid="label-review-note">
        Feedback action unavailable: backend endpoint not provided.
      </p>
    </div>
  );
}

export interface WalletProfileProps {
  node: GNode | null;
  graph: GraphModel;
  traceId: string;
  onClose: () => void;
}

/** F5 wallet profile, opened from the F4 graph for one wallet. The risk request is made here, on open, for this wallet only. */
export function WalletProfile({ node, graph, traceId, onClose }: WalletProfileProps) {
  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
      {node && (
        <DialogContent title={`Wallet profile ${shortAddr(node.addr)}`} description="Risk score, reasons, flags, activity and counterparties for the selected wallet" variant="right" className="p-0">
          <ProfileBody node={node} graph={graph} traceId={traceId} onClose={onClose} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ProfileBody({ node, graph, traceId, onClose }: { node: GNode; graph: GraphModel; traceId: string; onClose: () => void }) {
  const risk = useAddressRisk(node.chain, node.addr, traceId, true);
  const [copied, setCopied] = useState(false);
  const url = explorerUrl(node.chain, node.addr);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.addr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable: the address is selectable text above */
    }
  };
  return (
    <div className="space-y-4 p-4 sm:p-5" data-testid="wallet-profile">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Wallet profile</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {node.chain in CHAINS ? <ChainBadge chain={node.chain} /> : <StatusBadge tone="neutral">{node.chain}</StatusBadge>}
            {node.role === 'vasp' && <StatusBadge tone="info">VASP{node.label ? ` · ${node.label}` : ''}</StatusBadge>}
          </div>
          <p className="mono-id mt-2 select-all">{node.addr}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label="Close wallet profile" onClick={onClose}>
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />} {copied ? 'Copied' : 'Copy address'}
        </Button>
        {url ? (
          <Button asChild size="sm" variant="outline">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" aria-hidden="true" /> Open in explorer
            </a>
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled>
            No explorer for {node.chain}
          </Button>
        )}
      </div>

      <Section title="Risk" hint="Returned by the risk model for this wallet when opened, using the case trace as context.">
        <RiskSection risk={risk} chain={node.chain} />
      </Section>
      <Section title="Overrides" hint="Rule overrides the risk model reports having applied. Only what the model returned is listed.">
        <OverridesSection risk={risk} />
      </Section>
      <Section title="Activity in this trace" hint="Inbound and outbound transfers of this wallet in the loaded trace only (IST). The backend provides no wallet-wide history.">
        <ActivitySection graph={graph} node={node} />
      </Section>
      <Section title="Counterparties in this trace" hint="Aggregated from this wallet's transfers in the loaded trace only, not from any wider wallet history.">
        <CounterpartiesSection graph={graph} node={node} />
      </Section>
      <Section title="Label feedback">
        <LabelFeedback />
      </Section>
    </div>
  );
}
