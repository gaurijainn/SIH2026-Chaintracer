import { describe, expect, it } from 'vitest';
import { encodeCategoricals, stableHash } from './encode';

describe('stableHash', () => {
  it('is deterministic: same input always produces the same output', () => {
    expect(stableHash('exchange')).toBe(stableHash('exchange'));
  });

  it('produces different values for different inputs (no trivial collisions on short strings)', () => {
    expect(stableHash('exchange')).not.toBe(stableHash('mixer'));
  });

  it('is always a non-negative 32-bit integer', () => {
    const h = stableHash('some-fairly-long-activator-label-string');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('encodeCategoricals', () => {
  it('hashes a present activator_label into a bucket, deterministically', () => {
    const a = encodeCategoricals({ activator_label: 'exchange', external_flags: [] });
    const b = encodeCategoricals({ activator_label: 'exchange', external_flags: [] });
    expect(a.activator_label_hash).toBe(b.activator_label_hash);
    expect(a.activator_label_hash).not.toBeNull();
  });

  it('preserves a missing activator_label as null rather than inventing bucket 0', () => {
    const enc = encodeCategoricals({ activator_label: null, external_flags: [] });
    expect(enc.activator_label_hash).toBeNull();
  });

  it('counts external_flags and produces a sorted, order-independent hash', () => {
    const a = encodeCategoricals({ activator_label: null, external_flags: ['fraudTransaction', 'stablecoinBlacklist'] });
    const b = encodeCategoricals({ activator_label: null, external_flags: ['stablecoinBlacklist', 'fraudTransaction'] });
    expect(a.external_flags_count).toBe(2);
    expect(a.external_flags_hash).toBe('fraudTransaction|stablecoinBlacklist');
    expect(a.external_flags_hash).toBe(b.external_flags_hash); // order-independent
  });

  it('produces an empty hash and zero count for no flags', () => {
    const enc = encodeCategoricals({ activator_label: null, external_flags: [] });
    expect(enc.external_flags_count).toBe(0);
    expect(enc.external_flags_hash).toBe('');
  });
});
