import { io, type Socket } from 'socket.io-client';
import { apiBaseUrl } from './env';

/**
 * Socket.IO client for the API's realtime relay (apps/api/src/realtime/socket.ts). Same origin by default
 * (the Vite dev proxy / nginx forwards /socket.io); VITE_API_BASE_URL overrides it. The relay does not verify
 * handshake credentials today (no B10 socket auth exists), so none are sent: the session gate is that the
 * dashboard, which opens this socket, only renders behind ProtectedRoute.
 */
export const createRealtimeSocket = (): Socket => io(apiBaseUrl || undefined, { transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });
