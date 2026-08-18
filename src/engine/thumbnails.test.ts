/**
 * Choosing where to sample thumbnails, and what to key them on.
 *
 * The cache itself needs a decoder and a canvas, so these cover the two pure
 * decisions it makes — both of which were bugs in the system this replaces.
 */

import { describe, expect, it } from 'vitest';
import { heightTierFor, quantiseDensity, sampleTimes, ThumbnailCache } from './thumbnails';
import type { MediaLibrary } from './media';
import type { AssetId } from '../model/types';

describe('quantising the density a zoom asks for', () => {
  it('lands on a power of two, so nearby zooms share decoded frames', () => {
    for (const wanted of [0.3, 1.1, 3.7, 9, 17.5]) {
      const density = quantiseDensity(wanted);
      expect(Number.isInteger(Math.log2(density))).toBe(true);
    }
  });

  it('never gives back less than was asked for, so cells are not stretched', () => {
    for (const wanted of [0.3, 1.1, 3.7, 9, 17.5]) {
      expect(quantiseDensity(wanted)).toBeGreaterThanOrEqual(wanted);
    }
  });

  it('collapses a whole range of zooms onto one tier', () => {
    // Everything between two powers of two shares a tier; this is what stops a wheel
    // notch from starting a fresh decode, which the old float key did every time.
    const tiers = new Set([2.1, 2.5, 3, 3.5, 3.9].map(quantiseDensity));
    expect(tiers.size).toBe(1);
  });
});

describe('choosing a thumbnail height', () => {
  it('takes the smallest tier that still covers the lane, so it only shrinks', () => {
    expect(heightTierFor(71)).toBe(160);
    expect(heightTierFor(160)).toBe(160);
    expect(heightTierFor(161)).toBe(320);
  });

  it('stays on the largest tier rather than upscaling without limit', () => {
    expect(heightTierFor(4000)).toBe(320);
  });
});

describe('where a filmstrip samples its source', () => {
  const keyframes = [0, 2, 4, 6, 8];

  it('takes the keyframe inside each cell when there is one per cell', () => {
    // A keyframe decodes alone; anything else needs the whole run since the last one.
    expect(sampleTimes(keyframes, 10, 0.5, [0, 1, 2, 3, 4])).toEqual([0, 2, 4, 6, 8]);
  });

  it('starts each cell at its own first keyframe, so a strip cannot run one cell late', () => {
    // Cells a hair wider than the keyframe interval, which happens whenever the audio
    // runs past the picture. Cell 0 must still show the frame at 0.
    const times = sampleTimes(keyframes, 10.0035, 5 / 10.0035, [0, 1, 2, 3, 4]);
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]!);
  });

  it('samples the middle of each cell when keyframes are too sparse to use', () => {
    expect(sampleTimes([0, 5], 10, 1, [0, 1, 2])).toEqual([0.5, 1.5, 2.5]);
  });

  it('decodes a cell exactly rather than repeat the keyframe next door', () => {
    // Enough keyframes on average for one per cell, but unevenly placed: cell 3 has
    // none of its own, and repeating cell 2's picture would make the strip stutter.
    const uneven = [0, 0.5, 1, 2, 4, 5, 6, 7, 8, 9];
    const times = sampleTimes(uneven, 10, 1, [0, 1, 2, 3, 4]);
    expect(times).toEqual([0, 1, 2, 3.5, 4]);
    expect(new Set(times).size).toBe(times.length);
  });

  it('serves a run of cells starting part-way through the source', () => {
    expect(sampleTimes(keyframes, 10, 0.5, [3, 4])).toEqual([6, 8]);
  });

  it('keeps every sample inside the source', () => {
    for (const time of sampleTimes([0, 5], 10, 0.2, [0, 1])) {
      expect(time).toBeLessThan(10);
    }
  });
});


/**
 * A source that answers instantly and yields no frames, so the cache runs its whole
 * request cycle without needing a decoder or a canvas.
 */
function silentMedia(hang = false): MediaLibrary {
  return {
    getStill: () => null,
    keyframeTimes: async () => {
      if (hang) await new Promise(() => undefined);
      return [];
    },
    // eslint-disable-next-line require-yield
    framesAt: async function* () {
      return;
    },
  } as unknown as MediaLibrary;
}

const ASSET_ID = 'asset' as AssetId;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('telling a clip its picture is on the way', () => {
  it('reports warming up as soon as frames are asked for, before any decoding', () => {
    // Set synchronously inside `request`, so a clip placed a moment ago can say it is
    // working on the very next render rather than after a decode has come back.
    const cache = new ThumbnailCache(silentMedia(true), () => undefined);
    expect(cache.isWarmingUp(ASSET_ID)).toBe(false);

    cache.request(ASSET_ID, 60, 1, 160, [0, 1, 2]);

    expect(cache.isWarmingUp(ASSET_ID)).toBe(true);
  });

  it('stops reporting it once the request is done, even if nothing decoded', async () => {
    // A source that yields no frames still has to clear the flag, or a clip whose
    // media is unreadable would shimmer for the rest of the session.
    const cache = new ThumbnailCache(silentMedia(), () => undefined);
    cache.request(ASSET_ID, 60, 1, 160, [0, 1]);
    expect(cache.isWarmingUp(ASSET_ID)).toBe(true);

    await settle();
    await settle();

    expect(cache.isWarmingUp(ASSET_ID)).toBe(false);
  });

  it('does not count the same cell twice when a repaint asks again', async () => {
    // The painter re-requests the visible range on every repaint, so double-counting
    // would leave the flag stuck on after the first release.
    const cache = new ThumbnailCache(silentMedia(), () => undefined);
    cache.request(ASSET_ID, 60, 1, 160, [0, 1]);
    cache.request(ASSET_ID, 60, 1, 160, [0, 1]);

    await settle();
    await settle();

    expect(cache.isWarmingUp(ASSET_ID)).toBe(false);
  });

  it('says nothing about an asset nobody has asked for', () => {
    const cache = new ThumbnailCache(silentMedia(), () => undefined);
    expect(cache.isWarmingUp('other' as AssetId)).toBe(false);
  });

  it('tells the UI at once, so the shimmer is not held back by the decode', () => {
    const told: string[] = [];
    const cache = new ThumbnailCache(silentMedia(true), () => told.push('change'));
    cache.request(ASSET_ID, 60, 1, 160, [0]);
    expect(told.length).toBeGreaterThan(0);
  });
});
