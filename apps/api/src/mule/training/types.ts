import type { Chain } from '@ps26183/shared';
import type { MuleFeatureInputs } from '../features';
import type { MuleFeatures } from '../types';

/**
 * Plan B7.4/label-noise rule: only two label values ever come out of the TRON bootstrap ("Label
 * 'high-risk', not 'criminal'"). "unknown" is never a value a source can assert — it only ever
 * arises downstream (B7.2's DatasetLabel.UNKNOWN) for addresses with no confirmed label at all —
 * so "never convert UNKNOWN into positive or negative" is enforced by this type itself: there is no
 * way to construct a BootstrapLabelRow with an unknown label in the first place.
 */
export type BootstrapLabelValue = 'high_risk' | 'licit';

export interface BootstrapLabelRow {
  /** raw, exactly as recorded by the source; normalized during the join, never mutated here. */
  address: string;
  chain: Chain;
  label: BootstrapLabelValue;
  /** e.g. 'usdt_blacklist' | 'ofac' | 'chainabuse' | 'tronscan' | 'manual_negative'. */
  source: string;
  /** ISO-8601 UTC: when the source recorded this label (ground truth for the temporal split). */
  fetchedAt: string;
  evidence?: unknown;
  /** 0..1, exactly as given by the source; never invented or defaulted. */
  confidence: number;
}

export type ConfidenceTier = 'strong' | 'moderate' | 'weak';

export interface TronTrainingRow {
  identifier: string;
  chain: Chain;
  label: BootstrapLabelValue;
  source: string;
  confidence: number;
  /** informational classification of `confidence`, so downstream training prep can distinguish
   * confirmed/strong evidence (e.g. a direct OFAC hit) from a weaker signal (e.g. one unverified
   * Chainabuse report) without discarding the weaker one (plan: "a blacklist signal must remain
   * evidence, not proof"). */
  confidenceTier: ConfidenceTier;
  evidence: unknown;
  /** preserved exactly from the winning label's fetchedAt. */
  timestamp: string;
  /** B6's real computeMuleFeatures() output for this address -- never recomputed or approximated here. */
  features: MuleFeatures;
}

export interface LabelConflict {
  chain: Chain;
  address: string;
  /** every conflicting entry, untouched, so a human can review and resolve it -- never silently merged. */
  entries: BootstrapLabelRow[];
}

export interface TracedAddressProvider {
  /** every normalized address B6 currently has trace/hop data for, on this chain. */
  listTracedAddresses(chain: Chain): string[];
  /** B6 feature inputs for one already-traced address, or null when it has never been traced
   * (never invented -- the join must not fabricate a feature vector for an unmatched address). */
  getFeatureInputs(chain: Chain, addr: string): MuleFeatureInputs | null;
}

/**
 * Given every entry recorded for one address with genuinely conflicting label values, either
 * returns the single entry that should win (a deterministic, explicit resolution) or null to
 * refuse (the default policy: every conflict is rejected unless a resolver explicitly says
 * otherwise -- see sourcePriorityResolver).
 */
export type ConflictResolver = (entries: BootstrapLabelRow[]) => BootstrapLabelRow | null;

export interface JoinReport {
  rows: TronTrainingRow[];
  /** had a confirmed label, but the address has never been traced -- no feature vector exists. */
  unmatchedLabels: BootstrapLabelRow[];
  /** traced by B6, but no confirmed bootstrap label exists for it. */
  untracedAddresses: { chain: Chain; address: string }[];
  /** contradictory labels for the same address that could not be deterministically resolved. */
  conflicts: LabelConflict[];
  /** failed to normalize for their stated chain (e.g. a malformed address) -- never guessed. */
  invalidAddresses: BootstrapLabelRow[];
}
