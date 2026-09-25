import { formatDayMonth, formatIstDate, formatIstTime } from '@/lib/datetime';
import type { Chain } from '@/lib/tokens';
import type { AlertRow, AlertRule, AlertSeverity, CaseStatus, ComplaintItem } from './api';

export const CHAIN_ORDER: Chain[] = ['TRON', 'ETH', 'BSC', 'POLYGON', 'BTC'];
export const isChain = (v: unknown): v is Chain => typeof v === 'string' && (CHAIN_ORDER as string[]).includes(v);

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const count = new Intl.NumberFormat('en-IN');
export const formatInr = (n: number) => inr.format(n);
export const formatUsd = (n: number) => usd.format(n);
export const formatCount = (n: number) => count.format(n);
/** Calendar day from the API ("2026-09-23", already IST) as "23 Sep"; no timezone conversion. */
export const formatDay = (day: string) => formatDayMonth(day);
export const formatDate = (iso: string) => formatIstDate(iso);
export const formatTime = (ms: number) => formatIstTime(ms).replace(/ IST$/, '');

/** One case as the dashboard can know it: rolled up from its complaints in the loaded window. */
export interface CaseRow {
  id: string;
  title: string;
  status: CaseStatus;
  complaints: number;
  amountInr: number;
  chains: Chain[];
  lastReportedAt: string;
  alerts: number;
  topSeverity: AlertSeverity | null;
}

export const SEVERITIES: AlertSeverity[] = ['INFO', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const severityRank = (s: AlertSeverity | null) => (s ? SEVERITIES.indexOf(s) : -1);

const num = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export function buildCaseRows(complaints: ComplaintItem[], alerts: AlertRow[] = []): CaseRow[] {
  const byCase = new Map<string, CaseRow>();
  for (const c of complaints) {
    if (!c.case) continue;
    let row = byCase.get(c.case.id);
    if (!row) {
      row = { id: c.case.id, title: c.case.title, status: c.case.status, complaints: 0, amountInr: 0, chains: [], lastReportedAt: c.reportedAt, alerts: 0, topSeverity: null };
      byCase.set(c.case.id, row);
    }
    row.complaints += 1;
    row.amountInr += num(c.amountInr);
    if (c.reportedAt > row.lastReportedAt) row.lastReportedAt = c.reportedAt;
    for (const a of c.addresses) if (a.kind === 'ADDRESS' && isChain(a.chain) && !row.chains.includes(a.chain)) row.chains.push(a.chain);
  }
  for (const a of alerts) {
    const row = byCase.get(a.caseId);
    if (!row) continue;
    row.alerts += 1;
    if (severityRank(a.severity) > severityRank(row.topSeverity)) row.topSeverity = a.severity;
  }
  for (const r of byCase.values()) r.chains.sort((x, y) => CHAIN_ORDER.indexOf(x) - CHAIN_ORDER.indexOf(y));
  return [...byCase.values()].sort((a, b) => b.lastReportedAt.localeCompare(a.lastReportedAt) || a.id.localeCompare(b.id));
}

/** A2 landing alerts that named a VASP; the only place the API exposes a VASP identity next to a case. */
const landings = (alerts: AlertRow[]) => alerts.filter((a) => a.rule === 'A2_VASP_LANDING');
const vaspNameOf = (a: AlertRow) => (typeof a.metadata?.vaspName === 'string' && a.metadata.vaspName.trim() ? a.metadata.vaspName.trim() : null);

export interface AlertKpis {
  freezeWindowsOpen: number;
  freezeWindowCases: number;
}

/**
 * Freeze windows have no summary field, so they stay derived from alerts: A2 landing alerts flagged
 * metadata.freezeWindowOpen, not snoozed, on a case that is not CLOSED.
 */
export function computeAlertKpis(alerts: AlertRow[], complaints: ComplaintItem[] = []): AlertKpis {
  const closed = new Set(complaints.filter((c) => c.case?.status === 'CLOSED').map((c) => c.case!.id));
  const open = landings(alerts).filter((a) => a.metadata?.freezeWindowOpen === true && a.status !== 'SNOOZED' && !closed.has(a.caseId));
  return { freezeWindowsOpen: open.length, freezeWindowCases: new Set(open.map((a) => a.caseId)).size };
}

export interface Slice {
  key: string;
  label: string;
  value: number;
  percent: number;
}

/** Slices with percentages for a donut/legend, from backend `{key, count}` rows. */
export function toSlices(rows: { key: string; count: number }[]): Slice[] {
  const total = rows.reduce((n, r) => n + r.count, 0);
  return rows.map((r) => ({ key: r.key, label: r.key, value: r.count, percent: total ? (r.count / total) * 100 : 0 }));
}

export interface VaspRank {
  name: string;
  landings: number;
  cases: number;
  lastAt: string;
}

/** VASPs ranked by A2 landing alerts. Alert amounts are raw token units of mixed assets, so they are not summed or ranked. */
export function topVasps(alerts: AlertRow[], limit = 6): VaspRank[] {
  const by = new Map<string, { landings: number; cases: Set<string>; lastAt: string }>();
  for (const a of landings(alerts)) {
    const name = vaspNameOf(a);
    if (!name) continue;
    const e = by.get(name) ?? { landings: 0, cases: new Set<string>(), lastAt: a.createdAt };
    e.landings += 1;
    e.cases.add(a.caseId);
    if (a.createdAt > e.lastAt) e.lastAt = a.createdAt;
    by.set(name, e);
  }
  return [...by.entries()]
    .map(([name, e]) => ({ name, landings: e.landings, cases: e.cases.size, lastAt: e.lastAt }))
    .sort((a, b) => b.landings - a.landings || b.cases - a.cases || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export const RULE_LABELS: Record<AlertRule, string> = {
  A1_MOVEMENT: 'Movement',
  A2_VASP_LANDING: 'VASP landing',
  A3_OBFUSCATION: 'Obfuscation',
  A4_LINKAGE: 'Linkage',
  A5_BLACKLIST: 'Blacklist',
};

export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);
export const shortAddress = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
