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
}

export interface Waveform {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly sourceSeconds: number;
}

const FILMSTRIP_HEIGHT = 44;
const MAX_FILMSTRIP_FRAMES = 40;
const WAVEFORM_HEIGHT = 44;
const WAVEFORM_COLUMNS = 900;

/**
 * Decode frames across the source and lay them out side by side.
 * Returns null when the asset has no video.
 */
export async function generateFilmstrip(
  media: MediaLibrary,
  assetId: AssetId,
  duration: Time,
  signal?: AbortSignal,
): Promise<Filmstrip | null> {
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
    } finally {
      frame.close();
      sample.close();
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.7 });
  return {
    url: URL.createObjectURL(blob),
    frameWidth,
    frameHeight: FILMSTRIP_HEIGHT,
    frameCount,
    sourceSeconds,
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
  signal?: AbortSignal,
): Promise<Waveform | null> {
  const sourceSeconds = T.toSeconds(duration);
  if (sourceSeconds <= 0) return null;

  const columns = WAVEFORM_COLUMNS;
  const peaks = new Float32Array(columns); // absolute peak per column
  let sawAudio = false;

  const secondsPerColumn = sourceSeconds / columns;

  for await (const wrapped of media.audioRange(assetId, T.TIME_ZERO, duration)) {
    if (signal?.aborted) return null;
    sawAudio = true;

    const { buffer, timestamp } = wrapped;
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

  constructor(private readonly media: MediaLibrary) {}

  getFilmstrip(assetId: AssetId): Filmstrip | null | undefined {
    return this.filmstrips.get(assetId);
  }

  getWaveform(assetId: AssetId): Waveform | null | undefined {
    return this.waveforms.get(assetId);
  }

  /** Build both previews for an asset. Safe to call repeatedly. */
  async ensure(assetId: AssetId, videoDuration: Time | null, audioDuration: Time | null): Promise<void> {
    const jobs: Promise<unknown>[] = [];

    if (videoDuration && !this.filmstrips.has(assetId)) {
      jobs.push(
        this.once(`film:${assetId}`, async () => {
          const strip = await generateFilmstrip(this.media, assetId, videoDuration).catch(() => null);
          this.filmstrips.set(assetId, strip);
        }),
      );
    }
    if (audioDuration && !this.waveforms.has(assetId)) {
      jobs.push(
        this.once(`wave:${assetId}`, async () => {
          const wave = await generateWaveform(this.media, assetId, audioDuration).catch(() => null);
          this.waveforms.set(assetId, wave);
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
    for (const strip of this.filmstrips.values()) if (strip) URL.revokeObjectURL(strip.url);
    for (const wave of this.waveforms.values()) if (wave) URL.revokeObjectURL(wave.url);
    this.filmstrips.clear();
    this.waveforms.clear();
  }
}
