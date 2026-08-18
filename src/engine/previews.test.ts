import { describe, expect, it } from 'vitest';
import type { AssetId } from '../model/types';
import {
  densityForZoom,
  PreviewCache,
  sampleTimes,
  type Filmstrip,
  type Waveform,
  waveformDensityForZoom,
} from './previews';

function strip(frameCount: number, framesPerSecond: number): Filmstrip {
  return {
    url: `blob:${frameCount}`,
    frameWidth: 256,
    frameHeight: 160,
    frameCount,
    framesPerSecond,
    sourceSeconds: 0.6,
    posterUrl: `blob:poster-${frameCount}`,
    posterWidth: 440,
    posterHeight: 275,
  };
}

describe('filmstrip density', () => {
  it('keeps the displayed cells at the source aspect ratio', () => {
    const aspect = 16 / 9;
    const height = 70;
    const density = densityForZoom(480, 1, aspect, height);

    expect(480 / density / height).toBeCloseTo(aspect, 10);
  });

  it('uses fewer samples without changing cell shape when zoomed out', () => {
    const far = densityForZoom(4, 1, 16 / 9, 70);
    const near = densityForZoom(400, 1, 16 / 9, 70);

    expect(far).toBeCloseTo(near / 100, 10);
  });

  it('adapts to the source aspect and resized track height', () => {
    expect(densityForZoom(1_000, 1, 4 / 3, 90)).toBeCloseTo(1_000 / 120, 10);
    expect(densityForZoom(1_000, 1, 4 / 3, 45)).toBeCloseTo(1_000 / 60, 10);
  });

  it('accounts for clips stretched by playback speed', () => {
    const normal = densityForZoom(1_000, 1);
    expect(densityForZoom(1_000, 0.5)).toBeCloseTo(normal * 2, 10);
    expect(densityForZoom(1_000, -0.5)).toBeCloseTo(normal * 2, 10);
  });
});

describe('zoom-specific filmstrip selection', () => {
  it('places a same-count starter strip on the precise requested grid', () => {
    const assetId = 'asset' as AssetId;
    const base = strip(4, 4 / 0.6);
    const cache = new PreviewCache({} as never);
    const internals = cache as unknown as {
      filmstrips: Map<AssetId, Filmstrip | null>;
    };
    internals.filmstrips.set(assetId, base);

    // ceil(0.6 × 6) is still four frames, so the pixels can be reused while their
    // temporal cells adopt the exact new width.
    const preview = cache.getFilmstripPreview(assetId, 6);
    expect(preview?.framesPerSecond).toBe(6);
    expect(preview?.layers[0]?.sourceDuration).toBeCloseTo(4 / 6, 10);
  });

  it('falls back to a coarse cached strip instead of squeezing a finer one', () => {
    const assetId = 'asset' as AssetId;
    const base = strip(4, 4 / 0.6);
    const medium = strip(10, 10 / 0.6);
    const fine = strip(19, 19 / 0.6);
    const cache = new PreviewCache({} as never);
    type TestLevel = {
      requestedDensity: number;
      sourceSeconds: number;
      frameCount: number;
      tiles: Map<number, { url: string; firstFrame: number; frameCount: number }>;
      complete: boolean;
    };
    const level = (density: number, value: Filmstrip): TestLevel => ({
      requestedDensity: density,
      sourceSeconds: value.sourceSeconds,
      frameCount: value.frameCount,
      tiles: new Map([
        [0, { url: value.url, firstFrame: 0, frameCount: value.frameCount }],
      ]),
      complete: true,
    });
    const internals = cache as unknown as {
      filmstrips: Map<AssetId, Filmstrip | null>;
      filmstripTiers: Map<AssetId, Map<number, TestLevel>>;
    };
    internals.filmstrips.set(assetId, base);
    internals.filmstripTiers.set(assetId, new Map([[32, level(32, fine)]]));

    expect(cache.getFilmstripPreview(assetId, 1)?.layers[0]?.url).toBe(base.url);
    expect(cache.getFilmstripPreview(assetId, 16)?.layers[0]?.url).toBe(base.url);
    expect(cache.getFilmstripPreview(assetId, 32)?.layers[0]?.url).toBe(fine.url);

    internals.filmstripTiers.get(assetId)!.set(16, level(16, medium));
    expect(cache.getFilmstripPreview(assetId, 16)?.layers[0]?.url).toBe(medium.url);
  });

  it('layers partial target tiles over the complete coarse fallback', () => {
    const assetId = 'asset' as AssetId;
    const base = strip(4, 4 / 0.6);
    const cache = new PreviewCache({} as never);
    const partial = {
      requestedDensity: 32,
      sourceSeconds: 0.6,
      frameCount: 19,
      tiles: new Map([
        [1, { url: 'blob:target-tile', firstFrame: 8, frameCount: 8 }],
      ]),
      complete: false,
    };
    const internals = cache as unknown as {
      filmstrips: Map<AssetId, Filmstrip | null>;
      filmstripTiers: Map<AssetId, Map<number, typeof partial>>;
    };
    internals.filmstrips.set(assetId, base);
    internals.filmstripTiers.set(assetId, new Map([[32, partial]]));

    const preview = cache.getFilmstripPreview(assetId, 32);
    expect(preview?.layers.map((layer) => layer.url)).toEqual([
      'blob:target-tile',
      base.url,
    ]);
    expect(preview?.layers[0]).toMatchObject({
      sourceStart: 8 / 32,
      sourceDuration: 8 / 32,
    });
    expect(preview?.framesPerSecond).toBe(32);
  });
});

describe('zoom-specific waveform selection', () => {
  it('requests one raster column per device pixel', () => {
    expect(waveformDensityForZoom(2_000, 1, 1)).toBe(2_000);
    expect(waveformDensityForZoom(2_000, 1, 2)).toBe(4_000);
    expect(waveformDensityForZoom(2_000, 0.5, 2)).toBe(8_000);
    expect(waveformDensityForZoom(2_000, 1, 3)).toBe(4_000);
  });

  it('layers a sharp visible tile over the source-wide fallback', () => {
    const assetId = 'asset' as AssetId;
    const base: Waveform = {
      url: 'blob:wave-base',
      width: 2_400,
      height: 160,
      sourceSeconds: 6,
    };
    const partial = {
      requestedDensity: 4_000,
      sourceSeconds: 6,
      columnCount: 24_000,
      tiles: new Map([
        [4, { url: 'blob:wave-tile', firstColumn: 4_096, columnCount: 1_024 }],
      ]),
      complete: false,
    };
    const cache = new PreviewCache({} as never);
    const internals = cache as unknown as {
      waveforms: Map<AssetId, Waveform | null>;
      waveformTiers: Map<AssetId, Map<number, typeof partial>>;
    };
    internals.waveforms.set(assetId, base);
    internals.waveformTiers.set(assetId, new Map([[4_000, partial]]));

    const preview = cache.getWaveformPreview(assetId, 4_000);
    expect(preview?.layers.map((layer) => layer.url)).toEqual([
      'blob:wave-tile',
      base.url,
    ]);
    expect(preview?.layers[0]).toMatchObject({
      sourceStart: 4_096 / 4_000,
      sourceDuration: 1_024 / 4_000,
    });
  });
});

const ASSET = 'asset' as AssetId;

/** A source with keyframes at the given times and nothing else worth knowing. */
function keyframesAt(times: readonly number[]) {
  return { keyframeTimes: async () => times };
}

describe('where a filmstrip samples its source', () => {
  it('takes the keyframe inside each slot when there is one per slot', async () => {
    const times = await sampleTimes(keyframesAt([0, 2, 4, 6, 8]), ASSET, 10, 5, 2);
    // A keyframe decodes on its own; a frame in between costs the whole run
    // since the last keyframe. Slot 0 must therefore be the frame at 0, not 2.
    expect(times).toEqual([0, 2, 4, 6, 8]);
  });

  it('starts each slot at its own first keyframe, so a strip cannot run one cell late', async () => {
    // Keyframes on the 2 s boundaries, and slots a hair wider than 2 s because the
    // audio runs on past the picture: cell 0 must still show the frame at 0.
    const times = await sampleTimes(keyframesAt([0, 2, 4, 6, 8]), ASSET, 10.0035, 5, 10.0035 / 5);
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]!);
  });

  it('samples the middle of each slot when keyframes are too sparse to use', async () => {
    const times = await sampleTimes(keyframesAt([0, 5]), ASSET, 10, 10, 1);
    expect(times).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]);
  });

  it('decodes a slot exactly rather than repeat the keyframe next door', async () => {
    // Enough keyframes on average for one per slot, but unevenly placed: slot 3
    // has none of its own, and showing slot 2's again would make the strip stutter.
    const times = await sampleTimes(keyframesAt([0, 0.5, 1, 2, 4, 5, 6, 7, 8, 9]), ASSET, 10, 10, 1);
    expect(times).toEqual([0, 1, 2, 3.5, 4, 5, 6, 7, 8, 9]);
    expect(new Set(times).size).toBe(times.length);
  });

  it('starts from the slot it is asked to, for a tile part-way through the source', async () => {
    const times = await sampleTimes(keyframesAt([0, 2, 4, 6, 8]), ASSET, 10, 2, 2, 3);
    expect(times).toEqual([6, 8]);
  });

  it('keeps the last sample inside the source', async () => {
    const times = await sampleTimes(keyframesAt([0, 5]), ASSET, 10, 2, 5);
    expect(times[1]).toBeLessThan(10);
  });
});
