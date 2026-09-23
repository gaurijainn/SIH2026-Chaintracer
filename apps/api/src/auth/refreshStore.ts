import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export const hashJti = (jti: string): string => createHash('sha256').update(jti).digest('hex');

export type ConsumeResult = { status: 'ok'; userId: string } | { status: 'reused'; userId: string } | { status: 'unknown' };

/**
 * Server-side state for refresh-token rotation. Keys are SHA-256(jti) -- neither the token nor its id is
 * stored in plaintext. `consume` is single-use: presenting an already-rotated token is reported as
 * `reused`, which AuthService treats as theft and answers by revoking every refresh token of that user.
 */
export interface RefreshStore {
  save(jtiHash: string, userId: string, ttlS: number): Promise<void>;
  consume(jtiHash: string): Promise<ConsumeResult>;
  revokeUser(userId: string): Promise<void>;
}

export class InMemoryRefreshStore implements RefreshStore {
  private active = new Map<string, { userId: string; expires: number }>();
  private used = new Map<string, { userId: string; expires: number }>();

  async save(jtiHash: string, userId: string, ttlS: number) {
    this.active.set(jtiHash, { userId, expires: Date.now() + ttlS * 1000 });
  }

  async consume(jtiHash: string): Promise<ConsumeResult> {
    const a = this.active.get(jtiHash);
    if (a && a.expires > Date.now()) {
      this.active.delete(jtiHash);
      this.used.set(jtiHash, a);
      return { status: 'ok', userId: a.userId };
    }
    const u = this.used.get(jtiHash);
    return u && u.expires > Date.now() ? { status: 'reused', userId: u.userId } : { status: 'unknown' };
  }

  async revokeUser(userId: string) {
    for (const [k, v] of this.active) if (v.userId === userId) this.active.delete(k);
  }
}

/** Redis-backed store (uses the same Redis the queues already run on). GETDEL makes `consume` atomic. */
export class RedisRefreshStore implements RefreshStore {
  constructor(private readonly redis: Redis) {}

  async save(jtiHash: string, userId: string, ttlS: number) {
    await this.redis
      .multi()
      .set(`rt:${jtiHash}`, userId, 'EX', ttlS)
      .sadd(`rtu:${userId}`, jtiHash)
      .expire(`rtu:${userId}`, ttlS)
      .exec();
  }

  async consume(jtiHash: string): Promise<ConsumeResult> {
    const userId = await this.redis.getdel(`rt:${jtiHash}`);
    if (userId) {
      // remember the rotated id until it would have expired anyway, so replaying it is detectable
      await this.redis.multi().set(`rtused:${jtiHash}`, userId, 'EX', 7 * 24 * 3600).srem(`rtu:${userId}`, jtiHash).exec();
      return { status: 'ok', userId };
    }
    const reusedBy = await this.redis.get(`rtused:${jtiHash}`);
    return reusedBy ? { status: 'reused', userId: reusedBy } : { status: 'unknown' };
  }

  async revokeUser(userId: string) {
    const hashes = await this.redis.smembers(`rtu:${userId}`);
    if (hashes.length) await this.redis.del(...hashes.map((h) => `rt:${h}`));
    await this.redis.del(`rtu:${userId}`);
  }
}
