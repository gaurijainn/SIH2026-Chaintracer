import type { Server as HttpServer } from 'node:http';
import { Redis } from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { ALERT_EVENTS_CHANNEL, TRACE_EVENTS_CHANNEL, type AlertEventEnvelope, type TraceEventEnvelope } from '@ps26183/shared';

type RelayEnvelope = TraceEventEnvelope | AlertEventEnvelope;

/**
 * B4/B8 real-time transport. The trace worker publishes trace.progress/trace.hop/trace.completed on
 * TRACE_EVENTS_CHANNEL (workers/trace/events.ts); the B8 monitor worker publishes alert.new on
 * ALERT_EVENTS_CHANNEL (workers/monitor/events.ts) the same way. This subscribes to both channels
 * once per API process and relays every event into a Socket.IO room scoped to its case, so the
 * dashboard only sees events for cases it has joined.
 */
export function attachTraceSocket(httpServer: HttpServer, redisUrl: string): { io: SocketIOServer; close: () => Promise<void> } {
  const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
  const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  sub.on('error', (e) => console.error('trace socket redis error', e));

  io.on('connection', (socket) => {
    socket.on('join', (caseId: unknown) => {
      if (typeof caseId === 'string' && caseId) socket.join(`case:${caseId}`);
    });
    socket.on('leave', (caseId: unknown) => {
      if (typeof caseId === 'string' && caseId) socket.leave(`case:${caseId}`);
    });
  });

  Promise.all([sub.subscribe(TRACE_EVENTS_CHANNEL), sub.subscribe(ALERT_EVENTS_CHANNEL)]).catch((e) =>
    console.error('realtime socket subscribe failed', e),
  );
  sub.on('message', (_channel, message) => {
    let envelope: RelayEnvelope;
    try {
      envelope = JSON.parse(message) as RelayEnvelope;
    } catch {
      return;
    }
    io.to(`case:${envelope.payload.caseId}`).emit(envelope.event, envelope.payload);
  });

  return {
    io,
    close: async () => {
      sub.disconnect();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
