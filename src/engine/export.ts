/**
 * Export.
 *
 * Walks the sequence frame by frame through the same compositor the preview uses,
 * encodes each result, mixes the audio offline, and muxes both into a file.
 *
 * Progress is reported per stage so the UI can show what the browser is actually
 * doing rather than one opaque bar.
 */

import {
  AudioBufferSource,
  BufferTarget,
  type AudioCodec,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSource,
  type VideoCodec,
  WebMOutputFormat,
} from 'mediabunny';
import { renderListAt, sequenceDuration } from '../model/selectors';
import * as T from '../model/time';
import type { FrameRate, Project, SequenceId, Size, Time } from '../model/types';
import { renderAudioRange } from './audio';
import { Compositor, type DrawLayer } from './compositor';
import { foldEffects, NEUTRAL_EFFECTS } from './effects';
import type { MediaLibrary } from './media';
import { renderSolid } from './solids';
import { renderTitle } from './titles';

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export type ExportStage = 'preparing' | 'audio' | 'video' | 'finalising' | 'done';

export interface ExportProgress {
  readonly stage: ExportStage;
  /** 0–1 across the whole job. */
  readonly overall: number;
  readonly framesEncoded: number;
  readonly totalFrames: number;
  /** Encoding throughput in frames per second. */
  readonly fps: number;
  readonly audioDone: boolean;
  readonly elapsedMs: number;
}

export interface ExportSettings {
  readonly container: 'mp4' | 'webm';
  readonly size: Size;
  readonly frameRate: FrameRate;
  /** Target video bitrate in bits per second. */
  readonly bitrate: number;
  readonly includeAudio: boolean;
  readonly range?: { readonly start: Time; readonly end: Time };
}

export interface ExportResult {
  readonly blob: Blob;
  readonly fileName: string;
  readonly durationSeconds: number;
  readonly framesEncoded: number;
}

const CONTAINER_CODECS = {
  mp4: { video: 'avc' as VideoCodec, audio: 'aac' as AudioCodec, extension: 'mp4', mime: 'video/mp4' },
  webm: { video: 'vp9' as VideoCodec, audio: 'opus' as AudioCodec, extension: 'webm', mime: 'video/webm' },
} as const;

export interface ExportOptions {
  readonly project: Project;
  readonly sequenceId: SequenceId;
  readonly media: MediaLibrary;
  readonly settings: ExportSettings;
  readonly onProgress?: (progress: ExportProgress) => void;
  readonly signal?: AbortSignal;
}

/** Render, encode and mux a sequence. Resolves with the finished file. */
export async function exportSequence(options: ExportOptions): Promise<ExportResult> {
  const { project, sequenceId, media, settings, onProgress, signal } = options;
  const sequence = project.sequences[sequenceId];
  if (!sequence) throw new ExportError(`No sequence "${sequenceId}"`);

  const started = performance.now();
  const codecs = CONTAINER_CODECS[settings.container];

  const start = settings.range?.start ?? T.TIME_ZERO;
  const end = settings.range?.end ?? sequenceDuration(project, sequenceId);
  const duration = T.sub(end, start);
  if (!T.isPositive(duration)) throw new ExportError('Nothing to export: the range is empty');

  const totalFrames = Math.max(1, T.ceilFrames(duration, settings.frameRate));
  const frameStep = T.frameDuration(settings.frameRate);

  let framesEncoded = 0;
  let audioDone = false;
  const report = (stage: ExportStage): void => {
    if (!onProgress) return;
    const elapsedMs = performance.now() - started;
    // Audio is roughly a fifth of the work; the rest tracks encoded frames.
    const videoShare = totalFrames > 0 ? framesEncoded / totalFrames : 0;
    const overall =
      stage === 'done' ? 1 : Math.min(0.99, (audioDone ? 0.2 : 0) + videoShare * 0.8);
    onProgress({
      stage,
      overall,
      framesEncoded,
      totalFrames,
      fps: elapsedMs > 0 ? (framesEncoded / elapsedMs) * 1000 : 0,
      audioDone,
      elapsedMs,
    });
  };

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new ExportError('Export cancelled');
  };

  report('preparing');
  throwIfAborted();

  // A compositor with no canvas: renders offscreen and reads back.
  const compositor = await Compositor.create(null, settings.size);

  const output = new Output({
    format: settings.container === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  const videoSource = new VideoSampleSource({
    codec: codecs.video,
    bitrate: settings.bitrate,
  });
  output.addVideoTrack(videoSource, { frameRate: T.fpsToNumber(settings.frameRate) });

  let audioSource: AudioBufferSource | null = null;
  if (settings.includeAudio) {
    audioSource = new AudioBufferSource({ codec: codecs.audio, bitrate: new Quality(0.7) });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  try {
    // -- audio ------------------------------------------------------------
    if (audioSource) {
      report('audio');
      // Rendered in slices so a long timeline does not need one giant buffer.
      const sliceSeconds = 10;
      let cursor = start;
      while (T.lt(cursor, end)) {
        throwIfAborted();
        const sliceEnd = T.min(T.add(cursor, T.fromSeconds(sliceSeconds, 1)), end);
        const slice = await renderAudioRange(
          project,
          sequenceId,
          T.rangeFromBounds(cursor, sliceEnd),
          media,
        );
        if (slice) await audioSource.add(slice);
        cursor = sliceEnd;
      }
      audioSource.close();
      audioDone = true;
      report('audio');
    }

    // -- video ------------------------------------------------------------
    report('video');
    for (let index = 0; index < totalFrames; index++) {
      throwIfAborted();

      const at = T.add(start, T.mulInt(frameStep, index));
      const { layers, owned } = await collectExportLayers(project, sequenceId, at, media, settings.size);

      try {
        compositor.render(layers);
      } finally {
        for (const frame of owned) frame.close();
      }

      const pixels = await compositor.readPixels();
      const sample = new VideoSample(pixels, {
        format: 'RGBA',
        codedWidth: settings.size.width,
        codedHeight: settings.size.height,
        timestamp: T.toSeconds(T.mulInt(frameStep, index)),
        duration: T.toSeconds(frameStep),
      });

      try {
        await videoSource.add(sample);
      } finally {
        sample.close();
      }

      framesEncoded++;
      if (index % 5 === 0 || index === totalFrames - 1) report('video');
    }
    videoSource.close();

    // -- mux --------------------------------------------------------------
    report('finalising');
    throwIfAborted();
    await output.finalize();

    const target = output.target as BufferTarget;
    if (!target.buffer) throw new ExportError('Muxer produced no output');
    const blob = new Blob([target.buffer], { type: codecs.mime });

    report('done');
    return {
      blob,
      fileName: `${sequence.name || 'sequence'}.${codecs.extension}`,
      durationSeconds: T.toSeconds(duration),
      framesEncoded,
    };
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    compositor.destroy();
  }
}

/** Same layer assembly the preview uses, but always at full quality. */
async function collectExportLayers(
  project: Project,
  sequenceId: SequenceId,
  at: Time,
  media: MediaLibrary,
  sequenceSize: Size,
): Promise<{ layers: DrawLayer[]; owned: VideoFrame[] }> {
  const renderLayers = renderListAt(project, sequenceId, at);
  const layers: DrawLayer[] = [];
  const owned: VideoFrame[] = [];

  for (const layer of renderLayers) {
    const relative = T.sub(at, layer.clip.start);
    const effects = foldEffects([...layer.effects, ...layer.trackEffects], relative, NEUTRAL_EFFECTS);

    if (layer.clip.kind === 'title') {
      const { image, size } = renderTitle(layer.clip, sequenceSize);
      layers.push({
        image,
        imageSize: size,
        transform: layer.transform,
        opacity: layer.opacity,
        crop: layer.crop,
        blendMode: layer.blendMode,
        wipe: layer.wipe,
        effects,
      });
      continue;
    }

    if (layer.clip.kind === 'solid') {
      const { image, size } = renderSolid(layer.clip.fill, sequenceSize);
      layers.push({
        image,
        imageSize: size,
        transform: layer.transform,
        opacity: layer.opacity,
        crop: layer.crop,
        blendMode: layer.blendMode,
        wipe: layer.wipe,
        effects,
      });
      continue;
    }

    if (layer.clip.kind === 'image') {
      const still = media.getStill(layer.clip.assetId);
      if (!still) continue;
      layers.push({
        image: still,
        imageSize: { width: still.width, height: still.height },
        transform: layer.transform,
        opacity: layer.opacity,
        crop: layer.crop,
        blendMode: layer.blendMode,
        wipe: layer.wipe,
        effects,
      });
      continue;
    }

    if (!layer.sourceTime) continue;
    const sample = await media.getFrame(layer.clip.assetId, layer.sourceTime).catch(() => null);
    if (!sample) continue;

    const frame = sample.toVideoFrame();
    sample.close();
    owned.push(frame);

    layers.push({
      image: frame,
      imageSize: { width: frame.displayWidth, height: frame.displayHeight },
      transform: layer.transform,
      opacity: layer.opacity,
      crop: layer.crop,
      blendMode: layer.blendMode,
      wipe: layer.wipe,
      effects,
    });
  }

  return { layers, owned };
}

/** Sensible bitrate for a resolution and frame rate, in bits per second. */
export function suggestBitrate(size: Size, frameRate: FrameRate): number {
  const pixelsPerSecond = size.width * size.height * T.fpsToNumber(frameRate);
  // ~0.08 bits per pixel, clamped to a range that stays useful for tiny and huge frames.
  return Math.round(Math.max(1_000_000, Math.min(60_000_000, pixelsPerSecond * 0.08)));
}
