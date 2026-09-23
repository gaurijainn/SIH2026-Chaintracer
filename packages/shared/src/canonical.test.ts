import { describe, expect, it } from 'vitest';
import { canonicalize, sha256Hex } from './canonical';

describe('canonicalize', () => {
  it('sorts object keys regardless of insertion order', () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('sorts nested object keys recursively', () => {
    const a = canonicalize({ x: { z: 1, y: 2 } });
    expect(a).toBe('{"x":{"y":2,"z":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('preserves null but drops undefined object fields', () => {
    expect(canonicalize({ a: null, b: undefined, c: 1 })).toBe('{"a":null,"c":1}');
  });

  it('null and undefined-dropped are distinguishable', () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
  });

  it('rejects Date instances', () => {
    expect(() => canonicalize({ a: new Date() })).toThrow(/Date/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ a: NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
  });

  it('is stable for equivalent deeply nested structures', () => {
    const v1 = { a: [{ y: 1, x: 2 }], m: { k2: 'v2', k1: 'v1' } };
    const v2 = { m: { k1: 'v1', k2: 'v2' }, a: [{ x: 2, y: 1 }] };
    expect(canonicalize(v1)).toBe(canonicalize(v2));
  });
});

describe('sha256Hex', () => {
  it('is deterministic for the same canonical string', () => {
    const c = canonicalize({ a: 1, b: 2 });
    expect(sha256Hex(c)).toBe(sha256Hex(c));
  });

  it('changes when the input changes', () => {
    const h1 = sha256Hex(canonicalize({ a: 1 }));
    const h2 = sha256Hex(canonicalize({ a: 2 }));
    expect(h1).not.toBe(h2);
  });

  it('produces a 64-char lowercase hex digest', () => {
    const h = sha256Hex(canonicalize({ a: 1 }));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
