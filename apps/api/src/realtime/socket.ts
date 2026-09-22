import type { Server as HttpServer } from 'node:http';
import { Redis } from 'ioredis';
import { Server as SocketIOServer } from 'socket.io';
import { TRACE_EVENTS_CHANNEL, type TraceEventEnvelope } from '@ps26183/shared';

/**
 * B4 real-time transport. The trace worker (a separate process) publishes trace.progress/trace.hop/
 * trace.completed on a Redis channel (workers/trace/events.ts); this subscribes once per API process
 * and relays each event into a Socket.IO room scoped to its case, so the dashboard only sees events
 * for cases it has joined.
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

  sub.subscribe(TRACE_EVENTS_CHANNEL).catch((e) => console.error('trace socket subscribe failed', e));
  sub.on('message', (_channel, message) => {
    let envelope: TraceEventEnvelope;
    try {
      envelope = JSON.parse(message) as TraceEventEnvelope;
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
