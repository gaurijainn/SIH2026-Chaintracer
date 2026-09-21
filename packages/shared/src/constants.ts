export type Chain = 'TRON' | 'ETH' | 'BSC' | 'POLYGON' | 'BTC';
export type DataMode = 'live' | 'record' | 'replay';

/** Official stablecoin contracts only (fake-token guard, B2). */
export const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export const QUEUES = ['intake', 'trace', 'monitor', 'report'] as const;
export const WORKER_HEARTBEAT_KEY = 'workers:heartbeat';
export const WORKER_HEARTBEAT_TTL_S = 15;
