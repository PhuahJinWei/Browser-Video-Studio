/**
 * The waveform peak pyramid.
 *
 * Every level has to describe the same signal, because which one a zoom reads from
 * changes as you scroll: a peak that survives at one level and vanishes at the next
 * is a waveform that changes shape when you zoom, which is exactly what the old
 * image-tile system did and what this replaces.
 */

import { describe, expect, it } from 'vitest';
import { levelForColumn, PeaksBuilder, readPeaks, peaksByteLength } from './peaks';

const RATE = 48_000;

/** Build a pyramid over one channel, fed in chunks of `chunk` samples. */
function build(samples: Float32Array, chunk = 4096, rate = RATE) {
  const builder = new PeaksBuilder(rate, samples.length / rate);
  for (let at = 0; at < samples.length; at += chunk) {
    const slice = samples.subarray(at, Math.min(samples.length, at + chunk));
    builder.addChannels([slice], at, slice.length);
  }
  return builder.finish();
}

function columns(peaks: ReturnType<typeof build>, from: number, perColumn: number, count: number) {
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  readPeaks(peaks, from, perColumn, count, min, max);
  return { min: [...min], max: [...max] };
}

describe('reducing audio to peaks', () => {
  it('keeps the extremes of the signal, not its average', () => {
    // Mostly silent with a single loud sample: an averaging reduction would lose it.
    const samples = new Float32Array(RATE);
    samples[12_345] = 0.9;
    samples[12_346] = -0.75;
    const peaks = build(samples);

    const { min, max } = columns(peaks, 0, 1, 1);
    expect(max[0]).toBeCloseTo(0.9, 1);
    expect(min[0]).toBeCloseTo(-0.75, 1);
  });

  it('keeps that peak at every level, so zooming out cannot lose it', () => {
    const samples = new Float32Array(RATE * 4);
    samples[100_000] = 1;
    const peaks = build(samples);

    for (const level of peaks.levels) {
      const perColumn = (level.samplesPerBucket / RATE) * 1.5;
      const count = Math.ceil(4 / perColumn);
      const { max } = columns(peaks, 0, perColumn, count);
      expect(Math.max(...max)).toBeCloseTo(1, 1);
    }
  });

  it('folds every channel into the same pair, so nothing hides in one side', () => {
    const left = new Float32Array(RATE);
    const right = new Float32Array(RATE);
    right[100] = 0.8;
    const builder = new PeaksBuilder(RATE, 1);
    builder.addChannels([left, right], 0, RATE);
    const peaks = builder.finish();

    const { max } = columns(peaks, 0, 1, 1);
    expect(max[0]).toBeCloseTo(0.8, 1);
  });

  it('is unaffected by the size the decoder happens to hand samples over in', () => {
    const samples = new Float32Array(RATE);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 40) * (i / samples.length);

    const asOneChunk = columns(build(samples, samples.length), 0, 0.01, 100);
    const inSmallChunks = columns(build(samples, 997), 0, 0.01, 100);

    expect(inSmallChunks).toEqual(asOneChunk);
  });
});

describe('choosing a level to draw from', () => {
  it('takes a finer level as the columns get narrower', () => {
    const peaks = build(new Float32Array(RATE * 8));
    const wide = levelForColumn(peaks, 65_536);
    const narrow = levelForColumn(peaks, 64);

    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBe(0);
  });

  it('never picks a level whose buckets are wider than the column', () => {
    const peaks = build(new Float32Array(RATE * 8));
    for (const samplesPerColumn of [64, 100, 1_000, 20_000, 1_000_000]) {
      const level = peaks.levels[levelForColumn(peaks, samplesPerColumn)]!;
      expect(level.samplesPerBucket).toBeLessThanOrEqual(Math.max(64, samplesPerColumn));
    }
  });
});

describe('reading columns', () => {
  it('lines a column up with the part of the source it covers', () => {
    // A burst in the third second only.
    const samples = new Float32Array(RATE * 4);
    for (let i = RATE * 2; i < RATE * 3; i++) samples[i] = 0.6;
    const peaks = build(samples);

    // Read fine enough that a bucket is small next to a column; at a coarse level
    // the bucket straddling the burst's edge legitimately carries it into the
    // neighbouring column, and no pyramid can do otherwise.
    const { max } = columns(peaks, 0, 0.05, 80);
    expect(max[0]).toBeCloseTo(0, 1);
    expect(max[30]).toBeCloseTo(0, 1);
    expect(max[50]).toBeCloseTo(0.6, 1);
    expect(max[79]).toBeCloseTo(0, 1);
  });

  it('tiles columns exactly, so a peak does not bleed into its neighbours', () => {
    // One loud bucket in an otherwise silent second, read at a column width that is
    // not a whole number of buckets -- the case where over-reading used to show.
    const samples = new Float32Array(RATE);
    for (let i = 20_000; i < 20_064; i++) samples[i] = 1;
    const peaks = build(samples);

    const { max } = columns(peaks, 0, 1 / 300, 300);
    const loud = max.filter((value) => value > 0.5).length;
    expect(loud).toBeLessThanOrEqual(2);
  });

  it('reads the same shape whichever offset the window starts at', () => {
    const samples = new Float32Array(RATE * 4);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 500);
    const peaks = build(samples);

    const whole = columns(peaks, 0, 0.05, 80);
    const second = columns(peaks, 2, 0.05, 40);

    for (let i = 0; i < 40; i++) {
      expect(second.max[i]).toBeCloseTo(whole.max[40 + i]!, 5);
      expect(second.min[i]).toBeCloseTo(whole.min[40 + i]!, 5);
    }
  });

  it('leaves columns past the decoded end empty, so it fills in as it reads', () => {
    const builder = new PeaksBuilder(RATE, 4);
    const half = new Float32Array(RATE * 2).fill(0.5);
    builder.addChannels([half], 0, half.length);

    const min = new Float32Array(4);
    const max = new Float32Array(4);
    readPeaks(builder.result, 0, 1, 4, min, max);

    expect(max[0]).toBeCloseTo(0.5, 1);
    expect(max[3]).toBe(0);
  });

  it('gives a column something to show even when zoomed past the finest bucket', () => {
    const samples = new Float32Array(RATE).fill(0.4);
    const peaks = build(samples);

    // A column narrower than one bucket of 64 samples.
    const { max } = columns(peaks, 0, 1 / RATE, 8);
    expect(Math.min(...max)).toBeCloseTo(0.4, 1);
  });
});

describe('what a pyramid costs', () => {
  it('stays near four bytes per hundred samples, whatever the channel count', () => {
    const peaks = build(new Float32Array(RATE * 60));
    const bytesPerSecond = peaksByteLength(peaks) / 60;

    // 2 bytes per 64 samples, plus a third again for the levels above it.
    expect(bytesPerSecond).toBeGreaterThan(1_000);
    expect(bytesPerSecond).toBeLessThan(2_500);
  });
});
