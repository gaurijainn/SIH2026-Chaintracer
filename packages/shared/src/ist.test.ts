import { describe, expect, it } from 'vitest';
import { toIst } from './ist';

describe('toIst', () => {
  it('adds the fixed 5:30 IST offset', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    const r = toIst(d);
    expect(r.iso).toBe('2026-01-01T00:00:00.000Z');
    // UTC midnight -> 05:30 IST the same day
    expect(r.display).toContain('05:30:00');
    expect(r.display).toContain('01 Jan 2026');
    expect(r.display).toContain('IST');
  });

  it('rolls over to the next day when the UTC+5:30 offset crosses midnight', () => {
    const d = new Date('2026-01-01T20:00:00.000Z');
    const r = toIst(d);
    expect(r.display).toContain('02 Jan 2026');
    expect(r.display).toContain('01:30:00');
  });

  it('throws on an invalid Date', () => {
    expect(() => toIst(new Date('not-a-date'))).toThrow();
  });
});
