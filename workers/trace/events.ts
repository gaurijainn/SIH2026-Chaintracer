import type { Redis } from 'ioredis';
import { TRACE_EVENTS_CHANNEL, type TraceEventEnvelope } from '@ps26183/shared';

/** Publishes one trace.* event; apps/api subscribes on the same channel and relays it to Socket.IO. */
export type TraceEventPublisher = (e: TraceEventEnvelope) => Promise<void>;

export function redisEventPublisher(redis: Pick<Redis, 'publish'>): TraceEventPublisher {
  return async (e) => {
    await redis.publish(TRACE_EVENTS_CHANNEL, JSON.stringify(e));
  };
}
