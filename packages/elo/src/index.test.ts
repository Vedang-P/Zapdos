import { describe, expect, it } from 'vitest';
import { expectedScore, kFactor, updateRatings } from './index';

describe('elo', () => {
  it('expects 50% between equal ratings and favours the stronger player', () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1400, 1200)).toBeGreaterThan(0.75);
    expect(expectedScore(1400, 1200) + expectedScore(1200, 1400)).toBeCloseTo(1, 10);
  });

  it('uses the provisional K-factor for new players only', () => {
    expect(kFactor(0)).toBe(40);
    expect(kFactor(9)).toBe(40);
    expect(kFactor(10)).toBe(32);
  });

  it('moves ratings toward the result and is symmetric for established equals', () => {
    const win = updateRatings('win', 1200, 1200, 50, 50);
    expect(win.deltaA).toBe(16);
    expect(win.deltaB).toBe(-16);
    const draw = updateRatings('draw', 1200, 1200, 50, 50);
    expect(draw.deltaA).toBe(0);
  });

  it('rewards an upset more than an expected win', () => {
    const upset = updateRatings('win', 1000, 1400, 50, 50).deltaA;
    const expected = updateRatings('win', 1400, 1000, 50, 50).deltaA;
    expect(upset).toBeGreaterThan(expected);
  });
});
