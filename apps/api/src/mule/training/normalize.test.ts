import { describe, expect, it } from 'vitest';
import { normalizeAddressForChain } from './normalize';

const TRON_ADDR = 'TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ8M';

describe('normalizeAddressForChain', () => {
  it('normalizes a valid TRON address, stripping whitespace', () => {
    expect(normalizeAddressForChain('TRON', `  ${TRON_ADDR}  `)).toBe(TRON_ADDR);
  });

  it('returns null for an invalid TRON address rather than guessing', () => {
    expect(normalizeAddressForChain('TRON', 'not-a-real-address')).toBeNull();
  });

  it('returns null when the address belongs to a different chain family (EVM address stated as TRON)', () => {
    expect(normalizeAddressForChain('TRON', '0x00000000219ab540356cbb839cbe05303d7705fa')).toBeNull();
  });

  it('checksums an EVM address for ETH', () => {
    const lower = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const normalized = normalizeAddressForChain('ETH', lower);
    expect(normalized).not.toBeNull();
    expect(normalized!.toLowerCase()).toBe(lower);
  });
});
