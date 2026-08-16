/**
 * Parameter evaluation.
 *
 * A `Param<V>` is either a static value or a keyframe track. Keyframe times are
 * relative to the owning clip's start, so moving a clip moves its animation with it.
 * Evaluation is pure and total: out-of-range times clamp to the first/last keyframe.
 */

import * as T from './time';
import type {
  AnimatableCrop,
  AnimatableTransform2D,
  Crop,
  Keyframe,
  Param,
  ParamValue,
  Time,
  Transform2D,
} from './types';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function staticParam<V>(value: V): Param<V> {
  return { kind: 'static', value };
}

export function keyframedParam<V>(keyframes: readonly Keyframe<V>[]): Param<V> {
  if (keyframes.length === 0) {
    throw new Error('A keyframed parameter needs at least one keyframe');
  }
  return { kind: 'keyframed', keyframes: sortKeyframes(keyframes) };
}

export function keyframe<V>(at: Time, value: V, interp: Keyframe<V>['interp'] = 'linear'): Keyframe<V> {
  return { at, value, interp };
}

export function bezierKeyframe<V>(
  at: Time,
  value: V,
  ease: readonly [number, number, number, number],
): Keyframe<V> {
  return { at, value, interp: 'bezier', ease };
}

/** Stable sort by time; equal times keep their relative order. */
export function sortKeyframes<V>(keyframes: readonly Keyframe<V>[]): readonly Keyframe<V>[] {
  return [...keyframes].sort((a, b) => T.cmp(a.at, b.at));
}

// ---------------------------------------------------------------------------
// Cubic bezier easing (CSS timing-function semantics)
// ---------------------------------------------------------------------------

const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 1e-4;
const SUBDIVISION_EPSILON = 1e-7;
const SUBDIVISION_MAX_ITERATIONS = 20;

function bezierComponent(t: number, a1: number, a2: number): number {
  const c = 3 * a1;
  const b = 3 * a2 - 6 * a1;
  const a = 1 - 3 * a2 + 3 * a1;
  return ((a * t + b) * t + c) * t;
}

function bezierSlope(t: number, a1: number, a2: number): number {
  const c = 3 * a1;
  const b = 3 * a2 - 6 * a1;
  const a = 1 - 3 * a2 + 3 * a1;
  return (3 * a * t + 2 * b) * t + c;
}

/** Solve for the parametric t where the curve's x equals `x`. */
function solveBezierT(x: number, x1: number, x2: number): number {
  let t = x;
  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const slope = bezierSlope(t, x1, x2);
    if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
    const err = bezierComponent(t, x1, x2) - x;
    if (Math.abs(err) < SUBDIVISION_EPSILON) return t;
    t -= err / slope;
  }
  // Newton can leave the [0,1] interval on pathological control points; bisect instead.
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < SUBDIVISION_MAX_ITERATIONS; i++) {
    const value = bezierComponent(t, x1, x2);
    if (Math.abs(value - x) < SUBDIVISION_EPSILON) return t;
    if (value < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return t;
}

/** CSS `cubic-bezier(x1, y1, x2, y2)` evaluated at progress `p` in [0, 1]. */
export function cubicBezier(
  ease: readonly [number, number, number, number],
  p: number,
): number {
  const [x1, y1, x2, y2] = ease;
  if (x1 === y1 && x2 === y2) return p; // linear
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return bezierComponent(solveBezierT(p, x1, x2), y1, y2);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Index of the last keyframe at or before `at`, or -1 when `at` precedes them all. */
function findSegment<V>(keyframes: readonly Keyframe<V>[], at: Time): number {
  let lo = 0;
  let hi = keyframes.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const kf = keyframes[mid]!;
    if (T.lte(kf.at, at)) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

function interpolate(a: number, b: number, p: number): number {
  return lerp(a, b, p);
}

function blendValues<V>(from: V, to: V, p: number): V {
  if (typeof from === 'number' && typeof to === 'number') {
    return interpolate(from, to, p) as V;
  }
  if (Array.isArray(from) && Array.isArray(to) && from.length === to.length) {
    return from.map((v, i) =>
      typeof v === 'number' && typeof to[i] === 'number' ? interpolate(v, to[i] as number, p) : v,
    ) as V;
  }
  // Booleans, strings and mismatched shapes cannot be blended: hold the earlier value.
  return from;
}

/**
 * Evaluate a parameter at `at` (clip-relative time).
 * Times before the first keyframe or after the last one clamp to that keyframe.
 */
export function evalParam<V>(param: Param<V>, at: Time): V {
  if (param.kind === 'static') return param.value;

  const kfs = param.keyframes;
  if (kfs.length === 0) throw new Error('Keyframed parameter has no keyframes');

  const i = findSegment(kfs, at);
  if (i < 0) return kfs[0]!.value;
  if (i >= kfs.length - 1) return kfs[kfs.length - 1]!.value;

  const from = kfs[i]!;
  const to = kfs[i + 1]!;
  if (from.interp === 'hold') return from.value;

  const span = T.sub(to.at, from.at);
  if (T.isZero(span)) return to.value;

  const linearProgress = T.ratio(T.sub(at, from.at), span);
  const progress =
    from.interp === 'bezier' && from.ease ? cubicBezier(from.ease, linearProgress) : linearProgress;

  return blendValues(from.value, to.value, progress);
}

/** Typed convenience wrappers — they assert the runtime shape matches the schema. */
export function evalNumber(param: Param<number>, at: Time): number {
  const v = evalParam(param, at);
  if (typeof v !== 'number') throw new Error(`Expected a numeric parameter, got ${typeof v}`);
  return v;
}

export function evalBoolean(param: Param<boolean>, at: Time): boolean {
  const v = evalParam(param, at);
  if (typeof v !== 'boolean') throw new Error(`Expected a boolean parameter, got ${typeof v}`);
  return v;
}

export function evalString(param: Param<string>, at: Time): string {
  const v = evalParam(param, at);
  if (typeof v !== 'string') throw new Error(`Expected a string parameter, got ${typeof v}`);
  return v;
}

/** Evaluate every entry of an effect's parameter map. */
export function evalParamMap(
  params: Readonly<Record<string, Param<ParamValue>>>,
  at: Time,
): Readonly<Record<string, ParamValue>> {
  const out: Record<string, ParamValue> = {};
  for (const [key, param] of Object.entries(params)) out[key] = evalParam(param, at);
  return out;
}

/** True when the parameter changes over time (i.e. needs per-frame re-evaluation). */
export function isAnimated<V>(param: Param<V>): boolean {
  return param.kind === 'keyframed' && param.keyframes.length > 1;
}

// ---------------------------------------------------------------------------
// Composite structures
// ---------------------------------------------------------------------------

export function evalTransform(transform: AnimatableTransform2D, at: Time): Transform2D {
  return {
    x: evalNumber(transform.x, at),
    y: evalNumber(transform.y, at),
    scaleX: evalNumber(transform.scaleX, at),
    scaleY: evalNumber(transform.scaleY, at),
    rotation: evalNumber(transform.rotation, at),
    anchorX: evalNumber(transform.anchorX, at),
    anchorY: evalNumber(transform.anchorY, at),
  };
}

export function evalCrop(crop: AnimatableCrop, at: Time): Crop {
  return {
    left: evalNumber(crop.left, at),
    top: evalNumber(crop.top, at),
    right: evalNumber(crop.right, at),
    bottom: evalNumber(crop.bottom, at),
  };
}

export function isTransformAnimated(transform: AnimatableTransform2D): boolean {
  return Object.values(transform).some(isAnimated);
}
