import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MonitorEvent } from '@ps26183/shared';
import { backoffMs, FixtureReplaySubscriptionClient } from './subscriptionClient';

const fixturesDir = fileURLToPath(new URL('../../fixtures/monitor', import.meta.url));

describe('FixtureReplaySubscriptionClient', () => {
  it('never opens a network connection: connect() is a no-op', async () => {
    const client = new FixtureReplaySubscriptionClient(`${fixturesDir}/evm-ws-fixture.json`);
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it('emits only fixture events whose addr is in the subscribed set', async () => {
    const client = new FixtureReplaySubscriptionClient(`${fixturesDir}/evm-ws-fixture.json`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.subscribe(['0x1111111111111111111111111111111111aaaa']);
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0].addr).toBe('0x1111111111111111111111111111111111aaaa');
  });

  it('emits nothing when the fixture address is not in the subscribed set', async () => {
    const client = new FixtureReplaySubscriptionClient(`${fixturesDir}/evm-ws-fixture.json`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.subscribe(['0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead']);
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(0);
  });

  it('btc fixture events are delivered the same way', async () => {
    const client = new FixtureReplaySubscriptionClient(`${fixturesDir}/btc-ws-fixture.json`);
    const received: MonitorEvent[] = [];
    client.on('transfer', (e) => received.push(e));
    await client.subscribe(['bc1qwatchedaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
    expect(received[0].chain).toBe('BTC');
  });

  it('close() clears handlers and is idempotent', async () => {
    const client = new FixtureReplaySubscriptionClient(`${fixturesDir}/evm-ws-fixture.json`);
    client.on('transfer', () => {});
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe('backoffMs', () => {
  it('grows exponentially and is capped', () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(10)).toBe(30000); // capped
  });
});
