/**
 * What the timeline needs to draw previews, and the jobs that produce it.
 *
 * Two caches, each shaped for what it holds: a peak pyramid for audio, decoded
 * frames for picture. Neither is an image the UI has to fetch, so there are no
 * object URLs, no per-zoom tiers to build and evict, and no request the painter has
 * to make ahead of time — it asks for what is on screen while it draws, and draws
 * again when something lands.
 *
 * The exception is the media bin, which shows one card per asset and wants a picture
 * it can put in a CSS background. Those are made once per asset and kept, since
 * there is exactly one per card and it never changes with zoom.
 */

import { PeaksBuilder, readPeaks, type Peaks } from './peaks';
import { ThumbnailCache } from './thumbnails';
import * as T from '../model/time';
import type { AssetId, Time } from '../model/types';
import type { MediaLibrary } from './media';

/** Card thumbnails are ~220 CSS px wide; twice that stays crisp on a HiDPI display. */
const POSTER_WIDTH = 440;
/** Card waveforms are small and static: enough columns to read as a shape. */
const CARD_WAVEFORM_COLUMNS = 440;
const CARD_WAVEFORM_HEIGHT = 128;

/**
 * How often a decode in progress tells the UI.
 *
 * Peaks arrive in decoder-sized chunks, which for a long file is hundreds of
 * callbacks a second; each one repaints. Ten a second is smooth to watch and leaves
 * the main thread to the decode.
 */
const NOTIFY_MS = 100;

export interface AssetPreviewProgress {
  /** 0..1 while the peak pyramid is being built, else null. */
  readonly peaks: number | null;
}

export class PreviewStore {
  readonly thumbnails: ThumbnailCache;

  private readonly peaks = new Map<AssetId, Peaks>();
  private readonly peakJobs = new Map<AssetId, Promise<void>>();
  private readonly peakProgress = new Map<AssetId, number>();
  /** One still picture per asset for the media bin, as an object URL. */
  private readonly posters = new Map<AssetId, string>();
  private readonly posterJobs = new Set<AssetId>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly media: MediaLibrary,
    private readonly onChange: () => void,
  ) {
    this.thumbnails = new ThumbnailCache(media, () => this.notifySoon());
  }

  // ------------------------------------------------------------------ audio

  /** The pyramid for an asset, however much of it has been decoded so far. */
  getPeaks(assetId: AssetId): Peaks | undefined {
    return this.peaks.get(assetId);
  }

  /** 0..1 while an asset's peaks are being read, null when there is nothing to wait for. */
  getPeaksProgress(assetId: AssetId): number | null {
    return this.peakProgress.get(assetId) ?? null;
  }

  /**
   * Start reading an asset's peaks, once.
   *
   * The pyramid is put in the map before any audio is decoded, so a painter can draw
   * the part that exists while the rest arrives rather than waiting for the whole
   * file — which on a half-hour source is the difference between a waveform in a
   * moment and a flat clip for a minute.
   */
  ensurePeaks(assetId: AssetId, sampleRate: number, duration: Time): void {
    if (this.peaks.has(assetId) || this.peakJobs.has(assetId)) return;

    const durationSeconds = T.toSeconds(duration);
    if (durationSeconds <= 0) return;

    const builder = new PeaksBuilder(sampleRate, durationSeconds);
    this.peaks.set(assetId, builder.result);
    this.peakProgress.set(assetId, 0);
    this.notifyNow();

    const job = (async () => {
      try {
        for await (const wrapped of this.media.audioRange(assetId, T.TIME_ZERO, duration)) {
          if (this.disposed) return;
          const { buffer, timestamp } = wrapped;
          const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
            buffer.getChannelData(channel),
          );
          // Addressed by absolute sample index so a gap or overlap between decoder
          // chunks cannot slide the rest of the waveform out of step with the audio.
          builder.addChannels(channels, Math.round(timestamp * sampleRate), buffer.length);
          this.peakProgress.set(assetId, Math.min(1, builder.result.filledSeconds / durationSeconds));
          this.notifySoon();
        }
        builder.finish();
      } catch {
        // A source that will not decode keeps whatever was read; the clip shows that
        // much and nothing is thrown away.
        builder.finish();
      } finally {
        this.peakProgress.delete(assetId);
        this.peakJobs.delete(assetId);
        this.notifyNow();
      }
    })();
    this.peakJobs.set(assetId, job);
  }

  // ------------------------------------------------------------ bin cards

  /** A still for the media bin, or null until one has been decoded. */
  getPosterUrl(assetId: AssetId): string | null {
    return this.posters.get(assetId) ?? null;
  }

  /** Register a picture the bin already has — a captured still, say. */
  setPosterUrl(assetId: AssetId, url: string): void {
    const previous = this.posters.get(assetId);
    if (previous === url) return;
    if (previous) URL.revokeObjectURL(previous);
    this.posters.set(assetId, url);
    this.notifyNow();
  }

  /** Decode one frame, or draw one waveform, for an asset's card. Once per asset. */
  ensurePoster(assetId: AssetId, hasVideo: boolean, duration: Time | null): void {
    if (this.posters.has(assetId) || this.posterJobs.has(assetId)) return;
    this.posterJobs.add(assetId);

    void (async () => {
      try {
        const blob = hasVideo
          ? await this.renderVideoPoster(assetId)
          : await this.renderWaveformPoster(assetId, duration);
        if (!blob || this.disposed) return;
        this.posters.set(assetId, URL.createObjectURL(blob));
        this.notifyNow();
      } catch {
        // A card without a picture falls back to its kind icon, which is fine.
      } finally {
        this.posterJobs.delete(assetId);
      }
    })();
  }

  private async renderVideoPoster(assetId: AssetId): Promise<Blob | null> {
    const still = this.media.getStill(assetId);
    const source: CanvasImageSource | null = still ?? null;
    let owned: VideoFrame | null = null;
    if (!source) {
      const sample = await this.media.getFrame(assetId, T.TIME_ZERO).catch(() => null);
      if (!sample) return null;
      owned = sample.toVideoFrame();
      sample.close();
    }

    const image = source ?? owned;
    if (!image) return null;
    try {
      const width = 'displayWidth' in image ? image.displayWidth : (image as ImageBitmap).width;
      const height = 'displayHeight' in image ? image.displayHeight : (image as ImageBitmap).height;
      const aspect = width / height || 16 / 9;
      const canvas = new OffscreenCanvas(POSTER_WIDTH, Math.max(2, Math.round(POSTER_WIDTH / aspect)));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    } finally {
      owned?.close();
    }
  }

  /**
   * A card's waveform, drawn from the pyramid once it exists.
   *
   * Deliberately an image rather than a canvas: there is one per card and it never
   * changes, so the bin can keep painting it as a CSS background and nothing in the
   * grid needs a repaint loop.
   */
  private async renderWaveformPoster(assetId: AssetId, duration: Time | null): Promise<Blob | null> {
    if (!duration) return null;
    const peaks = await this.awaitPeaks(assetId);
    if (!peaks) return null;

    const canvas = new OffscreenCanvas(CARD_WAVEFORM_COLUMNS, CARD_WAVEFORM_HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    drawPeaks(ctx, peaks, 0, peaks.durationSeconds, CARD_WAVEFORM_COLUMNS, CARD_WAVEFORM_HEIGHT, 0);
    return canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  }

  private async awaitPeaks(assetId: AssetId): Promise<Peaks | null> {
    const job = this.peakJobs.get(assetId);
    if (job) await job.catch(() => undefined);
    return this.peaks.get(assetId) ?? null;
  }

  // ------------------------------------------------------------- lifecycle

  /** Forget everything for an asset whose media has been closed or replaced. */
  forget(assetId: AssetId): void {
    this.peaks.delete(assetId);
    this.peakProgress.delete(assetId);
    this.thumbnails.forget(assetId);
    const poster = this.posters.get(assetId);
    if (poster) URL.revokeObjectURL(poster);
    this.posters.delete(assetId);
    this.notifyNow();
  }

  dispose(): void {
    this.disposed = true;
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.thumbnails.dispose();
    for (const url of this.posters.values()) URL.revokeObjectURL(url);
    this.posters.clear();
    this.peaks.clear();
    this.peakProgress.clear();
  }

  /** Coalesced: a decode reports far faster than anything can be looked at. */
  private notifySoon(): void {
    if (this.notifyTimer !== null || this.disposed) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.onChange();
    }, NOTIFY_MS);
  }

  private notifyNow(): void {
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    if (!this.disposed) this.onChange();
  }
}

/**
 * Paint a peak pyramid as one filled column per device pixel.
 *
 * Shared by the lane painter and the bin card so a waveform looks the same wherever
 * it appears. Columns are whole pixels drawn from the lowest sample to the highest
 * and anchored at zero: that keeps the asymmetry real audio has, which a mirrored
 * absolute peak would flatten, while the anchor stops a one-sided column from
 * floating clear of the axis.
 */
export function drawPeaks(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  peaks: Peaks,
  fromSeconds: number,
  spanSeconds: number,
  columns: number,
  height: number,
  originX: number,
): void {
  if (columns <= 0 || height <= 0 || spanSeconds <= 0) return;

  const min = scratchMin.length >= columns ? scratchMin : (scratchMin = new Float32Array(columns * 2));
  const max = scratchMax.length >= columns ? scratchMax : (scratchMax = new Float32Array(columns * 2));
  readPeaks(peaks, fromSeconds, spanSeconds / columns, columns, min, max);

  const middle = height / 2;
  const amplitude = (height - 2) / 2;
  // `fillRect` paints up to but not including its lower edge, so clamping to the
  // centre row rather than the centre coordinate is what keeps the axis covered —
  // otherwise a one-sided column stops a pixel short of it.
  const centre = Math.floor(middle);

  for (let column = 0; column < columns; column++) {
    const high = max[column]!;
    const low = min[column]!;
    const top = Math.min(centre, Math.round(middle - Math.max(high, 0) * amplitude));
    const bottom = Math.max(centre + 1, Math.round(middle - Math.min(low, 0) * amplitude));
    ctx.fillRect(originX + column, top, 1, bottom - top);
  }
}

// Reused across repaints: a fresh pair of arrays per frame is garbage the collector
// then has to chase during a scroll, which is exactly when it must not run.
let scratchMin = new Float32Array(0);
let scratchMax = new Float32Array(0);
