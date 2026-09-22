import { describe, expect, it } from 'vitest';
import { isHighDegree, isServiceLabel, meetsMinValue, withinWindow } from './stopConditions';

describe('isServiceLabel', () => {
  it('recognises the four B4 stop-condition categories', () => {
    for (const category of ['exchange', 'mixer', 'bridge', 'sanctioned']) {
      expect(isServiceLabel({ category, name: 'x' })).toBe(true);
    }
  });
  it('rejects other categories and null', () => {
    expect(isServiceLabel({ category: 'scam', name: 'x' })).toBe(false);
    expect(isServiceLabel(null)).toBe(false);
  });
});

describe('withinWindow', () => {
  const start = Date.UTC(2026, 0, 1);
  it('accepts a timestamp inside the incident window', () => {
    expect(withinWindow(start + 86_400_000, start, 30)).toBe(true);
  });
  it('rejects a timestamp before the window starts', () => {
    expect(withinWindow(start - 1, start, 30)).toBe(false);
  });
  it('rejects a timestamp past windowDays after the incident', () => {
    expect(withinWindow(start + 31 * 86_400_000, start, 30)).toBe(false);
  });
  it('accepts the boundary at exactly windowDays', () => {
    expect(withinWindow(start + 30 * 86_400_000, start, 30)).toBe(true);
  });
});

describe('meetsMinValue', () => {
  it('excludes a priced transfer below the threshold', () => {
    expect(meetsMinValue(5, 10)).toBe(false);
  });
  it('includes a priced transfer at or above the threshold', () => {
    expect(meetsMinValue(10, 10)).toBe(true);
    expect(meetsMinValue(11, 10)).toBe(true);
  });
  it('keeps an unpriceable transfer rather than dropping it', () => {
    expect(meetsMinValue(null, 10)).toBe(true);
  });
});

describe('isHighDegree', () => {
  it('flags an address whose counterparty count exceeds the cutoff', () => {
    expect(isHighDegree(5001, 5000)).toBe(true);
  });
  it('does not flag at or below the cutoff', () => {
    expect(isHighDegree(5000, 5000)).toBe(false);
    expect(isHighDegree(10, 5000)).toBe(false);
  });
});
