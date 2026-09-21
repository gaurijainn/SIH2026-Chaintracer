export type Chain = 'TRON' | 'ETH' | 'BSC' | 'POLYGON' | 'BTC';
export type DataMode = 'live' | 'record' | 'replay';

/** Official stablecoin contracts only (fake-token guard, B2). */
export const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export const QUEUES = ['intake', 'trace-tron', 'trace', 'monitor', 'report'] as const;

/** TRON seeds go straight onto their own queue (fast path); every other chain uses the generic one. */
export const TRACE_QUEUE_TRON = 'trace-tron';
export const TRACE_QUEUE_DEFAULT = 'trace';
/** BullMQ priority: lower number runs first. */
export const TRACE_PRIORITY: Record<Chain, number> = { TRON: 1, ETH: 2, BSC: 2, POLYGON: 2, BTC: 3 };
export const WORKER_HEARTBEAT_KEY = 'workers:heartbeat';
export const WORKER_HEARTBEAT_TTL_S = 15;
