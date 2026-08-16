import { describe, expect, it } from 'vitest';
import * as T from './time';
import type { Time } from './types';

const t = T.time;

describe('construction & normalisation', () => {
  it('normalises to lowest terms', () => {
    expect(t(2, 4)).toEqual({ num: 1, den: 2 });
    expect(t(1001, 30030)).toEqual({ num: 1, den: 30 });
  });

  it('keeps the sign on the numerator', () => {
    expect(t(1, -2)).toEqual({ num: -1, den: 2 });
    expect(t(-1, -2)).toEqual({ num: 1, den: 2 });
  });

  it('canonicalises zero', () => {
    expect(t(0, 7)).toEqual({ num: 0, den: 1 });
    expect(t(0, -7)).toEqual({ num: 0, den: 1 });
  });

  it('rejects non-integers and zero denominators', () => {
    expect(() => t(1.5, 2)).toThrow(T.TimeError);
    expect(() => t(1, 0)).toThrow(T.TimeError);
  });

  it('validates with isTime', () => {
    expect(T.isTime({ num: 1, den: 2 })).toBe(true);
    expect(T.isTime({ num: 2, den: 4 })).toBe(false); // not normalised
    expect(T.isTime({ num: 0, den: 5 })).toBe(false); // zero must be 0/1
    expect(T.isTime({ num: 1, den: -2 })).toBe(false);
    expect(T.isTime({ num: 1.5, den: 2 })).toBe(false);
    expect(T.isTime(null)).toBe(false);
    expect(() => T.assertTime({ num: 2, den: 4 })).toThrow(T.TimeError);
  });
});

describe('fromSeconds', () => {
  it('recovers exact simple rationals', () => {
    expect(T.fromSeconds(0.5)).toEqual({ num: 1, den: 2 });
    expect(T.fromSeconds(0)).toEqual({ num: 0, den: 1 });
    expect(T.fromSeconds(-2.25)).toEqual({ num: -9, den: 4 });
    expect(T.fromSeconds(3)).toEqual({ num: 3, den: 1 });
  });

  it('recovers 1001-based values that floats mangle', () => {
    expect(T.fromSeconds(1001 / 30000)).toEqual({ num: 1001, den: 30000 });
    expect(T.fromSeconds(1 / 3)).toEqual({ num: 1, den: 3 });
  });

  it('respects maxDen and returns the closest fraction, not just a convergent', () => {
    // The plain convergent would be 22/7 (err 1.3e-3); 311/99 is strictly better.
    const approx = T.fromSeconds(Math.PI, 100);
    expect(approx).toEqual({ num: 311, den: 99 });
    expect(approx.den).toBeLessThanOrEqual(100);
    expect(T.toSeconds(approx)).toBeCloseTo(Math.PI, 3);
  });

  it('rejects an invalid maxDen', () => {
    expect(() => T.fromSeconds(1.5, 0)).toThrow(T.TimeError);
    expect(() => T.fromSeconds(1.5, 2.5)).toThrow(T.TimeError);
  });

  it('rejects non-finite input', () => {
    expect(() => T.fromSeconds(NaN)).toThrow(T.TimeError);
    expect(() => T.fromSeconds(Infinity)).toThrow(T.TimeError);
  });
});

describe('arithmetic', () => {
  it('adds with unlike denominators', () => {
    expect(T.add(t(1, 3), t(1, 6))).toEqual({ num: 1, den: 2 });
    expect(T.add(t(1, 1001), t(1000, 1001))).toEqual({ num: 1, den: 1 });
  });

  it('is exact over long accumulations at 29.97', () => {
    // 30000 frames at 30000/1001 fps is exactly 1001 seconds.
    const frame = T.frameDuration(T.FPS_29_97);
    let acc = T.TIME_ZERO;
    for (let i = 0; i < 30000; i++) acc = T.add(acc, frame);
    expect(acc).toEqual({ num: 1001, den: 1 });
    expect(T.eq(acc, t(1001))).toBe(true);
  });

  it('is exact over long accumulations at 48 kHz', () => {
    const s = T.sampleDuration(48000);
    let acc = T.TIME_ZERO;
    for (let i = 0; i < 48000; i++) acc = T.add(acc, s);
    expect(acc).toEqual({ num: 1, den: 1 });
  });

  it('subtracts, negates and takes absolute values', () => {
    expect(T.sub(t(1, 2), t(1, 3))).toEqual({ num: 1, den: 6 });
    expect(T.sub(t(1, 3), t(1, 2))).toEqual({ num: -1, den: 6 });
    expect(T.neg(t(1, 3))).toEqual({ num: -1, den: 3 });
    expect(T.neg(T.TIME_ZERO)).toEqual({ num: 0, den: 1 });
    expect(T.abs(t(-1, 3))).toEqual({ num: 1, den: 3 });
  });

  it('sums lists', () => {
    expect(T.sum([t(1, 3), t(1, 3), t(1, 3)])).toEqual({ num: 1, den: 1 });
    expect(T.sum([])).toEqual({ num: 0, den: 1 });
  });

  it('multiplies by integers and rationals', () => {
    expect(T.mulInt(t(1, 3), 6)).toEqual({ num: 2, den: 1 });
    expect(T.mulInt(t(1, 3), 0)).toEqual({ num: 0, den: 1 });
    expect(T.mulInt(t(1, 3), -3)).toEqual({ num: -1, den: 1 });
    expect(T.mulRational(t(3, 4), { num: 2, den: 3 })).toEqual({ num: 1, den: 2 });
    expect(T.divRational(t(1, 2), { num: 1, den: 4 })).toEqual({ num: 2, den: 1 });
    expect(() => T.divRational(t(1, 2), { num: 0, den: 4 })).toThrow(T.TimeError);
    expect(() => T.mulInt(t(1, 3), 1.5)).toThrow(T.TimeError);
  });

  it('scales by a float factor exactly', () => {
    expect(T.scale(t(1), 0.5)).toEqual({ num: 1, den: 2 });
    expect(T.scale(t(4), 2)).toEqual({ num: 8, den: 1 });
    expect(T.scale(t(1), -1)).toEqual({ num: -1, den: 1 });
  });

  it('computes ratios', () => {
    expect(T.ratio(t(1, 2), t(1, 4))).toBe(2);
  });
});

describe('overflow handling', () => {
  // The contract is "exact or throw" — never a silently wrong answer.
  const p1 = 999999937; // prime
  const p2 = 999999893; // prime

  it('throws a typed error when the exact result is not representable', () => {
    // 1/p1 + 1/p2 has denominator p1*p2 ~ 1e18, well beyond 2^53.
    expect(() => T.add(t(1, p1), t(1, p2))).toThrow(T.TimeOverflowError);
    expect(() => T.add(t(1, p1), t(1, p2))).toThrow(/cannot be represented exactly/);
    // TimeOverflowError is a TimeError, so a single catch clause covers both.
    expect(() => T.add(t(1, p1), t(1, p2))).toThrow(T.TimeError);
  });

  it('still succeeds when cross-cancellation brings the result back in range', () => {
    // Intermediate numerator 3e15 * 5 overflows, but the value itself is fine.
    const big = t(3_000_000_000_000_000, 7);
    expect(T.mulRational(big, { num: 7, den: 3 })).toEqual({ num: 1_000_000_000_000_000, den: 1 });
  });

  it('compares exactly when the cross-products overflow (BigInt path)', () => {
    // Two nearly equal values whose cross-products are ~1.2e17, far past 2^53.
    // 123456789/1000000007 > 123456788/1000000009, but only in the 10th digit.
    const a = t(123456789, 1000000007);
    const b = t(123456788, 1000000009);
    expect(a.num * b.den).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(b.num * a.den).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(T.cmp(a, b)).toBe(1);
    expect(T.cmp(b, a)).toBe(-1);
    expect(T.cmp(a, a)).toBe(0);
  });

  it('compares exactly with tiny values of differing denominators', () => {
    expect(T.lt(t(1, p1), t(1, p2))).toBe(true); // larger denominator = smaller value
    expect(T.gt(t(1, p2), t(1, p1))).toBe(true);
  });

  it('converts to microseconds exactly when the intermediate overflows', () => {
    const big = t(10_000_000_007, 3); // *1e6 = 1e16, beyond 2^53
    expect(big.num * 1_000_000).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(T.toMicros(big)).toBe(3_333_333_335_666_667);
  });
});

describe('comparison', () => {
  it('orders values', () => {
    expect(T.cmp(t(1, 3), t(1, 2))).toBe(-1);
    expect(T.cmp(t(1, 2), t(1, 3))).toBe(1);
    expect(T.cmp(t(2, 4), t(1, 2))).toBe(0);
    expect(T.cmp(t(-1, 2), t(1, 3))).toBe(-1);
  });

  it('provides predicates', () => {
    expect(T.eq(t(2, 4), t(1, 2))).toBe(true);
    expect(T.lte(t(1, 2), t(1, 2))).toBe(true);
    expect(T.gte(t(1, 2), t(1, 2))).toBe(true);
    expect(T.isZero(T.TIME_ZERO)).toBe(true);
    expect(T.isNegative(t(-1, 2))).toBe(true);
    expect(T.isPositive(t(1, 2))).toBe(true);
    expect(T.sign(t(-3))).toBe(-1);
    expect(T.sign(T.TIME_ZERO)).toBe(0);
  });

  it('min, max and clamp', () => {
    expect(T.min(t(1, 3), t(1, 2))).toEqual(t(1, 3));
    expect(T.max(t(1, 3), t(1, 2))).toEqual(t(1, 2));
    expect(T.clamp(t(5), t(1), t(3))).toEqual(t(3));
    expect(T.clamp(t(0), t(1), t(3))).toEqual(t(1));
    expect(T.clamp(t(2), t(1), t(3))).toEqual(t(2));
    expect(() => T.clamp(t(2), t(3), t(1))).toThrow(T.TimeError);
  });
});

describe('frames & samples', () => {
  it('round-trips frames at fractional rates', () => {
    for (const rate of [T.FPS_23_976, T.FPS_25, T.FPS_29_97, T.FPS_59_94]) {
      for (const f of [0, 1, 999, 108000]) {
        expect(T.floorFrames(T.fromFrames(f, rate), rate)).toBe(f);
      }
    }
  });

  it('round-trips samples', () => {
    for (const rate of [44100, 48000, 96000]) {
      for (const s of [0, 1, 44099, 1_000_000]) {
        expect(T.floorSamples(T.fromSamples(s, rate), rate)).toBe(s);
      }
    }
  });

  it('floors, ceils and rounds frames', () => {
    const half = T.mulRational(T.frameDuration(T.FPS_30), { num: 3, den: 2 }); // 1.5 frames
    expect(T.floorFrames(half, T.FPS_30)).toBe(1);
    expect(T.ceilFrames(half, T.FPS_30)).toBe(2);
    expect(T.roundFrames(half, T.FPS_30)).toBe(2); // half rounds up
    expect(T.ceilFrames(T.fromFrames(3, T.FPS_30), T.FPS_30)).toBe(3); // exact stays put
  });

  it('detects alignment', () => {
    expect(T.isFrameAligned(T.fromFrames(7, T.FPS_29_97), T.FPS_29_97)).toBe(true);
    expect(T.isFrameAligned(t(1, 2), T.FPS_29_97)).toBe(false);
    expect(T.isSampleAligned(T.fromSamples(7, 48000), 48000)).toBe(true);
    expect(T.isSampleAligned(t(1, 7), 48000)).toBe(false);
  });

  it('converts to microseconds exactly, rounding halves up', () => {
    expect(T.toMicros(t(1))).toBe(1_000_000);
    expect(T.toMicros(t(1, 3))).toBe(333_333);
    expect(T.toMicros(t(2, 3))).toBe(666_667);
    expect(T.toMicros(t(-1, 3))).toBe(-333_333);
    expect(T.toMicros(T.frameDuration(T.FPS_29_97))).toBe(33_367); // 1001/30000 s
  });

  it('handles microsecond conversion of very large times', () => {
    const big = t(1_000_000_007, 3); // ~333M seconds
    expect(T.toMicros(big)).toBe(333_333_335_666_667);
  });

  it('nominal fps', () => {
    expect(T.nominalFps(T.FPS_29_97)).toBe(30);
    expect(T.nominalFps(T.FPS_23_976)).toBe(24);
    expect(T.nominalFps(T.FPS_59_94)).toBe(60);
  });

  it('rejects a non-positive frame rate', () => {
    expect(() => T.frameRate(0, 1)).toThrow(T.TimeError);
    expect(() => T.frameRate(-30, 1)).toThrow(T.TimeError);
  });
});

describe('snapping', () => {
  it('snaps to frame boundaries', () => {
    const rate = T.FPS_29_97;
    const off = T.add(T.fromFrames(10, rate), t(1, 100000));
    expect(T.snapToFrame(off, rate, 'floor')).toEqual(T.fromFrames(10, rate));
    expect(T.snapToFrame(off, rate, 'ceil')).toEqual(T.fromFrames(11, rate));
    expect(T.snapToFrame(off, rate, 'round')).toEqual(T.fromFrames(10, rate));
  });

  it('snaps to sample boundaries', () => {
    const off = T.add(T.fromSamples(100, 48000), t(1, 10_000_000));
    expect(T.snapToSample(off, 48000, 'floor')).toEqual(T.fromSamples(100, 48000));
    expect(T.snapToSample(off, 48000, 'ceil')).toEqual(T.fromSamples(101, 48000));
  });

  it('leaves already-aligned values untouched', () => {
    const aligned = T.fromFrames(42, T.FPS_25);
    for (const mode of ['floor', 'ceil', 'round'] as const) {
      expect(T.snapToFrame(aligned, T.FPS_25, mode)).toEqual(aligned);
    }
  });
});

describe('ranges', () => {
  const r = (start: Time, dur: Time) => T.range(start, dur);

  it('constructs and derives bounds', () => {
    const a = r(t(1), t(2));
    expect(T.rangeEnd(a)).toEqual(t(3));
    expect(T.rangeFromBounds(t(1), t(3))).toEqual(a);
    expect(T.rangeIsEmpty(r(t(1), T.TIME_ZERO))).toBe(true);
    expect(() => r(t(1), t(-1))).toThrow(T.TimeError);
  });

  it('is half-open for containment', () => {
    const a = r(t(1), t(2));
    expect(T.rangeContains(a, t(1))).toBe(true);
    expect(T.rangeContains(a, t(2))).toBe(true);
    expect(T.rangeContains(a, t(3))).toBe(false); // end is exclusive
    expect(T.rangeContains(a, t(0))).toBe(false);
  });

  it('detects overlap without counting touching edges', () => {
    expect(T.rangesOverlap(r(t(0), t(1)), r(t(1), t(1)))).toBe(false);
    expect(T.rangesOverlap(r(t(0), t(2)), r(t(1), t(1)))).toBe(true);
    expect(T.rangesOverlap(r(t(0), T.TIME_ZERO), r(t(0), t(1)))).toBe(false);
  });

  it('intersects and unions', () => {
    expect(T.intersect(r(t(0), t(3)), r(t(1), t(5)))).toEqual(r(t(1), t(2)));
    expect(T.intersect(r(t(0), t(1)), r(t(2), t(1)))).toBeNull();
    expect(T.rangeUnion(r(t(0), t(1)), r(t(2), t(1)))).toEqual(r(t(0), t(3)));
  });

  it('shifts', () => {
    expect(T.rangeShift(r(t(1), t(2)), t(5))).toEqual(r(t(6), t(2)));
  });
});

describe('timecode — non-drop', () => {
  it('formats at 25 fps', () => {
    expect(T.toTimecode(T.TIME_ZERO, T.FPS_25)).toBe('00:00:00:00');
    expect(T.toTimecode(t(1), T.FPS_25)).toBe('00:00:01:00');
    expect(T.toTimecode(t(3661), T.FPS_25)).toBe('01:01:01:00');
    expect(T.toTimecode(T.fromFrames(24, T.FPS_25), T.FPS_25)).toBe('00:00:00:24');
  });

  it('formats 29.97 as non-drop when asked', () => {
    // 1800 frames of 29.97 NDF = 00:01:00:00 on the timecode clock
    expect(T.framesToTimecode(1800, T.FPS_29_97, { dropFrame: false })).toBe('00:01:00:00');
  });

  it('round-trips', () => {
    for (const rate of [T.FPS_24, T.FPS_25, T.FPS_30, T.FPS_60]) {
      for (const f of [0, 1, 12345, 86399]) {
        const tc = T.framesToTimecode(f, rate);
        expect(T.timecodeToFrames(tc, rate)).toBe(f);
      }
    }
  });

  it('wraps at 24 hours', () => {
    const framesPer24h = 25 * 3600 * 24;
    expect(T.framesToTimecode(framesPer24h, T.FPS_25)).toBe('00:00:00:00');
    expect(T.framesToTimecode(framesPer24h + 1, T.FPS_25)).toBe('00:00:00:01');
  });

  it('signs negative times', () => {
    expect(T.framesToTimecode(-25, T.FPS_25)).toBe('-00:00:01:00');
    expect(T.timecodeToFrames('-00:00:01:00', T.FPS_25)).toBe(-25);
  });
});

describe('timecode — drop frame', () => {
  it('drops two frames each minute except every tenth', () => {
    expect(T.framesToTimecode(1798, T.FPS_29_97)).toBe('00:00:59;28');
    expect(T.framesToTimecode(1799, T.FPS_29_97)).toBe('00:00:59;29');
    expect(T.framesToTimecode(1800, T.FPS_29_97)).toBe('00:01:00;02'); // ;00 and ;01 dropped
    expect(T.framesToTimecode(17982, T.FPS_29_97)).toBe('00:10:00;00'); // 10th minute: no drop
    expect(T.framesToTimecode(107892, T.FPS_29_97)).toBe('01:00:00;00'); // one hour
  });

  it('tracks wall-clock time far better than non-drop', () => {
    // This is the whole point of drop-frame, so pin the numbers down.
    const dfHour = T.fromFrames(107892, T.FPS_29_97); // "01:00:00;00"
    expect(T.toTimecode(dfHour, T.FPS_29_97)).toBe('01:00:00;00');
    expect(dfHour).toEqual({ num: 8999991, den: 2500 }); // 3599.9964 s
    // Residual drift: 3.6 ms per hour, i.e. DF is not exact either.
    expect(T.sub(t(3600), dfHour)).toEqual({ num: 9, den: 2500 });

    const ndfHour = T.fromFrames(108000, T.FPS_29_97); // "01:00:00:00" non-drop
    expect(T.framesToTimecode(108000, T.FPS_29_97, { dropFrame: false })).toBe('01:00:00:00');
    expect(T.sub(ndfHour, t(3600))).toEqual({ num: 18, den: 5 }); // 3.6 s of drift
  });

  it('works at 59.94', () => {
    expect(T.framesToTimecode(3600, T.FPS_59_94)).toBe('00:01:00;04');
    expect(T.framesToTimecode(35964, T.FPS_59_94)).toBe('00:10:00;00');
    expect(T.framesToTimecode(215784, T.FPS_59_94)).toBe('01:00:00;00');
  });

  it('round-trips', () => {
    for (const rate of [T.FPS_29_97, T.FPS_59_94]) {
      for (const f of [0, 1, 1800, 17982, 107891, 215783]) {
        const tc = T.framesToTimecode(f, rate);
        expect(T.timecodeToFrames(tc, rate)).toBe(f);
      }
    }
  });

  it('defaults to drop-frame for 29.97 and non-drop elsewhere', () => {
    expect(T.framesToTimecode(0, T.FPS_29_97)).toContain(';');
    expect(T.framesToTimecode(0, T.FPS_30)).toContain(':');
    expect(T.framesToTimecode(0, T.FPS_23_976)).toContain(':');
  });

  it('rejects drop-frame on unsupported rates', () => {
    expect(() => T.framesToTimecode(0, T.FPS_25, { dropFrame: true })).toThrow(T.TimeError);
    expect(T.supportsDropFrame(T.FPS_29_97)).toBe(true);
    expect(T.supportsDropFrame(T.FPS_30)).toBe(false);
  });

  it('rejects timecodes naming a dropped frame', () => {
    expect(() => T.timecodeToFrames('00:01:00;00', T.FPS_29_97)).toThrow(T.TimeError);
    expect(() => T.timecodeToFrames('00:01:00;01', T.FPS_29_97)).toThrow(T.TimeError);
    expect(T.timecodeToFrames('00:10:00;00', T.FPS_29_97)).toBe(17982); // valid
  });

  it('infers the mode from the separator when parsing', () => {
    expect(T.timecodeToFrames('00:01:00:00', T.FPS_29_97)).toBe(1800); // ':' = NDF
    expect(T.timecodeToFrames('00:01:00;02', T.FPS_29_97)).toBe(1800); // ';' = DF
  });

  it('rejects malformed input', () => {
    expect(() => T.timecodeToFrames('nope', T.FPS_25)).toThrow(T.TimeError);
    expect(() => T.timecodeToFrames('00:99:00:00', T.FPS_25)).toThrow(T.TimeError);
    expect(() => T.timecodeToFrames('00:00:00:25', T.FPS_25)).toThrow(T.TimeError);
  });
});

describe('formatDuration', () => {
  it('formats common cases', () => {
    expect(T.formatDuration(T.TIME_ZERO)).toBe('0:00.000');
    expect(T.formatDuration(t(1, 2))).toBe('0:00.500');
    expect(T.formatDuration(t(61))).toBe('1:01.000');
    expect(T.formatDuration(t(3661))).toBe('1:01:01.000');
    expect(T.formatDuration(t(-1, 2))).toBe('-0:00.500');
  });

  it('honours decimals and forceHours', () => {
    expect(T.formatDuration(t(1, 3), { decimals: 0 })).toBe('0:00');
    expect(T.formatDuration(t(1, 3), { decimals: 2 })).toBe('0:00.33');
    expect(T.formatDuration(t(61), { forceHours: true })).toBe('0:01:01.000');
  });

  it('carries rounding into the seconds field', () => {
    // 0.9999 s rounds to 1.000 s, not 0:00.1000
    expect(T.formatDuration(t(9999, 10000))).toBe('0:01.000');
  });
});

describe('debugTime', () => {
  it('prints the raw fraction', () => {
    expect(T.debugTime(T.frameDuration(T.FPS_29_97))).toBe('1001/30000');
  });
});
