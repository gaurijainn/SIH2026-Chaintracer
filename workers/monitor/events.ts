import type { Redis } from 'ioredis';
import { ALERT_EVENTS_CHANNEL, type AlertEventEnvelope } from '@ps26183/shared';

/** Publishes one alert.new event; apps/api subscribes on the same channel and relays it to Socket.IO. */
export type AlertEventPublisher = (e: AlertEventEnvelope) => Promise<void>;

export function redisAlertPublisher(redis: Pick<Redis, 'publish'>): AlertEventPublisher {
  return async (e) => {
    await redis.publish(ALERT_EVENTS_CHANNEL, JSON.stringify(e));
  };
}
