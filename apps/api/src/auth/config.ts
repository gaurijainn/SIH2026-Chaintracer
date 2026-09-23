import type { Env } from '@ps26183/shared';

export interface SecurityConfig {
  jwtSecret: string;
  accessTtlS: number;
  refreshTtlS: number;
  corsOrigins: string[];
  rateLimit: { windowS: number; max: number; authMax: number };
  /** 32-byte AES-256-GCM key for application-layer PII encryption. */
  piiKey: Buffer;
}

const PLACEHOLDER = 'change-me';

/** Accepts a 32-byte key as 64 hex chars or base64 (44 chars). Anything else is a configuration error. */
export function parsePiiKey(raw: string): Buffer {
  const v = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (key.length !== 32) throw new Error('PII_ENC_KEY must be a 32-byte key encoded as 64 hex characters or base64 (generate one with: openssl rand -hex 32)');
  return key;
}

type SecurityEnv = Pick<
  Env,
  'JWT_SECRET' | 'PII_ENC_KEY' | 'JWT_ACCESS_TTL_S' | 'JWT_REFRESH_TTL_S' | 'CORS_ORIGINS' | 'RATE_LIMIT_WINDOW_S' | 'RATE_LIMIT_MAX' | 'RATE_LIMIT_AUTH_MAX'
>;

/**
 * Builds the B10 security config from env and refuses to boot with the placeholder/weak secrets from
 * .env.example, so a deployment can never silently run with a guessable JWT secret or PII key.
 */
export function loadSecurityConfig(env: SecurityEnv): SecurityConfig {
  if (env.JWT_SECRET === PLACEHOLDER || env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a random string of at least 32 characters (generate one with: openssl rand -hex 32)');
  }
  if (env.PII_ENC_KEY === PLACEHOLDER) throw new Error('PII_ENC_KEY is still the "change-me" placeholder; set a 32-byte key (openssl rand -hex 32)');
  return {
    jwtSecret: env.JWT_SECRET,
    accessTtlS: env.JWT_ACCESS_TTL_S,
    refreshTtlS: env.JWT_REFRESH_TTL_S,
    corsOrigins: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    rateLimit: { windowS: env.RATE_LIMIT_WINDOW_S, max: env.RATE_LIMIT_MAX, authMax: env.RATE_LIMIT_AUTH_MAX },
    piiKey: parsePiiKey(env.PII_ENC_KEY),
  };
}
