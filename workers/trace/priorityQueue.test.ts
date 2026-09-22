import { describe, expect, it } from 'vitest';
import { TaintPriorityQueue } from './priorityQueue';

describe('TaintPriorityQueue', () => {
  it('pops entries in descending taint order', () => {
    const q = new TaintPriorityQueue<string>();
    q.push('a', 10);
    q.push('b', 50);
    q.push('c', 30);
    q.push('d', 5);
    expect([q.pop()?.key, q.pop()?.key, q.pop()?.key, q.pop()?.key]).toEqual(['b', 'c', 'a', 'd']);
    expect(q.pop()).toBeUndefined();
  });

  it('handles a large random sequence as a correct max-heap', () => {
    const q = new TaintPriorityQueue<number>();
    const values = Array.from({ length: 500 }, () => Math.random() * 1000);
    values.forEach((v, i) => q.push(i, v));
    const popped: number[] = [];
    let e;
    while ((e = q.pop())) popped.push(e.taint);
    expect(popped).toEqual([...values].sort((a, b) => b - a));
  });

  it('size reflects pending entries and shrinks on pop', () => {
    const q = new TaintPriorityQueue<string>();
    q.push('a', 1);
    q.push('b', 2);
    expect(q.size).toBe(2);
    q.pop();
    expect(q.size).toBe(1);
    q.pop();
    expect(q.size).toBe(0);
  });

  it('supports pushing a fresh, higher entry for the same key (caller-driven lazy update)', () => {
    const q = new TaintPriorityQueue<string>();
    q.push('a', 10);
    q.push('a', 90); // caller increased a's taint; both entries live until popped
    expect(q.size).toBe(2);
    expect(q.pop()).toEqual({ key: 'a', taint: 90 });
    expect(q.pop()).toEqual({ key: 'a', taint: 10 }); // stale entry; the engine discards these itself
  });
});
