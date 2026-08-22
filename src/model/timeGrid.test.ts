/**
 * Why dragged times go on the frame grid.
 *
 * Exact rationals add by lowest common multiple, so a value that is repeatedly
 * added to a fresh pointer-derived delta grows a denominator until it no longer
 * fits a double. This is the arithmetic behind that, and the guard against it.
 */

import { describe, expect, it } from 'vitest';
import * as T from './time';

/** Pixel offsets and zooms as a session of dragging actually produces them. */
function* drags(count: number): Generator<{ zoom: number; offsetPx: number }> {
  let seed = 12345;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < count; i++) {
    yield { zoom: 60 + rand() * 400, offsetPx: (rand() - 0.5) * 300 };
  }
}

describe('adding a pointer delta to the last result', () => {
  it('compounds the denominator until the time cannot be represented', () => {
    let start = T.TIME_ZERO;
    let threw = false;
    let reached = 0;

    for (const { zoom, offsetPx } of drags(20)) {
      const delta = T.fromSeconds(offsetPx / zoom, 100_000);
      try {
        start = T.max(T.TIME_ZERO, T.add(start, delta));
        reached = start.den;
      } catch {
        threw = true;
        break;
      }
    }

    // Not a behaviour anyone wants — this is the bug, kept here so the fix below
    // is measured against something real rather than an assumption.
    expect(threw).toBe(true);
    expect(reached).toBeGreaterThan(1e9);
  });
});

describe('putting each result back on the frame grid', () => {
  it('holds the denominator still however long the session runs', () => {
    const rate = T.FPS_30;
    let start = T.TIME_ZERO;
    const seen = new Set<number>();

    for (const { zoom, offsetPx } of drags(500)) {
      const delta = T.fromSeconds(offsetPx / zoom, 100_000);
      start = T.snapToFrame(T.max(T.TIME_ZERO, T.add(start, delta)), rate);
      seen.add(start.den);
    }

    // Every denominator divides the frame duration's, so they cannot accumulate.
    const frameDen = T.frameDuration(rate).den;
    for (const den of seen) expect(frameDen % den).toBe(0);
  });

  it('holds for a fractional rate too, where the grid is not a round number', () => {
    const rate = T.FPS_29_97;
    let start = T.TIME_ZERO;

    for (const { zoom, offsetPx } of drags(500)) {
      const delta = T.fromSeconds(offsetPx / zoom, 100_000);
      start = T.snapToFrame(T.max(T.TIME_ZERO, T.add(start, delta)), rate);
    }

    expect(T.isFrameAligned(start, rate)).toBe(true);
    expect(start.den).toBeLessThanOrEqual(T.frameDuration(rate).den);
  });

  it('leaves a time that is already on the grid exactly where it is', () => {
    const rate = T.FPS_25;
    const onGrid = T.fromFrames(137, rate);
    expect(T.snapToFrame(onGrid, rate)).toEqual(onGrid);
  });
});
