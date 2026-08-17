/**
 * Clip previews: filmstrips and waveforms.
 *
 * Both are rasterised per asset and positioned by CSS on each clip. Filmstrips begin
 * as one cheap source-wide image, then add small zoom-specific tiles progressively.
 * That means trimming and moving a clip costs nothing — the browser just shifts the
 * backgrounds — and one cache serves every clip cut from the same asset.
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
  /** Frames per second of source, so a coarser strip can be recognised. */
  readonly framesPerSecond: number;
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

/** One independently publishable piece of a zoom-specific filmstrip. */
export interface FilmstripTile {
  readonly url: string;
  /** Index of this tile's first thumbnail in the level. */
  readonly firstFrame: number;
  readonly frameCount: number;
}

/** A CSS background layer positioned in source-time coordinates. */
export interface FilmstripLayer {
  readonly url: string;
  readonly sourceStart: number;
  readonly sourceDuration: number;
}

/** Layers ready to paint now, ordered from sharpest to fallback. */
export interface FilmstripPreview {
  readonly sourceSeconds: number;
  /** Sampling grid used to place fixed-aspect frames and their dividers. */
  readonly framesPerSecond: number;
  readonly layers: readonly FilmstripLayer[];
}

interface FilmstripLevel {
  readonly requestedDensity: number;
  readonly sourceSeconds: number;
  readonly frameCount: number;
  readonly tiles: Map<number, FilmstripTile>;
  complete: boolean;
}

export interface Waveform {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly sourceSeconds: number;
}

/** One independently publishable high-resolution waveform region. */
export interface WaveformTile {
  readonly url: string;
  readonly firstColumn: number;
  readonly columnCount: number;
}

interface WaveformLevel {
  readonly requestedDensity: number;
  readonly sourceSeconds: number;
  readonly columnCount: number;
  readonly tiles: Map<number, WaveformTile>;
  complete: boolean;
}

/** Waveform layers ready to display, sharp tiles first and starter fallback last. */
export interface WaveformPreview {
  readonly sourceSeconds: number;
  readonly layers: readonly FilmstripLayer[];
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

/**
 * The starter atlas still has to fit one browser canvas. Zoom-specific levels only
 * store small tiles, so their logical grid can cover a much longer source without
 * allocating one enormous bitmap.
 */
const MAX_STARTER_FILMSTRIP_FRAMES = 120;
const MAX_FILMSTRIP_LEVEL_FRAMES = 12_000;
/** Small enough to appear quickly; large enough not to flood CSS with layers. */
const FILMSTRIP_FRAMES_PER_TILE = 8;
/** One viewport is normally under two tiles wide; the third is a scroll buffer. */
const MAX_NEW_TILES_PER_PASS = 3;
/** Raw zoom densities are precise; retain recent ones without growing forever. */
const MAX_CACHED_FILMSTRIP_LEVELS = 12;

/** Number of thumbnails a density request produces for this source. */
function filmstripFrameCount(
  sourceSeconds: number,
  framesPerSecond: number,
  maximum = MAX_FILMSTRIP_LEVEL_FRAMES,
): number {
  return Math.max(
    1,
    Math.min(maximum, Math.ceil(sourceSeconds * framesPerSecond)),
  );
}

/**
 * Sampling density whose cells have the source frame's aspect ratio on this track.
 *
 * Unlike broad power-of-two tiers, this does not squeeze a tier's fixed frame count
 * across whatever width the new zoom happens to produce. The cache is still bounded
 * by tile-on-demand generation, while every rendered cell stays `aspect × height`.
 */
export function densityForZoom(
  pixelsPerSecond: number,
  speed = 1,
  frameAspect = 16 / 9,
  previewHeight = 70,
): number {
  const frameWidth = Math.max(1, frameAspect * previewHeight);
  return Math.max(1 / 1_000, pixelsPerSecond / (Math.abs(speed) || 1) / frameWidth);
}
/** Bin cards are ~220 CSS px wide; 2x that stays crisp on a HiDPI display. */
const POSTER_WIDTH = 440;
const WAVEFORM_HEIGHT = 160;
/*
 * Columns across the whole source. A clip can be far wider than this on screen when
 * zoomed in, but a waveform is an envelope rather than a picture: past a few thousand
 * columns the extra detail is invisible and the peaks are what carry the shape.
 */
const WAVEFORM_COLUMNS = 2400;
/** Raster columns per independently decoded waveform tile. */
const WAVEFORM_COLUMNS_PER_TILE = 1024;
/** Covers at least a normal viewport at 2× device scale. */
const MAX_NEW_WAVEFORM_TILES_PER_PASS = 4;
const MAX_CACHED_WAVEFORM_LEVELS = 12;

/**
 * Source columns needed so CSS never enlarges a waveform horizontally.
 * Device scale is capped at 2×: beyond that the extra decode cost buys little.
 */
export function waveformDensityForZoom(
  pixelsPerSecond: number,
  speed = 1,
  pixelRatio = 1,
): number {
  const scale = Math.max(1, Math.min(2, pixelRatio));
  return Math.max(1 / 1_000, pixelsPerSecond / (Math.abs(speed) || 1) * scale);
}

/** Missing tiles nearest the viewport, without allocating an array for the source. */
function nearestMissingTiles(
  tileCount: number,
  priorityTile: number,
  existing: ReadonlySet<number> | undefined,
  maximum: number,
): number[] {
  const result: number[] = [];
  for (let distance = 0; distance < tileCount && result.length < maximum; distance++) {
    const candidates = distance === 0
      ? [priorityTile]
      : [priorityTile - distance, priorityTile + distance];
    for (const candidate of candidates) {
      if (candidate < 0 || candidate >= tileCount || existing?.has(candidate)) continue;
      result.push(candidate);
      if (result.length >= maximum) break;
    }
  }
  return result;
}

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
  /** Frames per second of source. Defaults to the cheap one-frame-per-second starter. */
  readonly framesPerSecond?: number;
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

  // Floored so short clips still read as a strip, and capped so neither the
  // decode nor the canvas runs away on a long one.
  const framesPerSecond = options.framesPerSecond ?? 1;
  const frameCount = Math.max(
    4,
    filmstripFrameCount(sourceSeconds, framesPerSecond, MAX_STARTER_FILMSTRIP_FRAMES),
  );

  const probe = await media.getFrame(assetId, T.TIME_ZERO).catch(() => null);
  if (!probe) return null;

  const aspect = probe.displayWidth / probe.displayHeight || 16 / 9;
  const frameWidth = Math.max(2, Math.round(FILMSTRIP_HEIGHT * aspect));
  probe.close();

  /*
   * Frames are contiguous on purpose.
   *
   * A gutter baked into the bitmap is not a hairline once CSS maps the whole source
   * to a deeply zoomed timeline: its width scales with every thumbnail and becomes
   * a dark slash several screen pixels wide. Clip edges and the ruler already carry
   * the edit boundaries; the filmstrip should remain uninterrupted source imagery.
   */
  const canvas = new OffscreenCanvas(frameWidth * frameCount, FILMSTRIP_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
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
    // The strip is scaled again by CSS. A low-quality intermediate makes that
    // second sampling expose block edges and mosquito noise at deep zoom.
    canvas.convertToBlob({ type: 'image/webp', quality: 0.92 }),
    poster.convertToBlob({ type: 'image/webp', quality: 0.9 }),
  ]);

  return {
    url: URL.createObjectURL(stripBlob),
    frameWidth,
    frameHeight: FILMSTRIP_HEIGHT,
    framesPerSecond: frameCount / sourceSeconds,
    frameCount,
    sourceSeconds,
    posterUrl: URL.createObjectURL(posterBlob),
    posterWidth: POSTER_WIDTH,
    posterHeight,
  };
}

interface GenerateFilmstripTilesOptions extends GenerateOptions {
  readonly skipTiles?: ReadonlySet<number>;
  /** Source time to build around first, normally the centre of the viewport. */
  readonly prioritySeconds?: number;
  readonly onStart: (frameCount: number, sourceSeconds: number) => void;
  readonly onTile: (tileIndex: number, tile: FilmstripTile) => void;
}

/**
 * Build a zoom level in small atlases and publish each one as soon as it lands.
 *
 * A whole-source atlas made zoom latency equal to the slowest frame in the source.
 * Eight-frame tiles put useful pixels on screen after the first small batch and let
 * an interrupted zoom resume from the tiles it already completed.
 */
async function generateFilmstripTiles(
  media: MediaLibrary,
  assetId: AssetId,
  duration: Time,
  options: GenerateFilmstripTilesOptions,
): Promise<boolean> {
  const { signal, onProgress, onStart, onTile, skipTiles, prioritySeconds } = options;
  const sourceSeconds = T.toSeconds(duration);
  if (sourceSeconds <= 0) return false;

  const framesPerSecond = options.framesPerSecond ?? 1;
  const frameCount = filmstripFrameCount(sourceSeconds, framesPerSecond);
  onStart(frameCount, sourceSeconds);

  const probe = await media.getFrame(assetId, T.TIME_ZERO).catch(() => null);
  if (!probe) return false;
  const aspect = probe.displayWidth / probe.displayHeight || 16 / 9;
  const frameWidth = Math.max(2, Math.round(FILMSTRIP_HEIGHT * aspect));
  probe.close();

  const tileCount = Math.ceil(frameCount / FILMSTRIP_FRAMES_PER_TILE);
  const priorityFrame = Math.max(
    0,
    Math.min(frameCount - 1, Math.floor((prioritySeconds ?? 0) * framesPerSecond)),
  );
  const priorityTile = Math.floor(priorityFrame / FILMSTRIP_FRAMES_PER_TILE);
  const tileOrder = Array.from({ length: tileCount }, (_, index) => index).sort(
    (a, b) => Math.abs(a - priorityTile) - Math.abs(b - priorityTile),
  );
  let completedFrames = 0;
  let completedTiles = skipTiles?.size ?? 0;
  let generatedTiles = 0;

  for (const tileIndex of tileOrder) {
    const firstFrame = tileIndex * FILMSTRIP_FRAMES_PER_TILE;
    const count = Math.min(FILMSTRIP_FRAMES_PER_TILE, frameCount - firstFrame);

    if (skipTiles?.has(tileIndex)) {
      completedFrames += count;
      onProgress?.(completedFrames / frameCount);
      continue;
    }
    // Zoom levels may describe thousands of logical frames. Decode only the visible
    // neighbourhood now; scrolling calls back with another priority and resumes it.
    if (generatedTiles >= MAX_NEW_TILES_PER_PASS) break;
    if (signal?.aborted) return false;

    const canvas = new OffscreenCanvas(frameWidth * count, FILMSTRIP_HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#11141b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let local = 0; local < count; local++) {
      if (signal?.aborted) return false;
      const frameIndex = firstFrame + local;
      const at = T.fromSeconds(
        Math.min(
          sourceSeconds - Math.min(sourceSeconds / 2, 0.000_001),
          (frameIndex + 0.5) / framesPerSecond,
        ),
        1_000_000,
      );
      const sample = await media.getFrame(assetId, at).catch(() => null);
      if (sample) {
        const frame = sample.toVideoFrame();
        try {
          ctx.drawImage(frame, local * frameWidth, 0, frameWidth, FILMSTRIP_HEIGHT);
        } finally {
          frame.close();
          sample.close();
        }
      }
      completedFrames++;
      onProgress?.(completedFrames / frameCount);
    }

    if (signal?.aborted) return false;
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
    if (signal?.aborted) return false;
    onTile(tileIndex, {
      url: URL.createObjectURL(blob),
      firstFrame,
      frameCount: count,
    });
    generatedTiles++;
    completedTiles++;
  }

  return completedTiles >= tileCount;
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
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  const middle = WAVEFORM_HEIGHT / 2;

  for (let x = 0; x < columns; x++) {
    const height = Math.max(1, Math.round(peaks[x]! * (WAVEFORM_HEIGHT - 2)));
    ctx.fillRect(x, Math.round(middle - height / 2), 1, height);
  }

  /*
   * A waveform is almost entirely one-pixel edges against transparency. Lossy WebP
   * saves little on that material and softens every peak with compression ringing;
   * PNG keeps the envelope pixel-exact and is still tiny for this sparse image.
   */
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { url: URL.createObjectURL(blob), width: columns, height: WAVEFORM_HEIGHT, sourceSeconds };
}

interface GenerateWaveformTilesOptions extends GenerateOptions {
  readonly columnsPerSecond: number;
  readonly skipTiles?: ReadonlySet<number>;
  readonly prioritySeconds?: number;
  readonly onStart: (columnCount: number, sourceSeconds: number) => void;
  readonly onTile: (tileIndex: number, tile: WaveformTile) => void;
}

/**
 * Decode only the waveform neighbourhood visible at this zoom.
 *
 * Each raster column stores the real minimum and maximum sample in its source-time
 * bucket. CSS maps it to at most one device pixel, so sharpness comes from actual
 * audio detail rather than a scaling mode applied to the starter image.
 */
/**
 * Smallest span a column's peak is measured over, in samples.
 *
 * A column narrower than one cycle of the waveform only sees part of that cycle, so
 * its own peak is not the envelope — which is why a min/max reading collapses into a
 * wobbling line once zoomed far enough in. Widening the *measurement* keeps the
 * envelope an envelope; the bar is still placed at full column resolution, so
 * nothing is lost in precision.
 *
 * 256 samples is ~5ms, about one cycle of the lowest pitch worth resolving.
 */
const MIN_PEAK_SAMPLES = 256;

/** Sliding maximum, so each column reports the loudest sample near it. */
function widenPeaks(
  peaks: Float32Array,
  sampleRate: number,
  columnsPerSecond: number,
): Float32Array {
  if (sampleRate <= 0 || columnsPerSecond <= 0) return peaks;

  const samplesPerColumn = sampleRate / columnsPerSecond;
  const spread = Math.floor((MIN_PEAK_SAMPLES / samplesPerColumn - 1) / 2);
  // Already wide enough on its own: most zoom levels land here and pay nothing.
  if (spread < 1) return peaks;

  const widened = new Float32Array(peaks.length);
  for (let x = 0; x < peaks.length; x++) {
    const from = Math.max(0, x - spread);
    const to = Math.min(peaks.length - 1, x + spread);
    let peak = 0;
    for (let i = from; i <= to; i++) if (peaks[i]! > peak) peak = peaks[i]!;
    widened[x] = peak;
  }
  return widened;
}

async function generateWaveformTiles(
  media: MediaLibrary,
  assetId: AssetId,
  duration: Time,
  options: GenerateWaveformTilesOptions,
): Promise<boolean> {
  const {
    signal,
    onProgress,
    onStart,
    onTile,
    skipTiles,
    prioritySeconds,
    columnsPerSecond,
  } = options;
  const sourceSeconds = T.toSeconds(duration);
  if (sourceSeconds <= 0 || columnsPerSecond <= 0) return false;

  const columnCount = Math.max(1, Math.ceil(sourceSeconds * columnsPerSecond));
  const tileCount = Math.ceil(columnCount / WAVEFORM_COLUMNS_PER_TILE);
  onStart(columnCount, sourceSeconds);

  const priorityColumn = Math.max(
    0,
    Math.min(columnCount - 1, Math.floor((prioritySeconds ?? 0) * columnsPerSecond)),
  );
  const priorityTile = Math.floor(priorityColumn / WAVEFORM_COLUMNS_PER_TILE);
  const tileOrder = nearestMissingTiles(
    tileCount,
    priorityTile,
    skipTiles,
    MAX_NEW_WAVEFORM_TILES_PER_PASS,
  );
  let completedTiles = Math.min(tileCount, skipTiles?.size ?? 0);

  for (const tileIndex of tileOrder) {
    if (signal?.aborted) return false;

    const firstColumn = tileIndex * WAVEFORM_COLUMNS_PER_TILE;
    const count = Math.min(WAVEFORM_COLUMNS_PER_TILE, columnCount - firstColumn);
    const sourceStart = firstColumn / columnsPerSecond;
    const sourceEnd = Math.min(sourceSeconds, (firstColumn + count) / columnsPerSecond);
    // Absolute peak per column, mirrored at draw time — the same envelope the
    // source-wide sprite draws, so zooming sharpens the picture rather than
    // replacing it with a different one.
    const peaks = new Float32Array(count);
    let sampleRate = 0;

    for await (const wrapped of media.audioRange(
      assetId,
      T.fromSeconds(sourceStart, 1_000_000),
      T.fromSeconds(sourceEnd, 1_000_000),
    )) {
      if (signal?.aborted) return false;
      const { buffer, timestamp } = wrapped;
      const rate = buffer.sampleRate;
      sampleRate = rate;
      const sampleCount = buffer.length;
      const fromSample = Math.max(0, Math.floor((sourceStart - timestamp) * rate));
      const toSample = Math.min(sampleCount, Math.ceil((sourceEnd - timestamp) * rate));
      const channels = Array.from(
        { length: buffer.numberOfChannels },
        (_, channel) => buffer.getChannelData(channel),
      );

      for (let sampleIndex = fromSample; sampleIndex < toSample; sampleIndex++) {
        if ((sampleIndex & 4095) === 0 && signal?.aborted) return false;
        const seconds = timestamp + sampleIndex / rate;
        const column = Math.floor((seconds - sourceStart) * columnsPerSecond);
        if (column < 0 || column >= count) continue;

        let peak = peaks[column]!;
        for (const channel of channels) {
          const magnitude = Math.abs(channel[sampleIndex]!);
          if (magnitude > peak) peak = magnitude;
        }
        peaks[column] = peak;
      }
    }

    const envelope = widenPeaks(peaks, sampleRate, columnsPerSecond);

    const canvas = new OffscreenCanvas(count, WAVEFORM_HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.clearRect(0, 0, count, WAVEFORM_HEIGHT);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.76)';
    const middle = WAVEFORM_HEIGHT / 2;
    for (let x = 0; x < count; x++) {
      const height = Math.max(1, Math.round(envelope[x]! * (WAVEFORM_HEIGHT - 2)));
      ctx.fillRect(x, Math.round(middle - height / 2), 1, height);
    }

    if (signal?.aborted) return false;
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    if (signal?.aborted) return false;
    onTile(tileIndex, {
      url: URL.createObjectURL(blob),
      firstColumn,
      columnCount: count,
    });
    completedTiles++;
    onProgress?.(completedTiles / tileCount);
  }

  return completedTiles >= tileCount;
}

/**
 * Caches previews per asset and coalesces concurrent requests.
 * Object URLs are revoked on `dispose` so long sessions do not leak.
 */
export class PreviewCache {
  /** The cheap starter strip, also used for the media-bin poster. */
  private readonly filmstrips = new Map<AssetId, Filmstrip | null>();
  /** Additional timeline levels, keyed by the precise density that requested them. */
  private readonly filmstripTiers = new Map<AssetId, Map<number, FilmstripLevel>>();
  private readonly waveforms = new Map<AssetId, Waveform | null>();
  private readonly waveformTiers = new Map<AssetId, Map<number, WaveformLevel>>();
  private readonly pending = new Map<string, Promise<unknown>>();
  /** Density of each asset's active job, so an identical request can join it. */
  private readonly density = new Map<AssetId, number>();
  /** Visible tile of each active job, so scrolling can redirect the decode pass. */
  private readonly densityPriorityTiles = new Map<AssetId, number>();
  /** In-flight density rebuilds, so a newer zoom can abandon an older one. */
  private readonly densityJobs = new Map<AssetId, AbortController>();
  private readonly waveformDensity = new Map<AssetId, number>();
  private readonly waveformPriorityTiles = new Map<AssetId, number>();
  private readonly waveformDensityJobs = new Map<AssetId, AbortController>();
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

  /**
   * Layers ready for this zoom right now.
   *
   * Completed target tiles paint alone. While a level is still arriving, its tiles
   * sit over the nearest complete non-oversampled level, so every finished batch
   * sharpens in place without opening blank holes in the clip.
   */
  getFilmstripPreview(assetId: AssetId, framesPerSecond: number): FilmstripPreview | null | undefined {
    const base = this.filmstrips.get(assetId);
    if (!base) return base;
    if (base.sourceSeconds <= 0) {
      return {
        sourceSeconds: 0,
        framesPerSecond: 0,
        layers: [{ url: base.url, sourceStart: 0, sourceDuration: 0 }],
      };
    }

    const tiers = this.filmstripTiers.get(assetId);
    const exact = tiers?.get(framesPerSecond);
    const targetCount = filmstripFrameCount(base.sourceSeconds, framesPerSecond);

    const fallback = [...(tiers?.values() ?? [])]
      .filter((level) => level.complete && level.frameCount <= targetCount)
      .sort((a, b) => b.frameCount - a.frameCount)[0];

    const layersFor = (
      level: FilmstripLevel,
      layoutDensity = level.requestedDensity,
    ): FilmstripLayer[] =>
      [...level.tiles.values()]
        .sort((a, b) => a.firstFrame - b.firstFrame)
        .map((tile) => ({
          url: tile.url,
          sourceStart: tile.firstFrame / layoutDensity,
          sourceDuration: tile.frameCount / layoutDensity,
        }));

    if (exact?.complete) {
      return {
        sourceSeconds: base.sourceSeconds,
        framesPerSecond: exact.requestedDensity,
        layers: layersFor(exact),
      };
    }

    // The same number of decoded cells can be laid onto a slightly different time
    // grid without resampling. This avoids a redundant decode when rounding produced
    // the same count, while the CSS cells still take the exact natural width.
    const useBaseFallback =
      !fallback ||
      (base.frameCount <= targetCount && base.frameCount > fallback.frameCount);
    const selectedFallback = useBaseFallback ? undefined : fallback;
    const fallbackDensity = selectedFallback?.frameCount === targetCount
      ? framesPerSecond
      : selectedFallback?.requestedDensity;
    const baseDensity = base.frameCount === targetCount
      ? framesPerSecond
      : base.framesPerSecond;
    const fallbackLayers = selectedFallback
      ? layersFor(selectedFallback, fallbackDensity)
      : [{
          url: base.url,
          sourceStart: 0,
          sourceDuration: base.frameCount / baseDensity,
        }];
    return {
      sourceSeconds: base.sourceSeconds,
      framesPerSecond:
        exact?.requestedDensity ?? fallbackDensity ?? baseDensity,
      layers: [...(exact ? layersFor(exact) : []), ...fallbackLayers],
    };
  }

  getWaveform(assetId: AssetId): Waveform | null | undefined {
    return this.waveforms.get(assetId);
  }

  /** Sharp visible waveform tiles over the best complete lower-resolution fallback. */
  getWaveformPreview(
    assetId: AssetId,
    columnsPerSecond: number,
  ): WaveformPreview | null | undefined {
    const base = this.waveforms.get(assetId);
    if (!base) return base;

    const tiers = this.waveformTiers.get(assetId);
    const exact = tiers?.get(columnsPerSecond);
    const fallback = [...(tiers?.values() ?? [])]
      .filter((level) => level.complete && level.requestedDensity <= columnsPerSecond)
      .sort((a, b) => b.requestedDensity - a.requestedDensity)[0];
    const layersFor = (level: WaveformLevel): FilmstripLayer[] =>
      [...level.tiles.values()]
        .sort((a, b) => a.firstColumn - b.firstColumn)
        .map((tile) => ({
          url: tile.url,
          sourceStart: tile.firstColumn / level.requestedDensity,
          sourceDuration: tile.columnCount / level.requestedDensity,
        }));

    if (exact?.complete) {
      return { sourceSeconds: base.sourceSeconds, layers: layersFor(exact) };
    }

    const fallbackLayers = fallback
      ? layersFor(fallback)
      : [{ url: base.url, sourceStart: 0, sourceDuration: base.sourceSeconds }];
    return {
      sourceSeconds: base.sourceSeconds,
      layers: [...(exact ? layersFor(exact) : []), ...fallbackLayers],
    };
  }

  /** Build a few high-resolution waveform tiles around the visible source time. */
  async ensureWaveformDensity(
    assetId: AssetId,
    audioDuration: Time | null,
    columnsPerSecond: number,
    prioritySeconds?: number,
  ): Promise<void> {
    if (!audioDuration) return;
    const base = this.waveforms.get(assetId);
    if (!base || base.sourceSeconds <= 0) return;

    // The starter already contains at least one raster column per requested device
    // pixel, so CSS only downsamples it and a denser tile would be indistinguishable.
    if (columnsPerSecond <= base.width / base.sourceSeconds) return;

    const columnCount = Math.max(1, Math.ceil(base.sourceSeconds * columnsPerSecond));
    const priorityTile = Math.floor(
      Math.max(0, Math.min(columnCount - 1, (prioritySeconds ?? 0) * columnsPerSecond)) /
        WAVEFORM_COLUMNS_PER_TILE,
    );
    const active = this.waveformDensityJobs.get(assetId);
    if (
      active &&
      this.waveformDensity.get(assetId) === columnsPerSecond &&
      this.waveformPriorityTiles.get(assetId) === priorityTile
    ) return;
    if (active) {
      active.abort();
      this.waveformDensityJobs.delete(assetId);
      this.setProgress(assetId, 'wave', null);
    }

    const tiers = this.waveformTiers.get(assetId);
    if (tiers?.get(columnsPerSecond)?.complete) return;
    this.waveformDensity.set(assetId, columnsPerSecond);
    this.waveformPriorityTiles.set(assetId, priorityTile);
    const controller = new AbortController();
    this.waveformDensityJobs.set(assetId, controller);

    try {
      let level = tiers?.get(columnsPerSecond);
      const completed = await generateWaveformTiles(this.media, assetId, audioDuration, {
        columnsPerSecond,
        signal: controller.signal,
        ...(prioritySeconds !== undefined ? { prioritySeconds } : {}),
        ...(level ? { skipTiles: new Set(level.tiles.keys()) } : {}),
        onProgress: (fraction) => this.setProgress(assetId, 'wave', fraction),
        onStart: (nextColumnCount, sourceSeconds) => {
          if (level) return;
          let cachedTiers = this.waveformTiers.get(assetId);
          if (!cachedTiers) {
            cachedTiers = new Map();
            this.waveformTiers.set(assetId, cachedTiers);
          }
          while (cachedTiers.size >= MAX_CACHED_WAVEFORM_LEVELS) {
            const oldestKey = cachedTiers.keys().next().value as number | undefined;
            if (oldestKey === undefined) break;
            const oldest = cachedTiers.get(oldestKey);
            if (oldest) {
              for (const tile of oldest.tiles.values()) URL.revokeObjectURL(tile.url);
            }
            cachedTiers.delete(oldestKey);
          }
          level = {
            requestedDensity: columnsPerSecond,
            sourceSeconds,
            columnCount: nextColumnCount,
            tiles: new Map(),
            complete: false,
          };
          cachedTiers.set(columnsPerSecond, level);
        },
        onTile: (tileIndex, tile) => {
          if (!level || controller.signal.aborted) {
            URL.revokeObjectURL(tile.url);
            return;
          }
          const previous = level.tiles.get(tileIndex);
          if (previous) URL.revokeObjectURL(previous.url);
          level.tiles.set(tileIndex, tile);
          this.onProgress?.();
        },
      });
      if (controller.signal.aborted || !completed || !level) return;
      level.complete = true;
      this.onProgress?.();
    } catch {
      // The starter remains visible if a zoom-specific waveform cannot be decoded.
    } finally {
      if (this.waveformDensityJobs.get(assetId) === controller) {
        this.waveformDensityJobs.delete(assetId);
        this.waveformPriorityTiles.delete(assetId);
        this.setProgress(assetId, 'wave', null);
      }
    }
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
      // A still has no timeline of frames, so no density can improve it.
      framesPerSecond: 0,
      sourceSeconds: 0,
      posterUrl: url,
      posterWidth: size.width,
      posterHeight: size.height,
    });
  }

  /** Build both previews for an asset. Safe to call repeatedly. */
  /**
   * Build the strip tier requested by the current zoom, if it is not cached yet.
   *
   * Tiers are retained rather than replacing one another. Zooming out can therefore
   * return to the starter strip immediately, and zooming back in can reuse a tier it
   * has already paid to decode. A request arriving while another tier is running
   * aborts that job, which stops a wheel-spin queueing a dozen decode passes.
   */
  async ensureDensity(
    assetId: AssetId,
    videoDuration: Time | null,
    framesPerSecond: number,
    prioritySeconds?: number,
  ): Promise<void> {
    if (!videoDuration) return;

    const existing = this.filmstrips.get(assetId);
    // `undefined` means nothing built yet — `ensure` owns that case.
    if (existing === undefined || existing === null) return;

    const targetCount = filmstripFrameCount(existing.sourceSeconds, framesPerSecond);
    const priorityTile = Math.floor(
      Math.max(0, Math.min(targetCount - 1, (prioritySeconds ?? 0) * framesPerSecond)) /
        FILMSTRIP_FRAMES_PER_TILE,
    );
    const active = this.densityJobs.get(assetId);
    if (
      active &&
      this.density.get(assetId) === framesPerSecond &&
      this.densityPriorityTiles.get(assetId) === priorityTile
    ) return;
    if (active) {
      active.abort();
      this.densityJobs.delete(assetId);
      this.setProgress(assetId, 'film', null);
    }
    this.density.set(assetId, framesPerSecond);
    this.densityPriorityTiles.set(assetId, priorityTile);

    // A starter with the same cell count can be placed on this exact temporal grid
    // by CSS, so decoding the same thumbnails again would buy nothing.
    if (existing.frameCount === targetCount) return;
    const tiers = this.filmstripTiers.get(assetId);
    if (tiers?.get(framesPerSecond)?.complete) return;
    // Several sparse density tiers collapse to the four-frame minimum on a short
    // source. Reuse any tier with the same frame count instead of decoding an
    // indistinguishable strip under another key.
    if ([...(tiers?.values() ?? [])].some((level) => level.complete && level.frameCount === targetCount)) return;

    const controller = new AbortController();
    this.densityJobs.set(assetId, controller);

    try {
      let level = tiers?.get(framesPerSecond);
      const completed = await generateFilmstripTiles(this.media, assetId, videoDuration, {
        framesPerSecond,
        signal: controller.signal,
        ...(prioritySeconds !== undefined ? { prioritySeconds } : {}),
        onProgress: (fraction) => this.setProgress(assetId, 'film', fraction),
        ...(level ? { skipTiles: new Set(level.tiles.keys()) } : {}),
        onStart: (frameCount, sourceSeconds) => {
          if (level) return;
          let cachedTiers = this.filmstripTiers.get(assetId);
          if (!cachedTiers) {
            cachedTiers = new Map();
            this.filmstripTiers.set(assetId, cachedTiers);
          }
          while (cachedTiers.size >= MAX_CACHED_FILMSTRIP_LEVELS) {
            const oldestKey = cachedTiers.keys().next().value as number | undefined;
            if (oldestKey === undefined) break;
            const oldest = cachedTiers.get(oldestKey);
            if (oldest) {
              for (const tile of oldest.tiles.values()) URL.revokeObjectURL(tile.url);
            }
            cachedTiers.delete(oldestKey);
          }
          level = {
            requestedDensity: framesPerSecond,
            sourceSeconds,
            frameCount,
            tiles: new Map(),
            complete: false,
          };
          cachedTiers.set(framesPerSecond, level);
        },
        onTile: (tileIndex, tile) => {
          if (!level || controller.signal.aborted) {
            URL.revokeObjectURL(tile.url);
            return;
          }
          const previous = level.tiles.get(tileIndex);
          if (previous) URL.revokeObjectURL(previous.url);
          level.tiles.set(tileIndex, tile);
          // This is the important progressive repaint: do not wait for the level.
          this.onProgress?.();
        },
      });
      if (controller.signal.aborted || !completed || !level) return;
      level.complete = true;
      this.onProgress?.();
    } catch {
      // A zoom-specific strip is an improvement, not a requirement: on failure the
      // closest cached tier simply stays on screen.
    } finally {
      if (this.densityJobs.get(assetId) === controller) {
        this.densityJobs.delete(assetId);
        this.densityPriorityTiles.delete(assetId);
        this.setProgress(assetId, 'film', null);
      }
    }
  }

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
    for (const controller of this.densityJobs.values()) controller.abort();
    for (const controller of this.waveformDensityJobs.values()) controller.abort();
    for (const strip of this.filmstrips.values()) {
      if (!strip) continue;
      URL.revokeObjectURL(strip.url);
      if (strip.posterUrl !== strip.url) URL.revokeObjectURL(strip.posterUrl);
    }
    for (const tiers of this.filmstripTiers.values()) {
      for (const level of tiers.values()) {
        for (const tile of level.tiles.values()) URL.revokeObjectURL(tile.url);
      }
    }
    for (const wave of this.waveforms.values()) if (wave) URL.revokeObjectURL(wave.url);
    for (const tiers of this.waveformTiers.values()) {
      for (const level of tiers.values()) {
        for (const tile of level.tiles.values()) URL.revokeObjectURL(tile.url);
      }
    }
    this.filmstrips.clear();
    this.filmstripTiers.clear();
    this.waveforms.clear();
    this.waveformTiers.clear();
    this.density.clear();
    this.densityPriorityTiles.clear();
    this.densityJobs.clear();
    this.waveformDensity.clear();
    this.waveformPriorityTiles.clear();
    this.waveformDensityJobs.clear();
    this.progress.clear();
  }
}
