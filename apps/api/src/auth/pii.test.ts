import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadSecurityConfig, parsePiiKey } from './config';
import { PiiDecryptionError } from './errors';
import { FIR_PII_CONTEXT, PiiCipher } from './pii';
import { loadEnv } from '@ps26183/shared';

const key = () => randomBytes(32);

describe('PiiCipher (AES-256-GCM)', () => {
  it('round-trips and never stores the plaintext in the envelope', () => {
    const c = new PiiCipher(key());
    const env = c.encrypt('FIR/123/2026', FIR_PII_CONTEXT);
    expect(env).toMatch(/^enc:v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(env).not.toContain('FIR/123/2026');
    expect(c.decrypt(env, FIR_PII_CONTEXT)).toBe('FIR/123/2026');
  });

  it('uses a fresh IV per value (same plaintext, different ciphertext)', () => {
    const c = new PiiCipher(key());
    expect(c.encrypt('x', 'ctx')).not.toBe(c.encrypt('x', 'ctx'));
  });

  it('fails authentication with the wrong key', () => {
    const env = new PiiCipher(key()).encrypt('secret', FIR_PII_CONTEXT);
    expect(() => new PiiCipher(key()).decrypt(env, FIR_PII_CONTEXT)).toThrow(PiiDecryptionError);
  });

  it('fails authentication when the ciphertext is moved to another field (AAD context)', () => {
    const c = new PiiCipher(key());
    const env = c.encrypt('secret', 'Case.firNumber');
    expect(() => c.decrypt(env, 'Complaint.somethingElse')).toThrow(PiiDecryptionError);
  });

  it('detects tampering with the IV, tag or ciphertext', () => {
    const c = new PiiCipher(key());
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    const parts = c.encrypt('secret', 'ctx').split(':'); // ['enc', 'v1', iv, tag, ct]
    for (const i of [2, 3, 4]) {
      const t = [...parts];
      t[i] = flip(t[i]);
      expect(() => c.decrypt(t.join(':'), 'ctx')).toThrow(PiiDecryptionError);
    }
  });

  it('rejects malformed input and non-32-byte keys', () => {
    const c = new PiiCipher(key());
    expect(() => c.decrypt('plain', 'ctx')).toThrow(PiiDecryptionError);
    expect(() => c.decrypt('enc:v1:only-one-part', 'ctx')).toThrow(PiiDecryptionError);
    expect(() => new PiiCipher(Buffer.alloc(16))).toThrow();
  });

  it('nullable helpers: null stays null, legacy plaintext passes through decrypt', () => {
    const c = new PiiCipher(key());
    expect(c.encryptNullable(null, 'ctx')).toBeNull();
    expect(c.decryptNullable(null, 'ctx')).toBeNull();
    expect(c.decryptNullable('FIR-OLD-PLAINTEXT', 'ctx')).toBe('FIR-OLD-PLAINTEXT');
    expect(PiiCipher.isEncrypted(c.encryptNullable('v', 'ctx'))).toBe(true);
  });
});

describe('security config', () => {
  const base = { JWT_SECRET: 'j'.repeat(40), PII_ENC_KEY: 'ab'.repeat(32) };

  it('parses hex and base64 32-byte keys and rejects anything else', () => {
    expect(parsePiiKey('ab'.repeat(32))).toHaveLength(32);
    expect(parsePiiKey(randomBytes(32).toString('base64'))).toHaveLength(32);
    expect(() => parsePiiKey('too-short')).toThrow(/32-byte/);
  });

  it('refuses the change-me placeholders and short JWT secrets', () => {
    expect(() => loadSecurityConfig(loadEnv({ ...base, JWT_SECRET: 'change-me' }))).toThrow(/JWT_SECRET/);
    expect(() => loadSecurityConfig(loadEnv({ ...base, JWT_SECRET: 'short' }))).toThrow(/JWT_SECRET/);
    expect(() => loadSecurityConfig(loadEnv({ ...base, PII_ENC_KEY: 'change-me' }))).toThrow(/PII_ENC_KEY/);
  });

  it('builds a config with a CORS allowlist and rate-limit settings from env', () => {
    const c = loadSecurityConfig(loadEnv({ ...base, CORS_ORIGINS: 'https://a.example, https://b.example', RATE_LIMIT_MAX: '50' }));
    expect(c.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(c.rateLimit.max).toBe(50);
    expect(c.piiKey).toHaveLength(32);
  });
});
