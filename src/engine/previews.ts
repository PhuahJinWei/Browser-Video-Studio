/**
 * Clip previews: filmstrips and waveforms.
 *
 * Both are rasterised once per asset into a single image covering the whole source,
 * then positioned by CSS on each clip. That means trimming and moving a clip costs
 * nothing — the browser just shifts a background — and one decode pass serves every
 * clip cut from the same asset.
 *
 * Generation is deliberately lazy and cancellable: a 4K import should not block the
 * editor while it renders a strip nobody is looking at yet.
 */

import * as T from '../model/time';
import type { AssetId, Time } from '../model/types';
import type { MediaLibrary } from './media';

export interface Filmstrip {
  /** Object URL of a horizontal strip covering the whole source. */
  readonly url: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameCount: number;
  /** Total source duration the strip spans, in seconds. */
  readonly sourceSeconds: number;
  /**
   * A single frame at usable resolution, for the media bin.
   *
   * The strip's own frames are ~78x44, so scaling one up to fill a 220px-wide bin
   * card looks soft. This is rendered from the same decode pass at POSTER_WIDTH.
   */
  readonly posterUrl: string;
  readonly posterWidth: number;
  readonly posterHeight: number;
}

export interface Waveform {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly sourceSeconds: number;
}

/*
 * Previews are generated once and then stretched to whatever the lane happens to be,
 * so they have to be drawn for the largest case rather than the default one.
 *
 * A lane is ~71 CSS px by default and taller once a track is resized, and a HiDPI
 * screen doubles that again — so the old 44px strip was being blown up better than
 * threefold. These are sized for a generous track at 2x, which is the same reasoning
 * the bin poster below already used.
 */
const FILMSTRIP_HEIGHT = 160;
const MAX_FILMSTRIP_FRAMES = 48;
/** Bin cards are ~220 CSS px wide; 2x that stays crisp on a HiDPI display. */
const POSTER_WIDTH = 440;
const WAVEFORM_HEIGHT = 160;
/*
 * Columns across the whole source. A clip can be far wider than this on screen when
 * zoomed in, but a waveform is an envelope rather than a picture: past a few thousand
 * columns the extra detail is invisible and the peaks are what carry the shape.
 */
const WAVEFORM_COLUMNS = 2400;

/**
 * How far along a generator is, 0 to 1.
 *
 * Reported because this is the wait people actually see: importing only probes the
 * container, but decoding forty frames for a strip and the whole stream for a
 * waveform takes real time, and until now nothing said so.
 */
export type ProgressListener = (fraction: number) => void;

export interface GenerateOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressListener;
}

/**
 * Decode frames across the source and lay them out side by side.
 * Returns null when the asset has no video.
 */
export async function generateFilmstrip(
  media: MediaLibrary,
  assetId: AssetId,
  duration: Time,
  options: GenerateOptions = {},
): Promise<Filmstrip | null> {
  const { signal, onProgress } = options;
  const sourceSeconds = T.toSeconds(duration);
  if (sourceSeconds <= 0) return null;

  // Roughly one frame per second, floored so short clips still read as a strip and
  // capped so a feature-length source does not decode hundreds of frames.
  const frameCount = Math.max(4, Math.min(MAX_FILMSTRIP_FRAMES, Math.round(sourceSeconds)));

  const probe = await media.getFrame(assetId, T.TIME_ZERO).catch(() => null);
  if (!probe) return null;

  const aspect = probe.displayWidth / probe.displayHeight || 16 / 9;
  const frameWidth = Math.max(2, Math.round(FILMSTRIP_HEIGHT * aspect));
  probe.close();

  const canvas = new OffscreenCanvas(frameWidth * frameCount, FILMSTRIP_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#11141b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const posterHeight = Math.max(2, Math.round(POSTER_WIDTH / aspect));
  const poster = new OffscreenCanvas(POSTER_WIDTH, posterHeight);
  const posterCtx = poster.getContext('2d');
  if (posterCtx) {
    posterCtx.fillStyle = '#11141b';
    posterCtx.fillRect(0, 0, POSTER_WIDTH, posterHeight);
  }

  for (let i = 0; i < frameCount; i++) {
    if (signal?.aborted) return null;
    // Sample from the middle of each slot rather than its edge, so the first frame
    // is not a black lead-in and the last is not past the end.
    const at = T.fromSeconds((sourceSeconds * (i + 0.5)) / frameCount, 1_000_000);
    const sample = await media.getFrame(assetId, at).catch(() => null);
    if (!sample) continue;

    const frame = sample.toVideoFrame();
    try {
      ctx.drawImage(frame, i * frameWidth, 0, frameWidth, FILMSTRIP_HEIGHT);
      // The first sampled frame doubles as the poster, at full size.
      if (i === 0 && posterCtx) posterCtx.drawImage(frame, 0, 0, POSTER_WIDTH, posterHeight);
    } finally {
      frame.close();
      sample.close();
    }
    // Reported per frame rather than in chunks: forty decodes is already a coarse
    // enough scale, and a bar that only moves in fifths reads as a stalled one.
    onProgress?.((i + 1) / frameCount);
  }

  const [stripBlob, posterBlob] = await Promise.all([
    canvas.convertToBlob({ type: 'image/webp', quality: 0.72 }),
    poster.convertToBlob({ type: 'image/webp', quality: 0.85 }),
  ]);

  return {
    url: URL.createObjectURL(stripBlob),
    frameWidth,
    frameHeight: FILMSTRIP_HEIGHT,
    frameCount,
    sourceSeconds,
    posterUrl: URL.createObjectURL(posterBlob),
    posterWidth: POSTER_WIDTH,
    posterHeight,
  };
}

/**
 * Draw min/max peaks across the source.
 * Returns null when the asset has no audio.
 */
export async function generateWaveform(
  media: MediaLibrary,
  assetId: AssetId,
  duration: Time,
  options: GenerateOptions = {},
): Promise<Waveform | null> {
  const { signal, onProgress } = options;
  const sourceSeconds = T.toSeconds(duration);
  if (sourceSeconds <= 0) return null;

  const columns = WAVEFORM_COLUMNS;
  const peaks = new Float32Array(columns); // absolute peak per column
  let sawAudio = false;
  // Decoded audio arrives in buffers of no fixed size, so progress is throttled by
  // how far it has travelled rather than reported per buffer.
  let reported = 0;

  const secondsPerColumn = sourceSeconds / columns;

  for await (const wrapped of media.audioRange(assetId, T.TIME_ZERO, duration)) {
    if (signal?.aborted) return null;
    sawAudio = true;

    const { buffer, timestamp } = wrapped;
    const reached = Math.min(1, timestamp / sourceSeconds);
    if (reached >= reported + 0.02) {
      reported = reached;
      onProgress?.(reached);
    }
    const channels = buffer.numberOfChannels;
    const rate = buffer.sampleRate;

    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) {
        const seconds = timestamp + i / rate;
        const column = Math.floor(seconds / secondsPerColumn);
        if (column < 0 || column >= columns) continue;
        const magnitude = Math.abs(data[i]!);
        if (magnitude > peaks[column]!) peaks[column] = magnitude;
      }
    }
  }
  if (!sawAudio) return null;

  const canvas = new OffscreenCanvas(columns, WAVEFORM_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, columns, WAVEFORM_HEIGHT);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  const middle = WAVEFORM_HEIGHT / 2;

  for (let x = 0; x < columns; x++) {
    const height = Math.max(1, peaks[x]! * (WAVEFORM_HEIGHT - 2));
    ctx.fillRect(x, middle - height / 2, 1, height);
  }

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  return { url: URL.createObjectURL(blob), width: columns, height: WAVEFORM_HEIGHT, sourceSeconds };
}

/**
 * Caches previews per asset and coalesces concurrent requests.
 * Object URLs are revoked on `dispose` so long sessions do not leak.
 */
export class PreviewCache {
  private readonly filmstrips = new Map<AssetId, Filmstrip | null>();
  private readonly waveforms = new Map<AssetId, Waveform | null>();
  private readonly pending = new Map<string, Promise<unknown>>();
  /**
   * How far each unfinished asset has got, per kind of preview.
   *
   * An entry exists from the moment an asset is queued until both of its previews
   * are done, so a card can show a bar the whole time rather than only once the
   * decoder has reached it.
   */
  private readonly progress = new Map<AssetId, { film: number | null; wave: number | null }>();

  /** Called whenever a fraction moves, so the UI can re-render. */
  constructor(
    private readonly media: MediaLibrary,
    private readonly onProgress?: () => void,
  ) {}

  /**
   * Overall progress for an asset, or null when there is nothing outstanding.
   *
   * An asset needing both a strip and a waveform averages the two, so the bar
   * reaches the end when the card is actually finished rather than twice.
   */
  getProgress(assetId: AssetId): number | null {
    const entry = this.progress.get(assetId);
    if (!entry) return null;
    const parts = [entry.film, entry.wave].filter((v): v is number => v !== null);
    if (parts.length === 0) return null;
    return parts.reduce((sum, v) => sum + v, 0) / parts.length;
  }

  /**
   * Note that an asset is waiting its turn.
   *
   * Previews are built one asset at a time, so importing ten files leaves the last
   * of them with nothing to show for several seconds. Marking the queue up front is
   * what turns that silence into a row of bars sitting at zero.
   */
  markQueued(assetId: AssetId, needsFilm: boolean, needsWave: boolean): void {
    if (!needsFilm && !needsWave) return;
    if (this.progress.has(assetId)) return;
    this.progress.set(assetId, {
      film: needsFilm && !this.filmstrips.has(assetId) ? 0 : null,
      wave: needsWave && !this.waveforms.has(assetId) ? 0 : null,
    });
    this.onProgress?.();
  }

  private setProgress(assetId: AssetId, kind: 'film' | 'wave', fraction: number | null): void {
    const entry = this.progress.get(assetId) ?? { film: null, wave: null };
    const next = { ...entry, [kind]: fraction };
    if (next.film === null && next.wave === null) this.progress.delete(assetId);
    else this.progress.set(assetId, next);
    this.onProgress?.();
  }

  getFilmstrip(assetId: AssetId): Filmstrip | null | undefined {
    return this.filmstrips.get(assetId);
  }

  getWaveform(assetId: AssetId): Waveform | null | undefined {
    return this.waveforms.get(assetId);
  }

  /**
   * Register a still as its own poster.
   *
   * Images have no frames to walk, so there is no strip to build — but the media
   * bin still wants a thumbnail, and the file itself is the best one available.
   */
  setStillPoster(assetId: AssetId, url: string, size: { width: number; height: number }): void {
    if (this.filmstrips.get(assetId)) return;
    this.filmstrips.set(assetId, {
      url,
      frameWidth: size.width,
      frameHeight: size.height,
      frameCount: 1,
      sourceSeconds: 0,
      posterUrl: url,
      posterWidth: size.width,
      posterHeight: size.height,
    });
  }

  /** Build both previews for an asset. Safe to call repeatedly. */
  async ensure(assetId: AssetId, videoDuration: Time | null, audioDuration: Time | null): Promise<void> {
    const jobs: Promise<unknown>[] = [];

    this.markQueued(assetId, Boolean(videoDuration), Boolean(audioDuration));

    if (videoDuration && !this.filmstrips.has(assetId)) {
      jobs.push(
        this.once(`film:${assetId}`, async () => {
          const strip = await generateFilmstrip(this.media, assetId, videoDuration, {
            onProgress: (fraction) => this.setProgress(assetId, 'film', fraction),
          }).catch(() => null);
          this.filmstrips.set(assetId, strip);
          // Cleared rather than pinned at 1: a finished preview is shown by the
          // image being there, and a bar stuck full reads as still working.
          this.setProgress(assetId, 'film', null);
        }),
      );
    }
    if (audioDuration && !this.waveforms.has(assetId)) {
      jobs.push(
        this.once(`wave:${assetId}`, async () => {
          const wave = await generateWaveform(this.media, assetId, audioDuration, {
            onProgress: (fraction) => this.setProgress(assetId, 'wave', fraction),
          }).catch(() => null);
          this.waveforms.set(assetId, wave);
          this.setProgress(assetId, 'wave', null);
        }),
      );
    }
    await Promise.all(jobs);
  }

  private once<V>(key: string, run: () => Promise<V>): Promise<unknown> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = run().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  dispose(): void {
    for (const strip of this.filmstrips.values()) {
      if (!strip) continue;
      URL.revokeObjectURL(strip.url);
      URL.revokeObjectURL(strip.posterUrl);
    }
    for (const wave of this.waveforms.values()) if (wave) URL.revokeObjectURL(wave.url);
    this.filmstrips.clear();
    this.waveforms.clear();
    this.progress.clear();
  }
}
