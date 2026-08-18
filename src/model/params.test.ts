import { describe, expect, it } from 'vitest';
import {
  bezierKeyframe,
  cubicBezier,
  evalCrop,
  evalNumber,
  evalParam,
  evalParamMap,
  evalTransform,
  isAnimated,
  integrateNumberParam,
  keyframe,
  keyframedParam,
  removeKeyframe,
  sortKeyframes,
  staticParam,
  upsertKeyframe,
} from './params';
import * as T from './time';

const sec = (n: number, d = 1) => T.time(n, d);

describe('static parameters', () => {
  it('return their value at any time', () => {
    const p = staticParam(0.5);
    expect(evalNumber(p, T.TIME_ZERO)).toBe(0.5);
    expect(evalNumber(p, sec(1000))).toBe(0.5);
    expect(evalNumber(p, sec(-5))).toBe(0.5);
  });

  it('are not animated', () => {
    expect(isAnimated(staticParam(1))).toBe(false);
    expect(isAnimated(keyframedParam([keyframe(T.TIME_ZERO, 1)]))).toBe(false);
    expect(isAnimated(keyframedParam([keyframe(T.TIME_ZERO, 1), keyframe(sec(1), 2)]))).toBe(true);
  });
});

describe('keyframed parameters', () => {
  const ramp = keyframedParam([keyframe(T.TIME_ZERO, 0), keyframe(sec(4), 1)]);

  it('clamp outside the keyframe range', () => {
    expect(evalNumber(ramp, sec(-10))).toBe(0);
    expect(evalNumber(ramp, sec(10))).toBe(1);
  });

  it('hit the keyframes exactly', () => {
    expect(evalNumber(ramp, T.TIME_ZERO)).toBe(0);
    expect(evalNumber(ramp, sec(4))).toBe(1);
  });

  it('interpolate linearly in between', () => {
    expect(evalNumber(ramp, sec(1))).toBe(0.25);
    expect(evalNumber(ramp, sec(2))).toBe(0.5);
    expect(evalNumber(ramp, sec(3))).toBe(0.75);
  });

  it('work with negative keyframe times (as produced by splitting)', () => {
    const shifted = keyframedParam([keyframe(sec(-2), 0), keyframe(sec(2), 1)]);
    expect(evalNumber(shifted, sec(-2))).toBe(0);
    expect(evalNumber(shifted, T.TIME_ZERO)).toBe(0.5);
    expect(evalNumber(shifted, sec(1))).toBe(0.75);
  });

  it('hold when the segment says so', () => {
    const held = keyframedParam([
      keyframe(T.TIME_ZERO, 10, 'hold'),
      keyframe(sec(2), 20, 'linear'),
      keyframe(sec(4), 30),
    ]);
    expect(evalNumber(held, sec(1))).toBe(10); // held across the first segment
    expect(evalNumber(held, sec(2))).toBe(20);
    expect(evalNumber(held, sec(3))).toBe(25); // linear across the second
  });

  it('integrates static, linear and held numeric parameters', () => {
    expect(integrateNumberParam(staticParam(2), T.TIME_ZERO, sec(3))).toBeCloseTo(6);
    expect(integrateNumberParam(
      keyframedParam([keyframe(T.TIME_ZERO, 1), keyframe(sec(2), 3)]),
      T.TIME_ZERO,
      sec(2),
    )).toBeCloseTo(4);
    expect(integrateNumberParam(
      keyframedParam([keyframe(T.TIME_ZERO, 2, 'hold'), keyframe(sec(2), 7)]),
      T.TIME_ZERO,
      sec(2),
    )).toBeCloseTo(4);
  });

  it('interpolate vectors component-wise', () => {
    const colour = keyframedParam<readonly number[]>([
      keyframe(T.TIME_ZERO, [0, 0, 0, 1]),
      keyframe(sec(2), [1, 0.5, 0, 1]),
    ]);
    expect(evalParam(colour, sec(1))).toEqual([0.5, 0.25, 0, 1]);
  });

  it('hold values that cannot be blended', () => {
    const text = keyframedParam([keyframe(T.TIME_ZERO, 'a'), keyframe(sec(2), 'b')]);
    expect(evalParam(text, sec(1))).toBe('a');
    const flag = keyframedParam([keyframe(T.TIME_ZERO, false), keyframe(sec(2), true)]);
    expect(evalParam(flag, sec(1))).toBe(false);
  });

  it('handle coincident keyframes without dividing by zero', () => {
    const jump = keyframedParam([keyframe(T.TIME_ZERO, 0), keyframe(T.TIME_ZERO, 5), keyframe(sec(1), 5)]);
    expect(evalNumber(jump, T.TIME_ZERO)).toBe(5);
  });

  it('sort out-of-order keyframes on construction', () => {
    const p = keyframedParam([keyframe(sec(4), 1), keyframe(T.TIME_ZERO, 0)]);
    expect(p.kind === 'keyframed' && T.toSeconds(p.keyframes[0]!.at)).toBe(0);
    expect(sortKeyframes([keyframe(sec(2), 'b'), keyframe(sec(1), 'a')])[0]!.value).toBe('a');
  });

  it('reject an empty keyframe list', () => {
    expect(() => keyframedParam([])).toThrow();
  });

  it('type-check at evaluation time', () => {
    const text = staticParam('hello') as unknown as ReturnType<typeof staticParam<number>>;
    expect(() => evalNumber(text, T.TIME_ZERO)).toThrow(/numeric/);
  });
});

describe('keyframe editing', () => {
  it('creates, inserts and replaces exact keyframes', () => {
    const first = upsertKeyframe(staticParam(10), sec(1), 20);
    const second = upsertKeyframe(first, sec(3), 40);
    const replaced = upsertKeyframe(second, sec(1), 25);
    expect(replaced.kind).toBe('keyframed');
    if (replaced.kind !== 'keyframed') return;
    expect(replaced.keyframes.map((item) => [T.toSeconds(item.at), item.value])).toEqual([
      [1, 25],
      [3, 40],
    ]);
  });

  it('removes a keyframe and collapses the final one to a static value', () => {
    const animated = keyframedParam([keyframe(sec(1), 10), keyframe(sec(2), 20)]);
    const one = removeKeyframe(animated, sec(1));
    expect(one.kind === 'keyframed' && one.keyframes).toHaveLength(1);
    expect(removeKeyframe(one, sec(2))).toEqual(staticParam(20));
  });
});

describe('cubic bezier easing', () => {
  it('is the identity for a linear curve', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(cubicBezier([0, 0, 1, 1], p)).toBeCloseTo(p, 10);
    }
  });

  it('pins the endpoints', () => {
    expect(cubicBezier([0.42, 0, 0.58, 1], 0)).toBe(0);
    expect(cubicBezier([0.42, 0, 0.58, 1], 1)).toBe(1);
  });

  it('is symmetric for ease-in-out and slower at the edges', () => {
    const ease = [0.42, 0, 0.58, 1] as const;
    expect(cubicBezier(ease, 0.5)).toBeCloseTo(0.5, 6);
    expect(cubicBezier(ease, 0.25)).toBeLessThan(0.25);
    expect(cubicBezier(ease, 0.75)).toBeGreaterThan(0.75);
  });

  it('drives keyframe interpolation', () => {
    const eased = keyframedParam([
      bezierKeyframe(T.TIME_ZERO, 0, [0.42, 0, 0.58, 1]),
      keyframe(sec(4), 1),
    ]);
    expect(evalNumber(eased, sec(2))).toBeCloseTo(0.5, 6);
    expect(evalNumber(eased, sec(1))).toBeLessThan(0.25);
  });
});

describe('composite structures', () => {
  it('evaluates a transform', () => {
    const transform = {
      x: keyframedParam([keyframe(T.TIME_ZERO, 0), keyframe(sec(2), 100)]),
      y: staticParam(10),
      scaleX: staticParam(1),
      scaleY: staticParam(1),
      rotation: staticParam(0),
      anchorX: staticParam(0.5),
      anchorY: staticParam(0.5),
    };
    expect(evalTransform(transform, sec(1))).toEqual({
      x: 50,
      y: 10,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    });
  });

  it('evaluates a crop', () => {
    const crop = {
      left: staticParam(0.1),
      top: staticParam(0),
      right: keyframedParam([keyframe(T.TIME_ZERO, 0), keyframe(sec(1), 0.5)]),
      bottom: staticParam(0),
    };
    expect(evalCrop(crop, T.TIME_ZERO)).toEqual({ left: 0.1, top: 0, right: 0, bottom: 0 });
    expect(evalCrop(crop, sec(1))).toEqual({ left: 0.1, top: 0, right: 0.5, bottom: 0 });
  });

  it('evaluates a whole param map', () => {
    const params = {
      radius: keyframedParam([keyframe(T.TIME_ZERO, 0), keyframe(sec(2), 20)]),
      quality: staticParam('high'),
    };
    expect(evalParamMap(params, sec(1))).toEqual({ radius: 10, quality: 'high' });
  });
});
