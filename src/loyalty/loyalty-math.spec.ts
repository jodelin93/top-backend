import { pointsEarned, pointsForAmount, valueOfPoints } from './loyalty-math';

const rules = {
  enabled: true,
  earnPercent: 5,
  pointValue: 0.01,
  minRedeemPoints: 100,
  maxRedeemPercent: 50,
};

describe('loyalty math', () => {
  it('earns points worth the configured % of the amount paid', () => {
    // 5% of 29.70 = 1.485 → 148 points at 0.01 each
    expect(pointsEarned(rules, 29.7)).toBe(148);
  });

  it('matches the original 1 point per currency unit at 1% / 0.01', () => {
    expect(pointsEarned({ ...rules, earnPercent: 1 }, 29.7)).toBe(29);
  });

  it('earns nothing when the programme is off', () => {
    expect(pointsEarned({ ...rules, enabled: false }, 100)).toBe(0);
  });

  it('rounds points needed up so value is never given away', () => {
    expect(pointsForAmount(rules, 1.005)).toBe(101);
    expect(pointsForAmount(rules, 2)).toBe(200);
  });

  it('values points in money, rounded down to the cent', () => {
    expect(valueOfPoints(rules, 250)).toBe(2.5);
    expect(valueOfPoints({ ...rules, pointValue: 0.015 }, 3)).toBe(0.04);
  });
});
