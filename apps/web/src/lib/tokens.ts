import { AlertOctagon, AlertTriangle, CircleAlert, ShieldCheck, type LucideIcon } from 'lucide-react';

/**
 * Semantic lookups over the CSS tokens in index.css. Components read from here so a risk band or chain
 * looks the same everywhere. Class strings are written out in full so Tailwind can see them.
 */

export type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const RISK_BANDS: Record<RiskBand, { label: string; icon: LucideIcon; classes: string; meaning: string }> = {
  LOW: { label: 'Low', icon: ShieldCheck, classes: 'border-risk-low/40 bg-risk-low-soft text-risk-low', meaning: 'Low risk' },
  MEDIUM: { label: 'Medium', icon: CircleAlert, classes: 'border-risk-medium/40 bg-risk-medium-soft text-risk-medium', meaning: 'Medium risk' },
  HIGH: { label: 'High', icon: AlertTriangle, classes: 'border-risk-high/40 bg-risk-high-soft text-risk-high', meaning: 'High risk' },
  CRITICAL: { label: 'Critical', icon: AlertOctagon, classes: 'border-risk-critical/50 bg-risk-critical-soft text-risk-critical', meaning: 'Critical risk' },
};

export type Chain = 'TRON' | 'ETH' | 'BSC' | 'POLYGON' | 'BTC';

export const CHAINS: Record<Chain, { label: string; dot: string; text: string }> = {
  TRON: { label: 'TRON', dot: 'bg-chain-tron', text: 'text-chain-tron' },
  ETH: { label: 'ETH', dot: 'bg-chain-eth', text: 'text-chain-eth' },
  BSC: { label: 'BSC', dot: 'bg-chain-bsc', text: 'text-chain-bsc' },
  POLYGON: { label: 'POLYGON', dot: 'bg-chain-polygon', text: 'text-chain-polygon' },
  BTC: { label: 'BTC', dot: 'bg-chain-btc', text: 'text-chain-btc' },
};

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Status pills reuse the risk palette so "danger" always reads as the same red as CRITICAL. */
export const STATUS_TONES: Record<StatusTone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  info: 'border-info/40 bg-info-soft text-info',
  success: 'border-risk-low/40 bg-risk-low-soft text-risk-low',
  warning: 'border-risk-medium/40 bg-risk-medium-soft text-risk-medium',
  danger: 'border-risk-critical/50 bg-risk-critical-soft text-risk-critical',
};
