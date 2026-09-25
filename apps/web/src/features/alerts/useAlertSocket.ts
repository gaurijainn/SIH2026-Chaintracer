import { useEffect, useMemo, useRef, useState } from 'react';
import { createRealtimeSocket } from '@/lib/realtime';
import { alertNewEventSchema, type AlertNewEvent } from './model';

export type AlertLiveStatus = 'off' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Listens for `alert.new` over the existing Socket.IO relay (createRealtimeSocket, as useLiveTrace and the dashboard feed do).
 * The relay only delivers a case's events to sockets that joined `case:<caseId>`, so the caller passes the cases to watch.
 * One socket lives for the page; changing the case set only joins/leaves rooms, so a filter change never reconnects. Rooms
 * are re-joined on every (re)connect because the server forgets them. Malformed payloads are dropped, never rendered.
 * Listeners are removed and the socket closed on unmount. With no cases the status is 'off' (nothing to listen to).
 */
export function useAlertSocket(caseIds: string[], onNew: (ev: AlertNewEvent) => void): { status: AlertLiveStatus } {
  const [status, setStatus] = useState<AlertLiveStatus>('connecting');
  const handler = useRef(onNew);
  handler.current = onNew;
  const wanted = useRef<Set<string>>(new Set());
  const joined = useRef<Set<string>>(new Set());
  const sync = useRef<() => void>(() => undefined);
  const roomKey = useMemo(() => [...new Set(caseIds)].sort().join('|'), [caseIds]);

  useEffect(() => {
    const socket = createRealtimeSocket();
    const syncRooms = () => {
      if (!socket.connected) return;
      for (const id of joined.current) if (!wanted.current.has(id)) socket.emit('leave', id);
      for (const id of wanted.current) if (!joined.current.has(id)) socket.emit('join', id);
      joined.current = new Set(wanted.current);
    };
    const onConnect = () => {
      joined.current = new Set(); // the server forgot our rooms
      setStatus('connected');
      syncRooms();
    };
    const onDown = () => setStatus('reconnecting');
    const onAlert = (raw: unknown) => {
      const ev = alertNewEventSchema.safeParse(raw);
      if (ev.success && wanted.current.has(ev.data.caseId)) handler.current(ev.data);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDown);
    socket.on('connect_error', onDown);
    socket.on('alert.new', onAlert);
    sync.current = syncRooms;
    if (socket.connected) onConnect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDown);
      socket.off('connect_error', onDown);
      socket.off('alert.new', onAlert);
      socket.disconnect();
      sync.current = () => undefined;
      joined.current = new Set();
    };
  }, []);

  useEffect(() => {
    wanted.current = new Set(roomKey ? roomKey.split('|') : []);
    sync.current();
  }, [roomKey]);

  return { status: roomKey === '' ? 'off' : status };
}
