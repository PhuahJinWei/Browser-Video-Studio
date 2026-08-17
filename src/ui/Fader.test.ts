import { quantizeRangeValue, snapRangeValue } from './Fader';

describe('range value helpers', () => {
  it('catches unity values a compact volume fader cannot physically land on', () => {
    expect(snapRangeValue(96, 100, 1, 5)).toBe(100);
    expect(snapRangeValue(104, 100, 1, 5)).toBe(100);
    expect(snapRangeValue(94, 100, 1, 5)).toBe(94);
    expect(snapRangeValue(106, 100, 1, 5)).toBe(106);
  });

  it('does not invent a detent where none was requested', () => {
    expect(snapRangeValue(99, 100, 1, 0)).toBe(99);
    expect(snapRangeValue(99, undefined, 1, 5)).toBe(99);
  });

  it('clamps and quantizes typed precision values to the slider grid', () => {
    expect(quantizeRangeValue(181.26, -180, 180, 0.5)).toBe(180);
    expect(quantizeRangeValue(-17.24, -180, 180, 0.5)).toBe(-17);
    expect(quantizeRangeValue(73, 36, 160, 4)).toBe(72);
    expect(quantizeRangeValue(Number.NaN, 36, 160, 4)).toBe(36);
  });
});
