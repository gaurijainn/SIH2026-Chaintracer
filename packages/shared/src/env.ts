import { z } from 'zod';

const schema = z.object({
  DATA_MODE: z.enum(['live', 'record', 'replay']).default('replay'),
  TRONGRID_KEY: z.string().default(''),
  TRONSCAN_KEY: z.string().default(''),
  ETHERSCAN_KEY: z.string().default(''),
  MEGANODE_KEY: z.string().default(''),
  BLOCKSCOUT_KEY: z.string().default(''),
  ALCHEMY_KEY: z.string().default(''),
  CHAINABUSE_KEY: z.string().default(''),
  COINGECKO_DEMO_KEY: z.string().default(''),
  ANKR_KEY: z.string().default(''),
  DATABASE_URL: z.string().default('postgresql://ps26183:ps26183@localhost:5432/ps26183'),
  NEO4J_URI: z.string().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default('ps26183-neo4j'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ML_URL: z.string().default('http://localhost:8000'),
  // B10: JWT_SECRET must be >= 32 chars and PII_ENC_KEY a 32-byte key (64 hex chars or base64); the API refuses to
  // start with the 'change-me' placeholder (see apps/api/src/auth/config.ts).
  JWT_SECRET: z.string().default('change-me'),
  PII_ENC_KEY: z.string().default('change-me'),
  JWT_ACCESS_TTL_S: z.coerce.number().int().min(30).default(900),
  JWT_REFRESH_TTL_S: z.coerce.number().int().min(60).default(604800),
  // Comma-separated browser origins allowed by CORS (the Vite dev server by default).
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  RATE_LIMIT_WINDOW_S: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
  TRACE_MAX_HOPS: z.coerce.number().int().default(6),
  TRACE_MIN_USD: z.coerce.number().default(10),
  TRACE_WINDOW_DAYS: z.coerce.number().int().default(30),
  TRACE_TOP_K: z.coerce.number().int().default(10),
  HIGH_DEGREE_CUTOFF: z.coerce.number().int().default(5000),
  TRON_BACKUP_URL: z.string().default('https://rpc.ankr.com/http/tron'), // Chainstack/Ankr TRON full node (include key in the URL)
  PROVIDER_LIMITS: z.string().default(''), // optional JSON overriding per-provider rate limits
  NCRP_BASE_URL: z.string().default('http://localhost:4010'),
  NCRP_POLL_INTERVAL_S: z.coerce.number().int().min(0).default(0), // 0 = poller off
  // B9: outbound freeze-notice submission (SahyogAdapter) and outbound NCRP notice/sync (NcrpNoticeAdapter).
  // Both are sandbox-only -- there is no real SAHYOG endpoint to call regardless of SAHYOG_MODE.
  SAHYOG_BASE_URL: z.string().default('http://localhost:4011'),
  SAHYOG_MODE: z.enum(['sandbox', 'real']).default('sandbox'),
  API_PORT: z.coerce.number().int().default(4000),
  FIXTURES_DIR: z.string().default('fixtures'),
  // B8: live ETH (chainid=1) USDT monitoring stays disabled until someone manually confirms the USDT
  // contract address against Etherscan and flips this -- see workers/src/index.ts's USDT_EVM comment.
  ETH_USDT_CONTRACT_VERIFIED: z.enum(['true', 'false']).default('false'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Treat empty strings as unset so `KEY=` lines in .env fall back to defaults.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  return schema.parse(cleaned);
}
