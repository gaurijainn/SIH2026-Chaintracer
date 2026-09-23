import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALERT_EVENTS_CHANNEL, TRACE_EVENTS_CHANNEL, type AlertNewEvent } from '@ps26183/shared';
import { attachTraceSocket } from './socket';

// Integration test: needs a real Redis (docker compose up -d redis). No external network -- Redis is
// our own infra, not a provider covered by the "no live calls" constraint.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

let httpServer: HttpServer;
let base: number;
let close: () => Promise<void>;
let publisher: Redis;

beforeAll(async () => {
  httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  base = (httpServer.address() as AddressInfo).port;
  ({ close } = attachTraceSocket(httpServer, REDIS_URL));
  publisher = new Redis(REDIS_URL);
});

afterAll(async () => {
  await close();
  publisher.disconnect();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${base}`, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

describe('B8 alert.new Socket.IO delivery (real Redis + real Socket.IO server)', () => {
  it('delivers alert.new to a client that joined the matching case room, within budget, and NOT to a client in a different room', async () => {
    const inRoom = await connect();
    const otherRoom = await connect();
    const noRoom = await connect();

    inRoom.emit('join', 'case-alpha');
    otherRoom.emit('join', 'case-beta');
    await new Promise((r) => setTimeout(r, 100)); // let 'join' land server-side

    const received: Promise<AlertNewEvent> = new Promise((resolve) => inRoom.once('alert.new', resolve));
    const otherReceived: AlertNewEvent[] = [];
    otherRoom.on('alert.new', (e: AlertNewEvent) => otherReceived.push(e));
    const noRoomReceived: AlertNewEvent[] = [];
    noRoom.on('alert.new', (e: AlertNewEvent) => noRoomReceived.push(e));

    const payload: AlertNewEvent = { id: 'alert-int-1', rule: 'A2_VASP_LANDING', severity: 'CRITICAL', caseId: 'case-alpha', chain: 'TRON', address: 'Taddr', amount: '25000' };
    const publishedAt = Date.now();
    await publisher.publish(ALERT_EVENTS_CHANNEL, JSON.stringify({ event: 'alert.new', payload }));

    const got = await Promise.race([received, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out waiting for alert.new')), 5000))]);
    const deliveryMs = Date.now() - publishedAt;
    console.log(`B8 socket.io alert.new delivery latency: ${deliveryMs}ms`);

    expect(got).toEqual(payload);
    expect(deliveryMs).toBeLessThan(1000); // "within 30 seconds" done-when has huge headroom; this is same-host

    await new Promise((r) => setTimeout(r, 150)); // give the wrongly-scoped clients a chance to (not) receive it
    expect(otherReceived).toEqual([]);
    expect(noRoomReceived).toEqual([]);

    inRoom.close();
    otherRoom.close();
    noRoom.close();
  }, 10_000);

  it('trace.* and alert.* events both relay correctly on the same connection (shared channel-relay logic)', async () => {
    const socket = await connect();
    socket.emit('join', 'case-shared');
    await new Promise((r) => setTimeout(r, 100));

    const tracePromise = new Promise((resolve) => socket.once('trace.progress', resolve));
    await publisher.publish(TRACE_EVENTS_CHANNEL, JSON.stringify({ event: 'trace.progress', payload: { traceId: 't1', caseId: 'case-shared', hopsDone: 1, frontier: 2, apiCalls: 3 } }));
    await expect(tracePromise).resolves.toMatchObject({ traceId: 't1' });

    const alertPromise = new Promise((resolve) => socket.once('alert.new', resolve));
    await publisher.publish(ALERT_EVENTS_CHANNEL, JSON.stringify({ event: 'alert.new', payload: { id: 'a2', rule: 'A1_MOVEMENT', severity: 'MEDIUM', caseId: 'case-shared', chain: 'TRON', address: 'Taddr2', amount: '1500' } }));
    await expect(alertPromise).resolves.toMatchObject({ id: 'a2' });

    socket.close();
  }, 10_000);

  it('no alert.new is ever received before the corresponding publish (nothing buffered ahead of persistence)', async () => {
    const socket = await connect();
    socket.emit('join', 'case-order');
    await new Promise((r) => setTimeout(r, 100));

    const receivedBeforePublish: unknown[] = [];
    socket.on('alert.new', (e) => receivedBeforePublish.push(e));

    // Simulate persistence taking a moment (a real Alert row write) before the publish happens --
    // the client must receive nothing in that window, only after the publish actually occurs.
    await new Promise((r) => setTimeout(r, 200));
    expect(receivedBeforePublish).toEqual([]);

    const payload: AlertNewEvent = { id: 'alert-order-1', rule: 'A5_BLACKLIST', severity: 'INFO', caseId: 'case-order', chain: 'TRON', address: 'Taddr3', amount: null };
    await publisher.publish(ALERT_EVENTS_CHANNEL, JSON.stringify({ event: 'alert.new', payload }));
    await new Promise((r) => setTimeout(r, 150));

    expect(receivedBeforePublish).toEqual([payload]);
    socket.close();
  }, 10_000);

  it('a reconnecting client receives alerts published after it rejoins the room (does not receive ones published while disconnected)', async () => {
    const first = await connect();
    first.emit('join', 'case-reconnect');
    await new Promise((r) => setTimeout(r, 100));
    first.close();
    await new Promise((r) => setTimeout(r, 100));

    // Published while no client is connected -- nothing should be waiting for the reconnecting client
    // (Socket.IO rooms are not a durable queue; GET /alerts, not this channel, is the source of truth
    // for anything missed while disconnected).
    await publisher.publish(ALERT_EVENTS_CHANNEL, JSON.stringify({ event: 'alert.new', payload: { id: 'missed-1', rule: 'A1_MOVEMENT', severity: 'MEDIUM', caseId: 'case-reconnect', chain: 'TRON', address: 'TaddrMissed', amount: '1' } }));
    await new Promise((r) => setTimeout(r, 100));

    const reconnected = await connect();
    const received: AlertNewEvent[] = [];
    reconnected.on('alert.new', (e: AlertNewEvent) => received.push(e));
    reconnected.emit('join', 'case-reconnect');
    await new Promise((r) => setTimeout(r, 100));

    const payload: AlertNewEvent = { id: 'alert-after-reconnect', rule: 'A2_VASP_LANDING', severity: 'CRITICAL', caseId: 'case-reconnect', chain: 'TRON', address: 'TaddrReconnect', amount: '9999' };
    await publisher.publish(ALERT_EVENTS_CHANNEL, JSON.stringify({ event: 'alert.new', payload }));
    await new Promise((r) => setTimeout(r, 150));

    expect(received).toEqual([payload]); // only the post-reconnect alert, never the missed one
    reconnected.close();
  }, 10_000);
});
