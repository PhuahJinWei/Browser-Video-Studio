/**
 * Filmstrip thumbnails, as a cache of decoded frames rather than as pre-baked strips.
 *
 * The old design built one wide image covering the whole source, then a second set
 * of tiled images per zoom level. That meant decoding frames nobody was looking at,
 * re-encoding to WebP at every zoom (and silently losing everything past the
 * encoder's 16,383px width limit), and a tier/tile/eviction bookkeeping layer to
 * keep track of the images.
 *
 * What a timeline actually needs is the handful of frames under the viewport — at
 * 71px lanes and 16:9 that is about eight of them per screen. So: ask for those,
 * decode them in one sequential pass, keep them as `ImageBitmap`s, and let the
 * painter draw them. No encoding, no object URLs, no size limit, and the work scales
 * with what is visible instead of with how long the source is.
 */

import type { VideoSample } from 'mediabunny';
import type { AssetId } from '../model/types';
import type { MediaLibrary } from './media';

/**
 * Heights a thumbnail is decoded at, in device pixels.
 *
 * Two tiers rather than one per lane height: a cache keyed on a continuous size
 * would miss on every drag of the track divider. The painter picks the smallest tier
 * that is at least as tall as the lane, so a thumbnail is only ever scaled down.
 */
const HEIGHT_TIERS = [160, 320] as const;

/**
 * Thumbnails held before the least recently drawn are dropped, as a pixel budget.
 *
 * Counted in bytes rather than in frames because a 320px-tall 16:9 thumbnail is four
 * times the size of a 160px one, and a cap in frames would mean four times the memory
 * on a tall track without anything saying so. 48 MB is a few screenfuls at either tier.
 */
const CACHE_BYTES = 48 * 1024 * 1024;

/** Thumbnails decoded in one pass. Bigger batches block the decoder for longer. */
const BATCH = 24;

/** Nothing to do with quality: a still has one frame, and it is at time zero. */
const STILL_INDEX = 0;

export interface ThumbnailKey {
  readonly assetId: AssetId;
  /** Thumbnails per second of source. Always a power of two. */
  readonly density: number;
  readonly heightTier: number;
  readonly index: number;
}

interface Entry {
  bitmap: ImageBitmap;
  bytes: number;
  used: number;
  readonly assetId: AssetId;
}

function keyOf(key: ThumbnailKey): string {
  return `${key.assetId}|${key.density}|${key.heightTier}|${key.index}`;
}

/**
 * Snap a wanted density onto the power-of-two ladder.
 *
 * The old cache keyed levels on the raw density, which is a float derived from the
 * zoom — so every wheel notch created a fresh level that had to be decoded from
 * scratch, and a dozen half-finished levels accumulated behind it. Quantising means
 * a zoom either reuses what is already decoded or moves to a tier that is a clean
 * factor of two away, and there are only ever a handful of tiers in play.
 */
export function quantiseDensity(wanted: number): number {
  const clamped = Math.max(1 / 1024, Math.min(64, wanted));
  return 2 ** Math.ceil(Math.log2(clamped));
}

/** The tier a lane of this device height should draw from. */
export function heightTierFor(deviceHeight: number): number {
  return HEIGHT_TIERS.find((tier) => tier >= deviceHeight) ?? HEIGHT_TIERS[HEIGHT_TIERS.length - 1]!;
}

/**
 * Where to sample a source for thumbnails covering `indices` at `density`.
 *
 * Decoding is what a filmstrip costs, and where it costs is the keyframe: any other
 * frame needs every frame since the last keyframe decoded first, which on a long
 * clip with a sparse keyframe interval is dozens per thumbnail. A keyframe decodes
 * alone. So when the source has at least one keyframe per cell, each cell shows the
 * keyframe nearest its start — a coarse strip is a sample of the picture, not a
 * frame-accurate one. Zoom in far enough that cells are shorter than the keyframe
 * interval and it decodes exactly, which is also where being exact starts to matter.
 */
export function sampleTimes(
  keyframes: readonly number[],
  durationSeconds: number,
  density: number,
  indices: readonly number[],
): number[] {
  const cellSeconds = 1 / density;
  const last = Math.max(0, durationSeconds - Math.min(durationSeconds / 2, 0.000_001));
  const middleOf = (index: number): number => Math.min(last, (index + 0.5) * cellSeconds);

  const spacing = keyframes.length > 1 ? durationSeconds / keyframes.length : Infinity;
  if (spacing > cellSeconds) return indices.map(middleOf);

  const times: number[] = [];
  let cursor = 0;
  for (const index of indices) {
    const start = index * cellSeconds;
    const end = start + cellSeconds;
    // The first keyframe at or after the cell begins — the picture nearest its left
    // edge, which is where a thumbnail reads as belonging. Indices arrive sorted, so
    // the walk only ever goes forward.
    while (cursor < keyframes.length && keyframes[cursor]! < start) cursor++;
    const candidate = keyframes[cursor];
    times.push(candidate !== undefined && candidate < end ? Math.min(last, candidate) : middleOf(index));
  }
  return times;
}

/**
 * Decoded frames, kept ready to draw.
 *
 * Requests are coalesced per (asset, density, height): the painter calls on every
 * repaint with whatever is on screen, and only the frames that are missing and not
 * already being decoded start any work.
 */
export class ThumbnailCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Set<string>();
  private readonly jobs = new Map<string, Promise<void>>();
  /** Per asset, so a clip can be asked about its own state without a scan. */
  private readonly pendingPerAsset = new Map<AssetId, number>();
  private readonly cachedPerAsset = new Map<AssetId, number>();
  private bytes = 0;
  private clock = 0;

  constructor(
    private readonly media: MediaLibrary,
    /** Called when new thumbnails have landed and a repaint would show them. */
    private readonly onArrive: () => void,
  ) {}

  /**
   * True when an asset is being decoded and has nothing to show yet.
   *
   * Only the very first frames: once a clip has drawn something, later cells arrive
   * quietly, covered by the nearest-density fallback. A clip that announced every
   * fetch would flicker on every scroll, which says less than saying nothing.
   */
  isWarmingUp(assetId: AssetId): boolean {
    return (this.cachedPerAsset.get(assetId) ?? 0) === 0 && (this.pendingPerAsset.get(assetId) ?? 0) > 0;
  }

  private countPending(assetId: AssetId, delta: number): void {
    const next = (this.pendingPerAsset.get(assetId) ?? 0) + delta;
    if (next > 0) this.pendingPerAsset.set(assetId, next);
    else this.pendingPerAsset.delete(assetId);
  }

  private countCached(assetId: AssetId, delta: number): void {
    const next = (this.cachedPerAsset.get(assetId) ?? 0) + delta;
    if (next > 0) this.cachedPerAsset.set(assetId, next);
    else this.cachedPerAsset.delete(assetId);
  }

  /** A thumbnail if it is decoded, marking it as recently drawn. */
  get(key: ThumbnailKey): ImageBitmap | undefined {
    const entry = this.entries.get(keyOf(key));
    if (!entry) return undefined;
    entry.used = ++this.clock;
    return entry.bitmap;
  }

  /**
   * The nearest thumbnail already decoded at any density, for drawing something
   * rather than nothing while the exact one is on its way.
   *
   * Searching by source time rather than by index because the index means different
   * things at different densities. Coarser tiers first: they are the ones that exist
   * early, and a slightly wrong frame is a better placeholder than an empty cell.
   */
  nearest(assetId: AssetId, heightTier: number, seconds: number): ImageBitmap | undefined {
    for (let density = 1 / 1024; density <= 64; density *= 2) {
      const index = Math.floor(seconds * density);
      const entry = this.entries.get(keyOf({ assetId, density, heightTier, index }));
      if (entry) return entry.bitmap;
    }
    return undefined;
  }

  /**
   * Ensure these cells are decoded. Returns at once; `onArrive` reports progress.
   *
   * Indices already cached or already being decoded are dropped here, so calling
   * this on every repaint with the whole visible range costs a set lookup per cell.
   */
  request(
    assetId: AssetId,
    durationSeconds: number,
    density: number,
    heightTier: number,
    indices: readonly number[],
  ): void {
    const missing = indices.filter((index) => {
      const key = keyOf({ assetId, density, heightTier, index });
      return !this.entries.has(key) && !this.inFlight.has(key);
    });
    if (missing.length === 0) return;

    const batch = missing.slice(0, BATCH);
    for (const index of batch) {
      this.inFlight.add(keyOf({ assetId, density, heightTier, index }));
      this.countPending(assetId, 1);
    }
    // Said before any decoding starts, so a clip placed a moment ago can already
    // show that its picture is on the way.
    this.onArrive();

    const jobKey = `${assetId}|${density}|${heightTier}`;
    const previous = this.jobs.get(jobKey) ?? Promise.resolve();
    // Chained rather than run in parallel: concurrent range decodes on one file
    // compete for the same demuxer and finish later than they would in a queue.
    const job = previous
      .then(() => this.decode(assetId, durationSeconds, density, heightTier, batch))
      .catch(() => undefined)
      .finally(() => {
        if (this.jobs.get(jobKey) === job) this.jobs.delete(jobKey);
      });
    this.jobs.set(jobKey, job);
  }

  private async decode(
    assetId: AssetId,
    durationSeconds: number,
    density: number,
    heightTier: number,
    indices: readonly number[],
  ): Promise<void> {
    const release = (): void => {
      for (const index of indices) {
        const key = keyOf({ assetId, density, heightTier, index });
        if (this.inFlight.delete(key)) this.countPending(assetId, -1);
      }
      this.onArrive();
    };

    try {
      const still = this.media.getStill(assetId);
      if (still) {
        // A still has nothing to seek; every cell shows the same picture.
        const bitmap = await this.fit(still, still.width / still.height, heightTier);
        this.store({ assetId, density, heightTier, index: STILL_INDEX }, bitmap);
        for (const index of indices) {
          if (index === STILL_INDEX) continue;
          this.store({ assetId, density, heightTier, index }, await this.fit(still, still.width / still.height, heightTier));
        }
        this.onArrive();
        return;
      }

      const keyframes = await this.media.keyframeTimes(assetId).catch(() => [] as readonly number[]);
      const times = sampleTimes(keyframes, durationSeconds, density, indices);

      let at = 0;
      let landed = false;
      for await (const sample of this.media.framesAt(assetId, times)) {
        const index = indices[at++];
        if (index === undefined) {
          sample?.close();
          break;
        }
        if (!sample) continue;
        const bitmap = await this.fromSample(sample, heightTier);
        if (bitmap) {
          this.store({ assetId, density, heightTier, index }, bitmap);
          landed = true;
        }
      }
      if (landed) this.onArrive();
    } finally {
      release();
    }
  }

  private async fromSample(sample: VideoSample, heightTier: number): Promise<ImageBitmap | null> {
    const frame = sample.toVideoFrame();
    try {
      const aspect = frame.displayWidth / frame.displayHeight || 16 / 9;
      return await this.fit(frame, aspect, heightTier);
    } catch {
      return null;
    } finally {
      frame.close();
      sample.close();
    }
  }

  /** Scale a source frame into a thumbnail of the tier's height. */
  private async fit(
    image: CanvasImageSource,
    aspect: number,
    heightTier: number,
  ): Promise<ImageBitmap> {
    const width = Math.max(2, Math.round(heightTier * aspect));
    const canvas = new OffscreenCanvas(width, heightTier);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context for a thumbnail');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, width, heightTier);
    return createImageBitmap(canvas);
  }

  private store(key: ThumbnailKey, bitmap: ImageBitmap): void {
    const id = keyOf(key);
    const existing = this.entries.get(id);
    if (existing) {
      existing.bitmap.close();
      this.bytes -= existing.bytes;
    }
    const bytes = bitmap.width * bitmap.height * 4;
    if (!existing) this.countCached(key.assetId, 1);
    this.entries.set(id, { bitmap, bytes, used: ++this.clock, assetId: key.assetId });
    this.bytes += bytes;
    this.evict();
  }

  private evict(): void {
    if (this.bytes <= CACHE_BYTES) return;
    const byAge = [...this.entries.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [id, entry] of byAge) {
      if (this.bytes <= CACHE_BYTES) break;
      entry.bitmap.close();
      this.bytes -= entry.bytes;
      this.entries.delete(id);
      this.countCached(entry.assetId, -1);
    }
  }

  /** Drop everything for one asset — its media has been closed or replaced. */
  forget(assetId: AssetId): void {
    for (const [id, entry] of this.entries) {
      if (entry.assetId !== assetId) continue;
      entry.bitmap.close();
      this.bytes -= entry.bytes;
      this.entries.delete(id);
    }
    this.cachedPerAsset.delete(assetId);
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.bitmap.close();
    this.entries.clear();
    this.inFlight.clear();
    this.jobs.clear();
    this.pendingPerAsset.clear();
    this.cachedPerAsset.clear();
    this.bytes = 0;
  }
}
