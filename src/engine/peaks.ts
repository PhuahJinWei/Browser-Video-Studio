/**
 * Waveform peaks, as a pyramid of min/max pairs rather than as pictures.
 *
 * The old design rasterised waveforms into images, cut them into tiles per zoom
 * level, and painted them as CSS backgrounds. Every property of that arrangement
 * fought the thing being drawn: a waveform is a hard-edged one-pixel-per-column
 * signal, and a CSS background is a photograph. It had to be re-encoded at every
 * zoom, blurred whenever the browser sampled it at a fractional device offset,
 * silently truncated when a strip exceeded the encoder's 16,383px limit, and it
 * needed blob URLs, eviction and abort plumbing to manage the images.
 *
 * A pyramid is what audio editors actually keep. Decode once, reduce to min/max per
 * bucket, and halve repeatedly. Then *drawing* is a loop over an array: exact at any
 * zoom, sharp at any device ratio, no encoding, no URLs, no cache invalidation. Zoom
 * becomes a repaint instead of a fetch.
 *
 * Cost: `Int8` min and max per 64 samples is 2 bytes per 64 samples, plus a third
 * again for the coarser levels — about 4 MB per hour of 48 kHz audio, regardless of
 * channel count.
 */

import * as T from '../model/time';
import type { Time } from '../model/types';

/** Source samples covered by one bucket of the finest level. */
const BASE_SAMPLES_PER_BUCKET = 64;
/** Each level covers this many buckets of the one below. */
const LEVEL_FACTOR = 4;
/**
 * Levels built above the base.
 *
 * The coarsest covers 64 × 4^5 = 65,536 samples, about 1.4 s at 48 kHz — past the
 * point where a whole hour fits on screen, so no zoom needs anything coarser.
 */
const LEVEL_COUNT = 6;

/** Peaks at one resolution. `min`/`max` are −127..127, meaning −1..1. */
export interface PeakLevel {
  readonly samplesPerBucket: number;
  readonly min: Int8Array;
  readonly max: Int8Array;
  /** Buckets filled so far. Trails the array length while a decode is running. */
  count: number;
}

export interface Peaks {
  readonly sampleRate: number;
  readonly durationSeconds: number;
  /** Finest first. Every level covers the whole source; only `count` grows. */
  readonly levels: readonly PeakLevel[];
  /** Seconds of source reduced so far, for progressive drawing. */
  filledSeconds: number;
  complete: boolean;
}

function levelSizes(totalSamples: number): number[] {
  const sizes: number[] = [];
  for (let level = 0; level < LEVEL_COUNT; level++) {
    const perBucket = BASE_SAMPLES_PER_BUCKET * LEVEL_FACTOR ** level;
    sizes.push(Math.max(1, Math.ceil(totalSamples / perBucket)));
  }
  return sizes;
}

export function createPeaks(sampleRate: number, durationSeconds: number): Peaks {
  const totalSamples = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  const levels = levelSizes(totalSamples).map((size, level) => ({
    samplesPerBucket: BASE_SAMPLES_PER_BUCKET * LEVEL_FACTOR ** level,
    min: new Int8Array(size),
    max: new Int8Array(size),
    count: 0,
  }));
  return { sampleRate, durationSeconds, levels, filledSeconds: 0, complete: false };
}

function quantise(value: number): number {
  // Clamped to −127 so that negating a stored value is always representable.
  return Math.max(-127, Math.min(127, Math.round(value * 127)));
}

/**
 * Reduces decoded audio into a pyramid, one chunk at a time.
 *
 * Buckets are addressed by absolute sample index, so chunks may arrive with gaps or
 * slight overlaps — which they do, since decoders emit whatever their packets hold —
 * without the pyramid drifting out of step with the source.
 */
export class PeaksBuilder {
  private readonly peaks: Peaks;
  /** Bucket currently being accumulated at the base level, and its running peaks. */
  private bucket = -1;
  private low = 0;
  private high = 0;

  constructor(sampleRate: number, durationSeconds: number) {
    this.peaks = createPeaks(sampleRate, durationSeconds);
  }

  get result(): Peaks {
    return this.peaks;
  }

  /** Fold one decoded buffer in. `startSample` is its first sample's source index. */
  addChannels(channels: readonly Float32Array[], startSample: number, length: number): void {
    const first = channels[0];
    if (!first) return;

    for (let i = 0; i < length; i++) {
      const sample = startSample + i;
      const bucket = Math.floor(sample / BASE_SAMPLES_PER_BUCKET);
      if (bucket !== this.bucket) {
        this.flushBucket();
        this.bucket = bucket;
        this.low = 0;
        this.high = 0;
      }
      for (const channel of channels) {
        const value = channel[i] ?? 0;
        if (value < this.low) this.low = value;
        if (value > this.high) this.high = value;
      }
    }
  }

  /** Finish the bucket in progress and mark the pyramid done. */
  finish(): Peaks {
    this.flushBucket();
    this.bucket = -1;
    this.peaks.complete = true;
    this.peaks.filledSeconds = this.peaks.durationSeconds;
    return this.peaks;
  }

  private flushBucket(): void {
    if (this.bucket < 0) return;
    const base = this.peaks.levels[0]!;
    if (this.bucket >= base.min.length) return;

    base.min[this.bucket] = quantise(this.low);
    base.max[this.bucket] = quantise(this.high);
    base.count = Math.max(base.count, this.bucket + 1);
    this.peaks.filledSeconds =
      (base.count * BASE_SAMPLES_PER_BUCKET) / this.peaks.sampleRate;

    // Fold upward. A bucket at level L covers LEVEL_FACTOR buckets at L−1, so the
    // moment the last of those is written its parent can be recomputed and no level
    // is ever more than one bucket behind the base.
    let childIndex = this.bucket;
    for (let level = 1; level < this.peaks.levels.length; level++) {
      const child = this.peaks.levels[level - 1]!;
      const parent = this.peaks.levels[level]!;
      const parentIndex = Math.floor(childIndex / LEVEL_FACTOR);
      if (parentIndex >= parent.min.length) break;

      const from = parentIndex * LEVEL_FACTOR;
      const to = Math.min(child.count, from + LEVEL_FACTOR);
      let low = 0;
      let high = 0;
      for (let i = from; i < to; i++) {
        const childLow = child.min[i]!;
        const childHigh = child.max[i]!;
        if (childLow < low) low = childLow;
        if (childHigh > high) high = childHigh;
      }
      parent.min[parentIndex] = low;
      parent.max[parentIndex] = high;
      parent.count = Math.max(parent.count, parentIndex + 1);
      childIndex = parentIndex;
    }
  }
}

/**
 * The finest level whose buckets are no wider than one drawn column.
 *
 * Reading a level finer than the column would work but scans more of the array than
 * the column can show; reading a coarser one would flatten peaks the column has room
 * for. This picks the one that draws every peak with the least work.
 */
export function levelForColumn(peaks: Peaks, samplesPerColumn: number): number {
  let chosen = 0;
  for (let level = 0; level < peaks.levels.length; level++) {
    if (peaks.levels[level]!.samplesPerBucket <= samplesPerColumn) chosen = level;
    else break;
  }
  return chosen;
}

/**
 * Fill `min`/`max` with one pair per column over a source range, in −1..1.
 *
 * Columns past the end of what has been decoded are left at zero, which is what
 * makes a waveform fill in from the left as its source is read rather than appear
 * all at once.
 */
export function readPeaks(
  peaks: Peaks,
  fromSeconds: number,
  secondsPerColumn: number,
  columns: number,
  min: Float32Array,
  max: Float32Array,
): void {
  const samplesPerColumn = secondsPerColumn * peaks.sampleRate;
  const level = peaks.levels[levelForColumn(peaks, samplesPerColumn)]!;
  const bucketsPerColumn = samplesPerColumn / level.samplesPerBucket;
  const firstBucket = (fromSeconds * peaks.sampleRate) / level.samplesPerBucket;

  for (let column = 0; column < columns; column++) {
    const start = firstBucket + column * bucketsPerColumn;
    const end = start + bucketsPerColumn;
    // Rounded, not floor/ceil: those widen every column by up to a bucket at each
    // end, so neighbours overlap and a peak bleeds sideways into columns that do not
    // contain it. Rounding makes the columns tile exactly -- each one ends where the
    // next begins. The floor of `from + 1` keeps a column that is narrower than a
    // bucket, which happens when zoomed past the finest level, from coming back empty.
    const from = Math.max(0, Math.round(start));
    const to = Math.min(level.count, Math.max(from + 1, Math.round(end)));

    let low = 0;
    let high = 0;
    for (let i = from; i < to; i++) {
      const bucketLow = level.min[i]!;
      const bucketHigh = level.max[i]!;
      if (bucketLow < low) low = bucketLow;
      if (bucketHigh > high) high = bucketHigh;
    }
    min[column] = low / 127;
    max[column] = high / 127;
  }
}

/** Seconds of source one pyramid bucket of the finest level covers. */
export function baseBucketSeconds(sampleRate: number): number {
  return BASE_SAMPLES_PER_BUCKET / sampleRate;
}

/** Total bytes a pyramid holds, for reporting and for cache budgeting. */
export function peaksByteLength(peaks: Peaks): number {
  return peaks.levels.reduce((sum, level) => sum + level.min.length * 2, 0);
}

/** Convenience for callers holding a `Time` rather than seconds. */
export function peaksForDuration(sampleRate: number, duration: Time): Peaks {
  return createPeaks(sampleRate, T.toSeconds(duration));
}
