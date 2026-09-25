import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRealtimeSocket } from '@/lib/realtime';
import { dashboardKeys, type AlertRow, type AlertRule, type AlertSeverity } from './api';
import { SEVERITIES } from './metrics';

export type FeedStatus = 'connecting' | 'connected' | 'reconnecting';

/** An alert as the feed shows it, whether it arrived over Socket.IO (`live`) or was loaded from GET /alerts. */
export interface FeedAlert {
  id: string;
  rule: AlertRule;
  severity: AlertSeverity;
  caseId: string;
  chain: string | null;
  address: string;
  amount: string | null;
  /** epoch ms: server createdAt for stored alerts, arrival time for live ones (the event carries no timestamp). */
  at: number;
  live: boolean;
}

const RULES: readonly string[] = ['A1_MOVEMENT', 'A2_VASP_LANDING', 'A3_OBFUSCATION', 'A4_LINKAGE', 'A5_BLACKLIST'];
export const FEED_LIMIT = 30;
/** The relay only delivers alert.new to sockets that joined `case:<id>`, so the dashboard joins a bounded set of cases. */
export const MAX_ROOMS = 200;
const REFRESH_DEBOUNCE_MS = 2_000;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/** Validates an `alert.new` payload (shared AlertNewEvent). Anything malformed is dropped rather than rendered. */
export function parseAlertEvent(raw: unknown, now = Date.now()): FeedAlert | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  const caseId = str(p.caseId);
  const address = str(p.address);
  if (!id || !caseId || !address) return null;
  if (typeof p.rule !== 'string' || !RULES.includes(p.rule)) return null;
  if (typeof p.severity !== 'string' || !(SEVERITIES as string[]).includes(p.severity)) return null;
  const amount = typeof p.amount === 'string' || typeof p.amount === 'number' ? String(p.amount) : null;
  return { id, rule: p.rule as AlertRule, severity: p.severity as AlertSeverity, caseId, chain: str(p.chain), address, amount, at: now, live: true };
}

export const fromRow = (a: AlertRow): FeedAlert => ({ id: a.id, rule: a.rule, severity: a.severity, caseId: a.caseId, chain: a.chain, address: a.address, amount: a.amount, at: Date.parse(a.createdAt) || 0, live: false });

/** Live alerts first, then stored ones, newest first; one entry per alert id (a live alert wins over its stored copy). */
export function mergeFeed(live: FeedAlert[], stored: AlertRow[], limit = FEED_LIMIT): FeedAlert[] {
  const byId = new Map<string, FeedAlert>();
  for (const a of stored.map(fromRow)) byId.set(a.id, a);
  for (const a of live) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

/**
 * Subscribes to `alert.new` for the given cases. Rooms are re-joined on every (re)connect because the server
 * drops them when the socket drops. The listener and the socket are torn down on unmount.
 */
export function useAlertFeed(caseIds: string[]) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<FeedAlert[]>([]);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const sync = useRef<() => void>(() => undefined);
  const wanted = useRef<Set<string>>(new Set());
  const joined = useRef<Set<string>>(new Set());

  const roomKey = useMemo(() => caseIds.slice(0, MAX_ROOMS).join('|'), [caseIds]);

  useEffect(() => {
    const socket = createRealtimeSocket();
    let timer: ReturnType<typeof setTimeout> | undefined;

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
    const onAlert = (payload: unknown) => {
      const alert = parseAlertEvent(payload);
      if (!alert) return;
      setLive((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert, ...prev].slice(0, FEED_LIMIT)));
      // Keep the alert KPIs honest without a request per event: one debounced refetch of GET /alerts.
      clearTimeout(timer);
      timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: dashboardKeys.alerts }), REFRESH_DEBOUNCE_MS);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDown);
    socket.on('connect_error', onDown);
    socket.on('alert.new', onAlert);
    sync.current = syncRooms;

    return () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDown);
      socket.off('connect_error', onDown);
      socket.off('alert.new', onAlert);
      socket.disconnect();
      sync.current = () => undefined;
      joined.current = new Set();
    };
  }, [queryClient]);

  useEffect(() => {
    wanted.current = new Set(roomKey ? roomKey.split('|') : []);
    sync.current();
  }, [roomKey]);

  return { live, status };
}
