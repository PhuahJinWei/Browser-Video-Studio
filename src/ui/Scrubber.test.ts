import { clampScrubValue, scrubValueAtClientX } from './Scrubber';

describe('Scrubber geometry', () => {
  it('uses the painted rail as the single coordinate system', () => {
    expect(scrubValueAtClientX(110, 110, 400)).toBe(0);
    expect(scrubValueAtClientX(310, 110, 400)).toBe(0.5);
    expect(scrubValueAtClientX(510, 110, 400)).toBe(1);
  });

  it('clamps pointers outside the rail to its endpoints', () => {
    expect(scrubValueAtClientX(50, 110, 400)).toBe(0);
    expect(scrubValueAtClientX(700, 110, 400)).toBe(1);
  });

  it('handles invalid geometry and values safely', () => {
    expect(scrubValueAtClientX(50, 10, 0)).toBe(0);
    expect(clampScrubValue(Number.NaN)).toBe(0);
    expect(clampScrubValue(-0.5)).toBe(0);
    expect(clampScrubValue(1.5)).toBe(1);
  });
});
