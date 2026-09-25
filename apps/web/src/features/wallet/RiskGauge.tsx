import { RiskBadge } from '@/components/common/badges';
import { RISK_BANDS, type RiskBand } from '@/lib/tokens';
import { BAND_RANGES } from './derive';

const CX = 100;
const CY = 100;
const R = 78;
const point = (value: number, r = R) => {
  const a = Math.PI * (1 - value / 100); // 0 -> left, 100 -> right
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) };
};
const arc = (from: number, to: number) => {
  const a = point(from);
  const b = point(to);
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
};
const STROKE: Record<RiskBand, string> = { LOW: 'hsl(var(--risk-low))', MEDIUM: 'hsl(var(--risk-medium))', HIGH: 'hsl(var(--risk-high))', CRITICAL: 'hsl(var(--risk-critical))' };
const TAG: Record<RiskBand, string> = { LOW: 'LOW', MEDIUM: 'MED', HIGH: 'HIGH', CRITICAL: 'CRIT' };

/**
 * Score gauge. The band is the backend's (it can differ from the score range when an override forces it), shown as an
 * icon + word badge; the scale is labelled with numbers and band names, so the band never depends on colour alone.
 */
export function RiskGauge({ score, band }: { score: number; band: RiskBand }) {
  const needle = point(score, R - 14);
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 128" role="img" aria-label={`Risk score ${score} out of 100, ${RISK_BANDS[band].label} band`} className="w-full max-w-[260px]">
        {BAND_RANGES.map((r) => (
          <path key={r.band} d={arc(r.from, r.to === 100 ? 100 : r.to + 1)} fill="none" stroke={STROKE[r.band]} strokeWidth={r.band === band ? 16 : 9} strokeLinecap="butt" opacity={r.band === band ? 1 : 0.55} />
        ))}
        {BAND_RANGES.map((r) => {
          const p = point((r.from + (r.to === 100 ? 100 : r.to + 1)) / 2, R + 17);
          return (
            <text key={`t-${r.band}`} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" className="fill-muted-foreground" fontSize={8} fontWeight={r.band === band ? 700 : 400}>
              {TAG[r.band]}
            </text>
          );
        })}
        {[0, 30, 60, 80, 100].map((v) => {
          const p = point(v, R - 20);
          return (
            <text key={v} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" className="fill-muted-foreground" fontSize={7}>
              {v}
            </text>
          );
        })}
        <line x1={CX} y1={CY} x2={needle.x} y2={needle.y} stroke="hsl(var(--foreground))" strokeWidth={3} strokeLinecap="round" />
        <circle cx={CX} cy={CY} r={5} fill="hsl(var(--foreground))" />
        <text x={CX} y={CY + 22} textAnchor="middle" className="fill-foreground" fontSize={24} fontWeight={700}>
          {score}
        </text>
      </svg>
      <div className="-mt-1 flex items-center gap-2">
        <RiskBadge band={band} score={score} />
        <span className="text-xs text-muted-foreground">of 100</span>
      </div>
    </div>
  );
}
