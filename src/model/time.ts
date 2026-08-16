/**
 * Exact rational time arithmetic.
 *
 * Every position and duration in the project model is a `Time` = num/den seconds,
 * always normalised (den > 0, gcd(|num|, den) === 1, zero is 0/1). Floats are never
 * used to *store* time: 29.97 fps (30000/1001), 23.976, 48 kHz and 44.1 kHz all have
 * exact rational representations, and accumulating them as float seconds drifts.
 *
 * Performance strategy: all arithmetic runs on Numbers, with every intermediate
 * checked by `Number.isSafeInteger`. If any check fails we redo the operation in
 * BigInt and only throw `TimeOverflowError` if the *normalised* result genuinely
 * cannot be represented exactly. So the common path is fast and the rare path is
 * still correct.
 */

import type { FrameRate, Time, TimeRange } from './types';

export type { FrameRate, Time, TimeRange };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeError';
  }
}

export class TimeOverflowError extends TimeError {
  constructor(message: string) {
    super(message);
    this.name = 'TimeOverflowError';
  }
}

// ---------------------------------------------------------------------------
// Integer helpers
// ---------------------------------------------------------------------------

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_BIG = BigInt(MAX_SAFE);

function gcdNum(a: number, b: number): number {
  a = a < 0 ? -a : a;
  b = b < 0 ? -b : b;
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function gcdBig(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** Exact floor(n / d) for integers, d > 0. Float fast path with exact correction. */
function idivFloor(n: number, d: number): number {
  if (Number.isSafeInteger(n)) {
    let q = Math.floor(n / d);
    // `q * d` is within ~d of n, so it stays safe whenever n is safe.
    for (let i = 0; i < 2; i++) {
      const qd = q * d;
      if (!Number.isSafeInteger(qd)) break;
      const r = n - qd;
      if (r >= 0 && r < d) return q;
      q += Math.floor(r / d);
    }
  }
  const bn = BigInt(n);
  const bd = BigInt(d);
  let q = bn / bd;
  if (bn % bd !== 0n && bn < 0n) q -= 1n;
  return Number(q);
}

/** Exact round(n / d) for integers, d > 0. Halves round toward +Infinity. */
function idivRound(n: number, d: number): number {
  const a = 2 * n + d;
  const b = 2 * d;
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return idivFloor(a, b);
  const bn = 2n * BigInt(n) + BigInt(d);
  const bd = 2n * BigInt(d);
  let q = bn / bd;
  if (bn % bd !== 0n && bn < 0n) q -= 1n;
  return Number(q);
}

/** Exact ceil(n / d) for integers, d > 0. */
function idivCeil(n: number, d: number): number {
  const q = idivFloor(n, d);
  return q * d === n ? q : q + 1;
}

function fromBig(num: bigint, den: bigint): Time {
  if (den === 0n) throw new TimeError('Time denominator must not be zero');
  if (num === 0n) return TIME_ZERO;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcdBig(num, den);
  const n = num / g;
  const d = den / g;
  if (n > MAX_SAFE_BIG || n < -MAX_SAFE_BIG || d > MAX_SAFE_BIG) {
    throw new TimeOverflowError(
      `Time ${n}/${d} cannot be represented exactly (exceeds Number.MAX_SAFE_INTEGER)`,
    );
  }
  return { num: Number(n), den: Number(d) };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export const TIME_ZERO: Time = Object.freeze({ num: 0, den: 1 });
export const TIME_ONE: Time = Object.freeze({ num: 1, den: 1 });

/** Construct a normalised Time from an integer numerator/denominator (seconds). */
export function time(num: number, den = 1): Time {
  if (!Number.isInteger(num) || !Number.isInteger(den)) {
    throw new TimeError(`Time components must be integers, got ${num}/${den}`);
  }
  if (den === 0) throw new TimeError('Time denominator must not be zero');
  if (num === 0) return TIME_ZERO;
  if (den < 0) {
    num = -num;
    den = -den;
  }
  const g = gcdNum(num, den);
  const n = num / g;
  const d = den / g;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) {
    throw new TimeOverflowError(`Time ${n}/${d} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return { num: n, den: d };
}

/** True if `t` is a well-formed, normalised Time. */
export function isTime(t: unknown): t is Time {
  if (typeof t !== 'object' || t === null) return false;
  const c = t as { num?: unknown; den?: unknown };
  if (!Number.isSafeInteger(c.num) || !Number.isSafeInteger(c.den)) return false;
  const num = c.num as number;
  const den = c.den as number;
  if (den <= 0) return false;
  if (num === 0) return den === 1;
  return gcdNum(num, den) === 1;
}

/** Assert-and-return, for validating deserialised documents. */
export function assertTime(t: unknown, what = 'value'): Time {
  if (!isTime(t)) throw new TimeError(`${what} is not a normalised Time: ${JSON.stringify(t)}`);
  return t;
}

/**
 * Best rational approximation of a float number of seconds, with denominator <= maxDen.
 *
 * Uses continued fractions, and when the next convergent would exceed `maxDen` it also
 * considers the best *semi*-convergent — without that step the result is a valid
 * approximation but not always the closest one available (e.g. pi with maxDen 100 gives
 * 22/7 instead of the strictly better 311/99).
 */
export function fromSeconds(seconds: number, maxDen = 1_000_000): Time {
  if (!Number.isFinite(seconds)) throw new TimeError(`Cannot convert ${seconds} to Time`);
  if (!Number.isInteger(maxDen) || maxDen < 1) {
    throw new TimeError(`maxDen must be a positive integer, got ${maxDen}`);
  }
  if (seconds === 0) return TIME_ZERO;
  const sign = seconds < 0 ? -1 : 1;
  const target = Math.abs(seconds);
  let x = target;

  // Convergents h/k: h1/k1 is the current one, h0/k0 the previous.
  let h0 = 0;
  let h1 = 1;
  let k0 = 1;
  let k1 = 0;

  for (let i = 0; i < 64; i++) {
    const a = Math.floor(x);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;

    if (!Number.isSafeInteger(h2) || !Number.isSafeInteger(k2) || k2 > maxDen) {
      // Largest partial step that still fits the denominator budget.
      if (k1 > 0) {
        const aMax = Math.floor((maxDen - k0) / k1);
        if (aMax > 0) {
          const hs = aMax * h1 + h0;
          const ks = aMax * k1 + k0;
          if (
            Number.isSafeInteger(hs) &&
            Number.isSafeInteger(ks) &&
            ks <= maxDen &&
            Math.abs(target - hs / ks) < Math.abs(target - h1 / k1)
          ) {
            return time(sign * hs, ks);
          }
        }
      }
      break;
    }

    h0 = h1;
    h1 = h2;
    k0 = k1;
    k1 = k2;
    const frac = x - a;
    if (frac === 0) break;
    x = 1 / frac;
  }
  if (k1 === 0) throw new TimeOverflowError(`Cannot approximate ${seconds}s within den <= ${maxDen}`);
  return time(sign * h1, k1);
}

/** Integer microseconds (the WebCodecs timestamp unit) → Time. */
export function fromMicros(micros: number): Time {
  return time(Math.round(micros), 1_000_000);
}

/** Milliseconds → Time. */
export function fromMillis(millis: number): Time {
  return time(Math.round(millis), 1_000);
}

/** A whole number of frames at `rate` → Time. */
export function fromFrames(frames: number, rate: FrameRate): Time {
  if (!Number.isInteger(frames)) throw new TimeError(`frames must be an integer, got ${frames}`);
  return mulInt(frameDuration(rate), frames);
}

/** A whole number of audio samples at `sampleRate` Hz → Time. */
export function fromSamples(samples: number, sampleRate: number): Time {
  if (!Number.isInteger(samples)) throw new TimeError(`samples must be an integer, got ${samples}`);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new TimeError(`sampleRate must be a positive integer, got ${sampleRate}`);
  }
  return time(samples, sampleRate);
}

// ---------------------------------------------------------------------------
// Frame rates
// ---------------------------------------------------------------------------

/** Construct a normalised FrameRate. */
export function frameRate(num: number, den = 1): FrameRate {
  const t = time(num, den);
  if (t.num <= 0) throw new TimeError(`Frame rate must be positive, got ${num}/${den}`);
  return { num: t.num, den: t.den };
}

export const FPS_23_976: FrameRate = Object.freeze({ num: 24000, den: 1001 });
export const FPS_24: FrameRate = Object.freeze({ num: 24, den: 1 });
export const FPS_25: FrameRate = Object.freeze({ num: 25, den: 1 });
export const FPS_29_97: FrameRate = Object.freeze({ num: 30000, den: 1001 });
export const FPS_30: FrameRate = Object.freeze({ num: 30, den: 1 });
export const FPS_50: FrameRate = Object.freeze({ num: 50, den: 1 });
export const FPS_59_94: FrameRate = Object.freeze({ num: 60000, den: 1001 });
export const FPS_60: FrameRate = Object.freeze({ num: 60, den: 1 });

/** Duration of one frame at `rate`. */
export function frameDuration(rate: FrameRate): Time {
  return time(rate.den, rate.num);
}

/** Duration of one audio sample at `sampleRate` Hz. */
export function sampleDuration(sampleRate: number): Time {
  return time(1, sampleRate);
}

/** Frames per second as a float — for display only, never for arithmetic. */
export function fpsToNumber(rate: FrameRate): number {
  return rate.num / rate.den;
}

/** The integer "nominal" rate used by timecode: 30 for 29.97, 24 for 23.976, etc. */
export function nominalFps(rate: FrameRate): number {
  return Math.round(rate.num / rate.den);
}

// ---------------------------------------------------------------------------
// Conversion out
// ---------------------------------------------------------------------------

/** Lossy: float seconds. Use for display, UI layout and WebAudio scheduling only. */
export function toSeconds(t: Time): number {
  return t.num / t.den;
}

/** Exact integer microseconds, for WebCodecs `timestamp` / `duration` fields. */
export function toMicros(t: Time): number {
  const n = t.num * 1_000_000;
  if (Number.isSafeInteger(n)) return idivRound(n, t.den);
  const bn = 2n * BigInt(t.num) * 1_000_000n + BigInt(t.den);
  const bd = 2n * BigInt(t.den);
  let q = bn / bd;
  if (bn % bd !== 0n && bn < 0n) q -= 1n;
  return Number(q);
}

/** Lossy: fractional frame count at `rate`. */
export function toFrames(t: Time, rate: FrameRate): number {
  return (t.num * rate.num) / (t.den * rate.den);
}

/** Exact frame index containing `t` (floor). */
export function floorFrames(t: Time, rate: FrameRate): number {
  const r = mulRational(t, rate);
  return idivFloor(r.num, r.den);
}

/** Exact frame count rounding up. */
export function ceilFrames(t: Time, rate: FrameRate): number {
  const r = mulRational(t, rate);
  return idivCeil(r.num, r.den);
}

/** Exact nearest frame index. */
export function roundFrames(t: Time, rate: FrameRate): number {
  const r = mulRational(t, rate);
  return idivRound(r.num, r.den);
}

/** Exact sample index containing `t` (floor). */
export function floorSamples(t: Time, sampleRate: number): number {
  return idivFloor(t.num * sampleRate, t.den);
}

/** Exact nearest sample index. */
export function roundSamples(t: Time, sampleRate: number): number {
  return idivRound(t.num * sampleRate, t.den);
}

/** Exact sample count rounding up. */
export function ceilSamples(t: Time, sampleRate: number): number {
  return idivCeil(t.num * sampleRate, t.den);
}

/** True when `t` lands exactly on a frame boundary at `rate`. */
export function isFrameAligned(t: Time, rate: FrameRate): boolean {
  const r = mulRational(t, rate);
  return r.den === 1;
}

/** True when `t` lands exactly on a sample boundary at `sampleRate`. */
export function isSampleAligned(t: Time, sampleRate: number): boolean {
  return sampleRate % t.den === 0;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function add(a: Time, b: Time): Time {
  if (a.num === 0) return b;
  if (b.num === 0) return a;
  if (a.den === b.den) return time(a.num + b.num, a.den);

  const g = gcdNum(a.den, b.den);
  const bScale = b.den / g; // a.den * bScale === lcm(a.den, b.den)
  const aScale = a.den / g;
  const p = a.num * bScale;
  const q = b.num * aScale;
  const den = a.den * bScale;
  const num = p + q;
  if (
    Number.isSafeInteger(p) &&
    Number.isSafeInteger(q) &&
    Number.isSafeInteger(den) &&
    Number.isSafeInteger(num)
  ) {
    return time(num, den);
  }
  return fromBig(
    BigInt(a.num) * BigInt(bScale) + BigInt(b.num) * BigInt(aScale),
    BigInt(a.den) * BigInt(bScale),
  );
}

export function sub(a: Time, b: Time): Time {
  return add(a, neg(b));
}

export function neg(t: Time): Time {
  return t.num === 0 ? TIME_ZERO : { num: -t.num, den: t.den };
}

export function abs(t: Time): Time {
  return t.num < 0 ? { num: -t.num, den: t.den } : t;
}

/** Sum of a list, left to right. */
export function sum(times: readonly Time[]): Time {
  let acc = TIME_ZERO;
  for (const t of times) acc = add(acc, t);
  return acc;
}

/** Multiply a Time by an integer. */
export function mulInt(t: Time, k: number): Time {
  if (!Number.isInteger(k)) throw new TimeError(`mulInt expects an integer, got ${k}`);
  if (k === 0 || t.num === 0) return TIME_ZERO;
  const g = gcdNum(k, t.den);
  const kr = k / g;
  const den = t.den / g;
  const num = t.num * kr;
  if (Number.isSafeInteger(num)) return time(num, den);
  return fromBig(BigInt(t.num) * BigInt(kr), BigInt(den));
}

/** Multiply a Time by a rational (also used for Time × FrameRate → frame count). */
export function mulRational(t: Time, r: { readonly num: number; readonly den: number }): Time {
  if (t.num === 0 || r.num === 0) return TIME_ZERO;
  // Cross-cancel before multiplying to keep the intermediates small.
  const g1 = gcdNum(t.num, r.den);
  const g2 = gcdNum(r.num, t.den);
  const n1 = t.num / g1;
  const n2 = r.num / g2;
  const d1 = t.den / g2;
  const d2 = r.den / g1;
  const num = n1 * n2;
  const den = d1 * d2;
  if (Number.isSafeInteger(num) && Number.isSafeInteger(den)) return time(num, den);
  return fromBig(BigInt(n1) * BigInt(n2), BigInt(d1) * BigInt(d2));
}

/** Divide a Time by a rational. */
export function divRational(t: Time, r: { readonly num: number; readonly den: number }): Time {
  if (r.num === 0) throw new TimeError('Division by zero');
  return mulRational(t, { num: r.den, den: r.num });
}

/**
 * Scale by an arbitrary float factor (e.g. clip speed). The factor is converted to
 * an exact rational first, so the result stays exact and reproducible.
 */
export function scale(t: Time, factor: number, maxDen = 1_000_000): Time {
  return mulRational(t, fromSeconds(factor, maxDen));
}

/** a / b as a plain float ratio. */
export function ratio(a: Time, b: Time): number {
  if (b.num === 0) throw new TimeError('Division by zero');
  return (a.num * b.den) / (a.den * b.num);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export function cmp(a: Time, b: Time): -1 | 0 | 1 {
  if (a.den === b.den) return a.num < b.num ? -1 : a.num > b.num ? 1 : 0;
  const sa = Math.sign(a.num);
  const sb = Math.sign(b.num);
  if (sa !== sb) return sa < sb ? -1 : 1;

  const l = a.num * b.den;
  const r = b.num * a.den;
  if (Number.isSafeInteger(l) && Number.isSafeInteger(r)) {
    return l < r ? -1 : l > r ? 1 : 0;
  }
  const bl = BigInt(a.num) * BigInt(b.den);
  const br = BigInt(b.num) * BigInt(a.den);
  return bl < br ? -1 : bl > br ? 1 : 0;
}

export function eq(a: Time, b: Time): boolean {
  return a.num === b.num && a.den === b.den;
}
export function lt(a: Time, b: Time): boolean {
  return cmp(a, b) < 0;
}
export function lte(a: Time, b: Time): boolean {
  return cmp(a, b) <= 0;
}
export function gt(a: Time, b: Time): boolean {
  return cmp(a, b) > 0;
}
export function gte(a: Time, b: Time): boolean {
  return cmp(a, b) >= 0;
}
export function isZero(t: Time): boolean {
  return t.num === 0;
}
export function isNegative(t: Time): boolean {
  return t.num < 0;
}
export function isPositive(t: Time): boolean {
  return t.num > 0;
}
export function sign(t: Time): -1 | 0 | 1 {
  return t.num < 0 ? -1 : t.num > 0 ? 1 : 0;
}

export function min(a: Time, b: Time): Time {
  return cmp(a, b) <= 0 ? a : b;
}
export function max(a: Time, b: Time): Time {
  return cmp(a, b) >= 0 ? a : b;
}
export function clamp(t: Time, lo: Time, hi: Time): Time {
  if (cmp(lo, hi) > 0) throw new TimeError('clamp: lo must be <= hi');
  return cmp(t, lo) < 0 ? lo : cmp(t, hi) > 0 ? hi : t;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

export type SnapMode = 'floor' | 'ceil' | 'round';

/** Snap `t` onto a frame boundary at `rate`. */
export function snapToFrame(t: Time, rate: FrameRate, mode: SnapMode = 'round'): Time {
  const f =
    mode === 'floor' ? floorFrames(t, rate) : mode === 'ceil' ? ceilFrames(t, rate) : roundFrames(t, rate);
  return fromFrames(f, rate);
}

/** Snap `t` onto an audio sample boundary at `sampleRate`. */
export function snapToSample(t: Time, sampleRate: number, mode: SnapMode = 'round'): Time {
  const s =
    mode === 'floor'
      ? floorSamples(t, sampleRate)
      : mode === 'ceil'
        ? ceilSamples(t, sampleRate)
        : roundSamples(t, sampleRate);
  return fromSamples(s, sampleRate);
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export function range(start: Time, duration: Time): TimeRange {
  if (isNegative(duration)) throw new TimeError('TimeRange duration must be >= 0');
  return { start, duration };
}

export function rangeFromBounds(start: Time, end: Time): TimeRange {
  return range(start, sub(end, start));
}

export function rangeEnd(r: TimeRange): Time {
  return add(r.start, r.duration);
}

export function rangeIsEmpty(r: TimeRange): boolean {
  return isZero(r.duration);
}

/** Half-open containment: start <= t < end. */
export function rangeContains(r: TimeRange, t: Time): boolean {
  return gte(t, r.start) && lt(t, rangeEnd(r));
}

/** True when the half-open ranges share at least one instant. */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return lt(a.start, rangeEnd(b)) && lt(b.start, rangeEnd(a));
}

/** Intersection, or null when they do not overlap. */
export function intersect(a: TimeRange, b: TimeRange): TimeRange | null {
  const start = max(a.start, b.start);
  const end = min(rangeEnd(a), rangeEnd(b));
  return lt(start, end) ? rangeFromBounds(start, end) : null;
}

/** Smallest range covering both. */
export function rangeUnion(a: TimeRange, b: TimeRange): TimeRange {
  return rangeFromBounds(min(a.start, b.start), max(rangeEnd(a), rangeEnd(b)));
}

/** Shift a range along the timeline. */
export function rangeShift(r: TimeRange, by: Time): TimeRange {
  return { start: add(r.start, by), duration: r.duration };
}

// ---------------------------------------------------------------------------
// Timecode (SMPTE)
// ---------------------------------------------------------------------------

/** Drop-frame timecode is only defined for 29.97 and 59.94. */
export function supportsDropFrame(rate: FrameRate): boolean {
  const r = frameRate(rate.num, rate.den);
  return r.den === 1001 && (r.num === 30000 || r.num === 60000);
}

function dropFrameCount(rate: FrameRate): number {
  // 2 frames per minute at 29.97, 4 at 59.94.
  return nominalFps(rate) / 15;
}

export interface TimecodeOptions {
  /** Use drop-frame counting. Defaults to true when the rate supports it. */
  readonly dropFrame?: boolean;
  /** Emit a sign for negative times (default true). */
  readonly signed?: boolean;
}

function resolveDropFrame(rate: FrameRate, opts: TimecodeOptions | undefined): boolean {
  const want = opts?.dropFrame ?? supportsDropFrame(rate);
  if (want && !supportsDropFrame(rate)) {
    throw new TimeError(`Drop-frame timecode is not defined for ${rate.num}/${rate.den} fps`);
  }
  return want;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Frame index → "HH:MM:SS:FF" (non-drop) or "HH:MM:SS;FF" (drop-frame).
 * Wraps at 24 hours, as SMPTE does.
 */
export function framesToTimecode(frames: number, rate: FrameRate, opts?: TimecodeOptions): string {
  if (!Number.isInteger(frames)) throw new TimeError(`frames must be an integer, got ${frames}`);
  const df = resolveDropFrame(rate, opts);
  const signed = opts?.signed ?? true;
  const negative = frames < 0;
  let f = negative ? -frames : frames;

  const nominal = nominalFps(rate);
  const framesPerHour = nominal * 3600 - (df ? dropFrameCount(rate) * 54 : 0);
  // 54 = 9 dropping minutes per 10-minute block × 6 blocks per hour.
  const framesPer24h = framesPerHour * 24;
  f %= framesPer24h;

  let counted = f;
  if (df) {
    const drop = dropFrameCount(rate);
    const framesPer10Min = nominal * 600 - drop * 9;
    const framesPerMin = nominal * 60 - drop;
    const block = Math.floor(f / framesPer10Min);
    const rem = f % framesPer10Min;
    counted = f + drop * 9 * block + (rem > drop ? drop * Math.floor((rem - drop) / framesPerMin) : 0);
  }

  const ff = counted % nominal;
  const ss = Math.floor(counted / nominal) % 60;
  const mm = Math.floor(counted / (nominal * 60)) % 60;
  const hh = Math.floor(counted / (nominal * 3600)) % 24;

  const sep = df ? ';' : ':';
  const prefix = negative && signed ? '-' : '';
  return `${prefix}${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${sep}${pad2(ff)}`;
}

/** "HH:MM:SS:FF" / "HH:MM:SS;FF" → frame index. */
export function timecodeToFrames(tc: string, rate: FrameRate, opts?: TimecodeOptions): number {
  const m = /^(-)?(\d{1,2}):(\d{1,2}):(\d{1,2})([:;.])(\d{1,3})$/.exec(tc.trim());
  if (!m) throw new TimeError(`Malformed timecode: "${tc}"`);

  const negative = m[1] === '-';
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  const ss = Number(m[4]);
  const sep = m[5]!;
  const ff = Number(m[6]);

  // An explicit option wins; otherwise the separator declares the counting mode
  // (';' or '.' = drop-frame, ':' = non-drop).
  const df = resolveDropFrame(rate, { dropFrame: opts?.dropFrame ?? (sep !== ':') });

  const nominal = nominalFps(rate);
  if (mm > 59 || ss > 59) throw new TimeError(`Timecode out of range: "${tc}"`);
  if (ff >= nominal) throw new TimeError(`Frame ${ff} is out of range for ${nominal} fps: "${tc}"`);

  let frames: number;
  if (df) {
    const drop = dropFrameCount(rate);
    const totalMinutes = hh * 60 + mm;
    if (ss === 0 && mm % 10 !== 0 && ff < drop) {
      throw new TimeError(`"${tc}" is not a valid drop-frame timecode (frame ${ff} is dropped)`);
    }
    frames =
      nominal * 3600 * hh +
      nominal * 60 * mm +
      nominal * ss +
      ff -
      drop * (totalMinutes - Math.floor(totalMinutes / 10));
  } else {
    frames = ((hh * 60 + mm) * 60 + ss) * nominal + ff;
  }
  return negative ? -frames : frames;
}

/** Time → SMPTE timecode string at `rate`. */
export function toTimecode(t: Time, rate: FrameRate, opts?: TimecodeOptions): string {
  return framesToTimecode(floorFrames(t, rate), rate, opts);
}

/** SMPTE timecode string → Time at `rate`. */
export function fromTimecode(tc: string, rate: FrameRate, opts?: TimecodeOptions): Time {
  return fromFrames(timecodeToFrames(tc, rate, opts), rate);
}

// ---------------------------------------------------------------------------
// Human-readable formatting
// ---------------------------------------------------------------------------

export interface DurationFormatOptions {
  /** Decimal places on the seconds field (0–3). Default 3. */
  readonly decimals?: 0 | 1 | 2 | 3;
  /** Always show the hours field. Default false (shown only when non-zero). */
  readonly forceHours?: boolean;
}

/** "1:23:45.678" — for durations and readouts where frames are not meaningful. */
export function formatDuration(t: Time, opts?: DurationFormatOptions): string {
  const decimals = opts?.decimals ?? 3;
  const negative = isNegative(t);
  const a = abs(t);

  const scaleFactor = 10 ** decimals;
  const totalUnits = idivRound(a.num * scaleFactor, a.den);
  const units = totalUnits % scaleFactor;
  const totalSeconds = (totalUnits - units) / scaleFactor;

  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);

  const frac = decimals > 0 ? `.${String(units).padStart(decimals, '0')}` : '';
  const head = hh > 0 || opts?.forceHours ? `${hh}:${pad2(mm)}` : String(mm);
  return `${negative ? '-' : ''}${head}:${pad2(ss)}${frac}`;
}

/** Compact debug form, e.g. "1001/30000". */
export function debugTime(t: Time): string {
  return `${t.num}/${t.den}`;
}
