/**
 * B8 alert-rule thresholds and polling tiers. Every number the plan describes in prose ("above a
 * threshold", "hot = 30s / warm = 5min / cold = hourly") is a named, overridable field here rather
 * than a magic number buried in a rule or poller -- mirrors the B6 config pattern (mule/config.ts).
 */
export interface MonitorConfig {
  a1Movement: {
    /** USD at/above this on a watched-wallet send is MEDIUM severity. */
    mediumUsd: number;
    /** USD at/above this on a watched-wallet send is HIGH severity. */
    highUsd: number;
  };
  tierPollIntervalMs: {
    HOT: number;
    WARM: number;
    COLD: number;
  };
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  a1Movement: { mediumUsd: 1_000, highUsd: 10_000 },
  tierPollIntervalMs: {
    HOT: 30_000, // 30s
    WARM: 5 * 60_000, // 5min
    COLD: 60 * 60_000, // hourly
  },
};

/** BullMQ repeat cadence for the TRON polling job -- the finest tier, so due-checks never miss a HOT window. */
export const TRON_POLL_JOB_INTERVAL_MS = 30_000;
