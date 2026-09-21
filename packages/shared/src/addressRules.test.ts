import { describe, expect, it } from 'vitest';
import { BSC_USD, USDT_ERC20, USDT_TRC20, classifyIdentifier, defaultTokenContract, isTrustedToken, normalizeIdentifier } from './index';

const TRON = 'TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ8M';
const EVM_CHECKSUM = '0xC26CD860769C4404e7e0C407BD93f0Dbb429264e';
const BTC_LEGACY = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const BTC_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const BTC_BECH32 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const BTC_TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

const invalid = (s: string) => {
  const c = classifyIdentifier(s);
  expect(c.kind).toBe('INVALID');
  return c.kind === 'INVALID' ? c.reasons.join(' | ') : '';
};

describe('normalizeIdentifier', () => {
  it('trims, strips zero-width characters and all whitespace, and fixes 0X to 0x', () => {
    expect(normalizeIdentifier(`  ${TRON}\u200B `)).toBe(TRON);
    expect(normalizeIdentifier(`T QzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ8M`)).toBe(TRON);
    expect(normalizeIdentifier('\uFEFF0Xabc\u00A0def\n')).toBe('0xabcdef');
    expect(normalizeIdentifier('a\u2060b\u200Dc')).toBe('abc');
  });
  it('does not touch Base58 characters', () => {
    expect(normalizeIdentifier('T0OIl')).toBe('T0OIl');
  });
});

describe('detection order and validation (Appendix A)', () => {
  it('detects TRON by regex + Base58Check', () => {
    expect(classifyIdentifier(TRON)).toEqual({ kind: 'ADDRESS', family: 'TRON', normalized: TRON });
    expect(classifyIdentifier(`\u200B ${TRON} `)).toMatchObject({ family: 'TRON', normalized: TRON });
  });

  it('flags a TRON checksum failure instead of accepting or fixing it', () => {
    expect(invalid('TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ8N')).toMatch(/checksum/i);
  });

  it('reports characters outside Base58 (0, O, I, l) and never auto-corrects them', () => {
    const reason = invalid('TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ0M'); // 0 is not Base58
    expect(reason).toMatch(/Base58 alphabet/);
    expect(reason).toMatch(/not auto-corrected/i);
    for (const ch of ['O', 'I', 'l']) expect(invalid(`TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ${ch}M`)).toMatch(/Base58 alphabet/);
  });

  it('rejects wrong-length TRON strings', () => {
    expect(invalid(TRON.slice(0, 33))).toMatch(/34 characters/);
    expect(invalid(`${TRON}X`)).toMatch(/34 characters/);
  });

  it('detects EVM addresses and normalises to EIP-55', () => {
    expect(classifyIdentifier(EVM_CHECKSUM)).toEqual({ kind: 'ADDRESS', family: 'EVM', normalized: EVM_CHECKSUM });
    expect(classifyIdentifier(EVM_CHECKSUM.toLowerCase())).toMatchObject({ family: 'EVM', normalized: EVM_CHECKSUM });
    expect(classifyIdentifier(EVM_CHECKSUM.replace('0x', '0X'))).toMatchObject({ family: 'EVM', normalized: EVM_CHECKSUM });
  });

  it('rejects a mixed-case EVM address with a wrong EIP-55 checksum', () => {
    const bad = EVM_CHECKSUM.replace('C26C', 'c26C');
    expect(invalid(bad)).toMatch(/EIP-55/);
  });

  it('detects Bitcoin legacy, P2SH, bech32 and bech32m (taproot)', () => {
    for (const a of [BTC_LEGACY, BTC_P2SH, BTC_BECH32, BTC_TAPROOT]) {
      expect(classifyIdentifier(a)).toEqual({ kind: 'ADDRESS', family: 'BTC', normalized: a });
    }
  });

  it('rejects bad Bitcoin checksums and lower-cases an all-uppercase bech32 address', () => {
    expect(invalid('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')).toMatch(/checksum/i);
    expect(invalid('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx')).toMatch(/bech32/);
    expect(classifyIdentifier(BTC_BECH32.toUpperCase())).toMatchObject({ family: 'BTC', normalized: BTC_BECH32 });
    expect(invalid('bc1QAR0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toMatch(/bech32/); // mixed case
  });

  it('detects transaction hashes: EVM 0x+64, and bare 64-hex (TRON or Bitcoin)', () => {
    const h = 'ab'.repeat(32);
    expect(classifyIdentifier(`0x${h}`)).toEqual({ kind: 'TX_HASH', family: 'EVM', normalized: `0x${h}` });
    expect(classifyIdentifier(h.toUpperCase())).toEqual({ kind: 'TX_HASH', family: 'TRON_OR_BTC', normalized: h });
  });

  it('gives a reason for unrecognised input', () => {
    expect(invalid('')).toMatch(/empty/);
    expect(invalid('hello world')).toMatch(/not a recognised/);
    expect(invalid('0x1234')).toMatch(/hex characters/);
    expect(invalid('0xZZ' + 'a'.repeat(38))).toMatch(/non-hex/);
  });
});

describe('official-token whitelist (fake-token guard)', () => {
  it('trusts only the three official stablecoin contracts on their own chain', () => {
    expect(isTrustedToken('TRON', USDT_TRC20)).toBe(true);
    expect(isTrustedToken('ETH', USDT_ERC20)).toBe(true);
    expect(isTrustedToken('ETH', USDT_ERC20.toLowerCase())).toBe(true); // EVM comparison is case-insensitive
    expect(isTrustedToken('BSC', BSC_USD)).toBe(true);
  });
  it('rejects look-alike, wrong-chain and case-mangled TRON contracts', () => {
    expect(isTrustedToken('TRON', 'TKX4tuVb4ApiutoibSFugfFW9nBcXaMNDe')).toBe(false);
    expect(isTrustedToken('TRON', USDT_TRC20.toLowerCase())).toBe(false); // Base58 is case-sensitive
    expect(isTrustedToken('BSC', USDT_ERC20)).toBe(false);
    expect(isTrustedToken('BTC', USDT_TRC20)).toBe(false);
    expect(isTrustedToken('POLYGON', USDT_ERC20)).toBe(false);
  });
  it('pre-selects USDT-TRC20 for TRON and nothing for chains without a whitelisted token', () => {
    expect(defaultTokenContract('TRON')).toBe(USDT_TRC20);
    expect(defaultTokenContract('ETH')).toBe(USDT_ERC20);
    expect(defaultTokenContract('BTC')).toBeNull();
  });
});
