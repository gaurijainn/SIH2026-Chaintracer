import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { createRealtimeSocket } from '@/lib/realtime';
import { parseHopEvent, type HopEvent } from './model';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting';

const progressSchema = z.object({ traceId: z.string(), hopsDone: z.number().int().nonnegative(), frontier: z.number().int().nonnegative(), apiCalls: z.number().int().nonnegative() });
const completedSchema = z.object({
  traceId: z.string(),
  durationMs: z.number().nonnegative(),
  terminals: z.array(z.object({ chain: z.string(), addr: z.string(), reason: z.string(), label: z.string().optional() })),
});
export type LiveProgress = z.infer<typeof progressSchema>;
export type LiveCompleted = z.infer<typeof completedSchema>;

/**
 * Live trace mode over the existing Socket.IO relay. The relay delivers trace.* events to the `case:<caseId>` room, so the
 * socket joins that room on every (re)connect. Only events for the trace on screen are used. Handlers are kept in a ref so
 * the socket is created once per (case, trace) and torn down (listeners off, socket closed) on unmount, which also keeps
 * React StrictMode from leaving a second listener behind. Duplicate hops are made harmless by mergeHop's edge-key check.
 */
export function useLiveTrace(caseId: string, traceId: string | null, onHop: (ev: HopEvent) => void) {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [progress, setProgress] = useState<LiveProgress | null>(null);
  const [completed, setCompleted] = useState<LiveCompleted | null>(null);
  const hopRef = useRef(onHop);
  hopRef.current = onHop;

  useEffect(() => {
    setProgress(null);
    setCompleted(null);
    if (!traceId) return;
    const socket = createRealtimeSocket();
    const join = () => socket.emit('join', caseId);
    const onConnect = () => {
      setStatus('connected');
      join(); // rooms are lost when a socket drops
    };
    const onDown = () => setStatus('reconnecting');
    const onHopEvent = (raw: unknown) => {
      const ev = parseHopEvent(raw);
      if (ev && ev.traceId === traceId) hopRef.current(ev);
    };
    const onProgress = (raw: unknown) => {
      const p = progressSchema.safeParse(raw);
      if (p.success && p.data.traceId === traceId) setProgress(p.data);
    };
    const onCompleted = (raw: unknown) => {
      const c = completedSchema.safeParse(raw);
      if (c.success && c.data.traceId === traceId) setCompleted(c.data);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDown);
    socket.on('connect_error', onDown);
    socket.on('trace.hop', onHopEvent);
    socket.on('trace.progress', onProgress);
    socket.on('trace.completed', onCompleted);
    if (socket.connected) onConnect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDown);
      socket.off('connect_error', onDown);
      socket.off('trace.hop', onHopEvent);
      socket.off('trace.progress', onProgress);
      socket.off('trace.completed', onCompleted);
      socket.emit('leave', caseId);
      socket.disconnect();
    };
  }, [caseId, traceId]);

  return { status, progress, completed };
}
