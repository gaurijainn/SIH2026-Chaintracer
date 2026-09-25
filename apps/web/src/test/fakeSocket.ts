import { act } from '@testing-library/react';

type Listener = (...a: unknown[]) => void;
export class FakeSocket {
  connected = false;
  handlers = new Map<string, Set<Listener>>();
  emitted: unknown[][] = [];
  disconnected = false;
  on(e: string, fn: Listener) {
    (this.handlers.get(e) ?? this.handlers.set(e, new Set()).get(e)!).add(fn);
    return this;
  }
  off(e: string, fn: Listener) {
    this.handlers.get(e)?.delete(fn);
    return this;
  }
  emit(...a: unknown[]) {
    this.emitted.push(a);
    return this;
  }
  disconnect() {
    this.disconnected = true;
    this.connected = false;
  }
  fire(e: string, ...a: unknown[]) {
    act(() => this.handlers.get(e)?.forEach((fn) => fn(...a)));
  }
  connect() {
    this.connected = true;
    this.fire('connect');
  }
  drop() {
    this.connected = false;
    this.fire('disconnect');
  }
  listenerCount() {
    return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
  }
}

/** Every socket a component created, oldest first; tests read `sockets` to drive events. */
export const sockets: FakeSocket[] = [];
export const createFakeSocket = () => {
  const s = new FakeSocket();
  sockets.push(s);
  return s;
};
