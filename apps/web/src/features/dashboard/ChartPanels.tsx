import { BarChart3, Landmark } from 'lucide-react';
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EmptyState } from '@/components/common/states';
import { SectionCard } from '@/components/common/cards';
import { CHAINS, type Chain } from '@/lib/tokens';
import { Boundary } from './Boundary';
import { useAlertRows, useDashboardSummary } from './api';
import { formatCount, formatDate, formatDay, toSlices, topVasps, type Slice, type VaspRank } from './metrics';

/** Charts read theme tokens through CSS variables so dark and light mode both work. Animation is off: no motion to opt out of. */
const tooltipStyle = { background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 6, color: 'hsl(var(--popover-foreground))', fontSize: 12 };
const axisTick = { fill: 'hsl(var(--muted-foreground))', fontSize: 12 };
const SIZE = { width: 320, height: 220 }; // first-paint size before ResponsiveContainer measures (and in jsdom)

/** Distinct chain colours come from the same tokens as ChainBadge; the ticker text beside each slice carries the meaning too. */
const knownChain = (c: string): c is Chain => c in CHAINS;
const chainFill = (c: string) => (knownChain(c) ? `hsl(var(--chain-${c.toLowerCase()}))` : 'hsl(var(--muted-foreground))');

export function TracesPerDayPanel() {
  const summary = useDashboardSummary();
  return (
    <SectionCard title="Traces per day" description="Trace jobs opened each day (IST)">
      <Boundary queries={[summary]}>
        {() => {
          const days = summary.data!.tracesPerDay;
          if (days.length === 0) return <EmptyState icon={BarChart3} title="No traces yet" description="Trace jobs appear here once complaints have been registered." className="py-8" />;
          const total = days.reduce((n, d) => n + d.count, 0);
          const busiest = days.reduce((m, d) => (d.count > m.count ? d : m));
          const data = days.map((d) => ({ ...d, label: formatDay(d.day) }));
          const summaryText = `Traces per day: ${days.map((d) => `${d.day} ${d.count}`).join(', ')}.`;
          return (
            <div>
              <div role="img" aria-label={summaryText} className="h-[220px] w-full">
                <ResponsiveContainer width="100%" height="100%" initialDimension={SIZE}>
                  <BarChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 4 }}>
                    <XAxis dataKey="label" tick={axisTick} stroke="hsl(var(--border))" interval="preserveStartEnd" />
                    <YAxis allowDecimals={false} width={32} tick={axisTick} stroke="hsl(var(--border))" />
                    <Tooltip cursor={{ fill: 'hsl(var(--accent))' }} contentStyle={tooltipStyle} labelFormatter={(_l, p) => String(p?.[0]?.payload?.day ?? _l)} formatter={(v) => [formatCount(Number(v)), 'Traces']} />
                    <Bar dataKey="count" name="Traces" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {formatCount(total)} {total === 1 ? 'trace' : 'traces'} over {days.length} {days.length === 1 ? 'day' : 'days'}; busiest {formatDay(busiest.day)} ({formatCount(busiest.count)}).
              </p>
              <ul aria-label="Traces per day" className="sr-only">
                {days.map((d) => (
                  <li key={d.day}>
                    {d.day}: {d.count}
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      </Boundary>
    </SectionCard>
  );
}

const typologyLabel = (t: string) => t.replace(/_/g, ' ');

export function TypologyMixPanel() {
  const summary = useDashboardSummary();
  return (
    <SectionCard title="Typology mix" description="Latest stored typology per scored address">
      <Boundary queries={[summary]}>
        {() => {
          const mix = summary.data!.typologyMix;
          if (mix.length === 0) return <EmptyState icon={BarChart3} title="No typologies yet" description="Typologies appear once addresses have been risk-scored." className="py-8" />;
          const slices = toSlices(mix.map((m) => ({ key: m.typology, count: m.count })));
          const data = slices.map((s) => ({ name: typologyLabel(s.key), count: s.value }));
          const summaryText = `Typology mix: ${slices.map((s) => `${typologyLabel(s.key)} ${s.value} (${s.percent.toFixed(0)}%)`).join(', ')}.`;
          return (
            <div>
              <div role="img" aria-label={summaryText} className="h-[200px] w-full">
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 200 }}>
                  <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 4 }}>
                    <XAxis type="number" allowDecimals={false} tick={axisTick} stroke="hsl(var(--border))" />
                    <YAxis type="category" dataKey="name" width={120} tick={axisTick} stroke="hsl(var(--border))" />
                    <Tooltip cursor={{ fill: 'hsl(var(--accent))' }} contentStyle={tooltipStyle} formatter={(v) => [formatCount(Number(v)), 'Addresses']} />
                    <Bar dataKey="count" name="Addresses" fill="hsl(var(--primary))" radius={[0, 3, 3, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <ul aria-label="Typology mix" className="mt-3 divide-y text-sm">
                {slices.map((s) => (
                  <li key={s.key} className="flex items-baseline justify-between gap-3 py-1.5">
                    <span className="min-w-0 truncate capitalize">{typologyLabel(s.key)}</span>
                    <span className="shrink-0 tabular-nums">
                      {formatCount(s.value)} <span className="text-xs text-muted-foreground">({s.percent.toFixed(0)}%)</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      </Boundary>
    </SectionCard>
  );
}

export function TopVaspsPanel() {
  const alerts = useAlertRows();
  return (
    <SectionCard title="Top destination VASPs" description="Exchanges where traced funds landed most often (VASP-landing alerts)">
      <Boundary queries={[alerts]}>
        {() => {
          const ranks = topVasps(alerts.data!);
          if (ranks.length === 0) return <EmptyState icon={Landmark} title="No VASP landings yet" description="When a watched wallet sends funds to an attributed exchange address, that exchange is ranked here." className="py-8" />;
          return <VaspBars ranks={ranks} />;
        }}
      </Boundary>
    </SectionCard>
  );
}

function VaspBars({ ranks }: { ranks: VaspRank[] }) {
  const summary = `Top destination VASPs by landing alerts: ${ranks.map((r) => `${r.name} ${r.landings}`).join(', ')}.`;
  return (
    <div>
      <div role="img" aria-label={summary} className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%" initialDimension={SIZE}>
          <BarChart data={ranks} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 4 }}>
            <XAxis type="number" allowDecimals={false} tick={axisTick} stroke="hsl(var(--border))" />
            <YAxis type="category" dataKey="name" width={110} tick={axisTick} stroke="hsl(var(--border))" />
            <Tooltip cursor={{ fill: 'hsl(var(--accent))' }} contentStyle={tooltipStyle} formatter={(v) => [formatCount(Number(v)), 'Landings']} />
            <Bar dataKey="landings" name="Landings" fill="hsl(var(--primary))" radius={[0, 3, 3, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul aria-label="Top destination VASPs" className="mt-3 divide-y text-sm">
        {ranks.map((r, i) => (
          <li key={r.name} className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground tabular-nums">{i + 1}. </span>
              {r.name}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {r.landings} {r.landings === 1 ? 'landing' : 'landings'} · {r.cases} {r.cases === 1 ? 'case' : 'cases'} · last {formatDate(r.lastAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChainSplitPanel() {
  const summary = useDashboardSummary();
  return (
    <SectionCard title="Chain split" description="Distinct suspect addresses per chain, from complaints">
      <Boundary queries={[summary]}>
        {() => {
          const slices = toSlices(summary.data!.chainSplit.map((c) => ({ key: c.chain, count: c.count })));
          if (slices.length === 0) return <EmptyState icon={BarChart3} title="No chain-resolved addresses yet" description="Register a complaint with a wallet address to see its chain here." className="py-8" />;
          return <ChainDonut slices={slices} />;
        }}
      </Boundary>
    </SectionCard>
  );
}

function ChainDonut({ slices }: { slices: Slice[] }) {
  const summary = `Chain split of suspect addresses: ${slices.map((s) => `${s.label} ${s.value} (${s.percent.toFixed(0)}%)`).join(', ')}.`;
  return (
    <div className="grid items-center gap-4 sm:grid-cols-2">
      <div role="img" aria-label={summary} className="h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 200, height: 200 }}>
          <PieChart>
            <Tooltip contentStyle={tooltipStyle} itemStyle={{ color: 'hsl(var(--popover-foreground))' }} formatter={(v, n) => [formatCount(Number(v)), String(n)]} />
            <Pie data={slices} dataKey="value" nameKey="label" innerRadius={48} outerRadius={80} paddingAngle={2} stroke="hsl(var(--card))" isAnimationActive={false}>
              {slices.map((s) => (
                <Cell key={s.key} fill={chainFill(s.key)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div>
        <ul aria-label="Chain split" className="space-y-1.5 text-sm">
          {slices.map((s) => (
            <li key={s.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-mono text-xs uppercase">
                <span className={`size-2.5 rounded-full ${knownChain(s.key) ? CHAINS[s.key].dot : 'bg-muted-foreground'}`} aria-hidden="true" />
                {s.label}
              </span>
              <span className="tabular-nums">
                {formatCount(s.value)} <span className="text-xs text-muted-foreground">({s.percent.toFixed(0)}%)</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
