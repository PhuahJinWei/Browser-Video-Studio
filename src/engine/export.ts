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
  canEncodeAudio,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
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

export type ContainerKey = 'mp4' | 'webm';

export interface ExportSettings {
  readonly container: ContainerKey;
  /** Must be one the container can carry; see `CONTAINERS`. */
  readonly videoCodec: VideoCodec;
  readonly size: Size;
  readonly frameRate: FrameRate;
  /** Target video bitrate in bits per second. */
  readonly bitrate: number;
  readonly includeAudio: boolean;
  /** Target audio bitrate in bits per second. Ignored when audio is off. */
  readonly audioBitrate: number;
  readonly range?: { readonly start: Time; readonly end: Time };
}

export interface ExportResult {
  /** Present for download fallback; null when bytes were streamed straight to disk. */
  readonly blob: Blob | null;
  readonly byteLength: number;
  readonly fileName: string;
  readonly durationSeconds: number;
  readonly framesEncoded: number;
}

/** A video codec the UI offers, and what a person needs in order to choose it. */
export interface VideoCodecChoice {
  readonly codec: VideoCodec;
  readonly label: string;
  /** What picking it buys or costs, in one clause. */
  readonly note: string;
  /**
   * Bits needed for a comparable picture, relative to H.264.
   *
   * Newer codecs buy smaller files with encode time, and the suggested bitrate has to
   * know it: offering AV1 while still asking for H.264's bitrate would hand back the
   * entire saving and leave only the slowness.
   */
  readonly efficiency: number;
}

export interface ContainerProfile {
  readonly label: string;
  readonly extension: string;
  readonly mime: string;
  /**
   * The audio codec, fixed per container rather than chosen.
   *
   * MP4 can technically carry Opus and WebM can carry Vorbis, but neither pairing has
   * a use that outweighs handing someone a file their player will not open. One less
   * decision, and the one that would only ever be got wrong.
   */
  readonly audio: AudioCodec;
  readonly audioLabel: string;
  /** Most compatible first: the head of this list is the safe default. */
  readonly video: readonly VideoCodecChoice[];
}

export const CONTAINERS: Readonly<Record<ContainerKey, ContainerProfile>> = {
  mp4: {
    label: 'MP4',
    extension: 'mp4',
    mime: 'video/mp4',
    audio: 'aac',
    audioLabel: 'AAC',
    video: [
      { codec: 'avc', label: 'H.264', note: 'Plays everywhere', efficiency: 1 },
      { codec: 'hevc', label: 'H.265', note: 'Smaller, needs a recent player', efficiency: 0.62 },
      { codec: 'av1', label: 'AV1', note: 'Smallest, slowest to encode', efficiency: 0.55 },
    ],
  },
  webm: {
    label: 'WebM',
    extension: 'webm',
    mime: 'video/webm',
    audio: 'opus',
    audioLabel: 'Opus',
    video: [
      { codec: 'vp9', label: 'VP9', note: 'Good size, broad browser support', efficiency: 0.68 },
      { codec: 'av1', label: 'AV1', note: 'Smallest, slowest to encode', efficiency: 0.55 },
      { codec: 'vp8', label: 'VP8', note: 'Oldest, widest legacy support', efficiency: 1.2 },
    ],
  },
};

/** The safe codec for a container: the most compatible one it offers. */
export function defaultVideoCodec(container: ContainerKey): VideoCodec {
  return CONTAINERS[container].video[0]?.codec ?? 'avc';
}

/** The codec choice for a container, or undefined when that container cannot carry it. */
export function videoCodecChoice(
  container: ContainerKey,
  codec: VideoCodec,
): VideoCodecChoice | undefined {
  return CONTAINERS[container].video.find((choice) => choice.codec === codec);
}

export interface ExportOptions {
  readonly project: Project;
  readonly sequenceId: SequenceId;
  readonly media: MediaLibrary;
  readonly settings: ExportSettings;
  readonly onProgress?: (progress: ExportProgress) => void;
  readonly signal?: AbortSignal;
  /** Optional seekable output stream, normally a File System Access destination. */
  readonly destination?: ExportDestination;
}

export interface ExportDestination {
  readonly writable: WritableStream<StreamTargetChunk>;
  /** Mark the destination aborted before the muxer closes it. */
  readonly cancel: () => void;
  readonly byteLength: () => number;
}

export interface ExportSupport {
  readonly mp4: boolean;
  readonly webm: boolean;
  readonly mp4Reason: string | null;
  readonly webmReason: string | null;
  /**
   * Per video codec, whether this browser can encode it at this size and rate.
   *
   * Separate from the container flags because the dialog has to grey out individual
   * codecs, not just refuse a whole format: a machine without an AV1 encoder can
   * still write a perfectly good MP4.
   */
  readonly videoCodecs: Readonly<Partial<Record<VideoCodec, boolean>>>;
}

/** Every codec any container offers, each probed once even where two share it. */
const PROBED_VIDEO_CODECS: readonly VideoCodec[] = [
  ...new Set(Object.values(CONTAINERS).flatMap((profile) => profile.video.map((v) => v.codec))),
];

/**
 * What this browser can actually encode at the requested size and rate.
 *
 * Probed rather than assumed: encoder support is a function of the exact
 * configuration, so a machine that manages 720p H.264 may refuse 4K, and boot-time
 * capability says nothing about what the dialog is currently asking for.
 *
 * The codec strings are built by mediabunny from the dimensions rather than written
 * out here. Getting an H.264 level string right means mapping frame size and bitrate
 * onto a table, and the hand-rolled pair this replaced only knew two of them — so
 * anything above 1080p was probed as though it were 1080p and reported support that
 * the encoder need not have had.
 */
export async function detectExportSupport(settings: ExportSettings): Promise<ExportSupport> {
  if (typeof VideoEncoder === 'undefined') {
    return {
      mp4: false,
      webm: false,
      mp4Reason: 'VideoEncoder is unavailable',
      webmReason: 'VideoEncoder is unavailable',
      videoCodecs: {},
    };
  }

  const shape = {
    width: settings.size.width,
    height: settings.size.height,
    bitrate: settings.bitrate,
  };
  const audioShape = {
    numberOfChannels: 2,
    sampleRate: 48_000,
    bitrate: settings.audioBitrate,
  };

  const probeVideo = async (codec: VideoCodec): Promise<boolean> => {
    try {
      return await canEncodeVideo(codec, shape);
    } catch {
      return false;
    }
  };
  const probeAudio = async (codec: AudioCodec): Promise<boolean> => {
    // Audio that is not being written cannot be the reason a format is unavailable.
    if (!settings.includeAudio) return true;
    try {
      return await canEncodeAudio(codec, audioShape);
    } catch {
      return false;
    }
  };

  const [videoResults, mp4Audio, webmAudio] = await Promise.all([
    Promise.all(PROBED_VIDEO_CODECS.map(async (codec) => [codec, await probeVideo(codec)] as const)),
    probeAudio(CONTAINERS.mp4.audio),
    probeAudio(CONTAINERS.webm.audio),
  ]);
  const videoCodecs: Partial<Record<VideoCodec, boolean>> = Object.fromEntries(videoResults);

  const verdict = (key: ContainerKey, audioOk: boolean): { ok: boolean; reason: string | null } => {
    const profile = CONTAINERS[key];
    const anyVideo = profile.video.some((choice) => videoCodecs[choice.codec] === true);
    if (!anyVideo) {
      return { ok: false, reason: `No ${profile.label} video codec works at this size and rate` };
    }
    if (!audioOk) return { ok: false, reason: `${profile.audioLabel} encoding is unavailable` };
    return { ok: true, reason: null };
  };

  const mp4 = verdict('mp4', mp4Audio);
  const webm = verdict('webm', webmAudio);
  return {
    mp4: mp4.ok,
    webm: webm.ok,
    mp4Reason: mp4.reason,
    webmReason: webm.reason,
    videoCodecs,
  };
}

/** Render, encode and mux a sequence. Resolves with the finished file. */
export async function exportSequence(options: ExportOptions): Promise<ExportResult> {
  const { project, sequenceId, media, settings, onProgress, signal, destination } = options;
  const sequence = project.sequences[sequenceId];
  if (!sequence) throw new ExportError(`No sequence "${sequenceId}"`);

  const started = performance.now();
  const codecs = CONTAINERS[settings.container];
  // A codec the container cannot carry is a caller's mistake, and one that would
  // otherwise surface as a muxer error halfway through a long encode.
  if (!videoCodecChoice(settings.container, settings.videoCodec)) {
    throw new ExportError(`${codecs.label} cannot carry ${settings.videoCodec}`);
  }

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

  const target = destination
    ? new StreamTarget(destination.writable, { chunked: true })
    : new BufferTarget();
  const output = new Output({
    // A disk target can seek, so a regular MP4 keeps the broadest player support
    // without accumulating media chunks in memory for fast-start placement.
    format: settings.container === 'mp4'
      ? new Mp4OutputFormat({ fastStart: destination ? false : 'in-memory' })
      : new WebMOutputFormat(),
    target,
  });

  const videoSource = new VideoSampleSource({
    codec: settings.videoCodec,
    bitrate: settings.bitrate,
  });
  output.addVideoTrack(videoSource, { frameRate: T.fpsToNumber(settings.frameRate) });

  let audioSource: AudioBufferSource | null = null;
  if (settings.includeAudio) {
    audioSource = new AudioBufferSource({ codec: codecs.audio, bitrate: settings.audioBitrate });
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

    const buffer = target instanceof BufferTarget ? target.buffer : null;
    if (!destination && !buffer) throw new ExportError('Muxer produced no output');
    const blob = buffer ? new Blob([buffer], { type: codecs.mime }) : null;
    const byteLength = blob?.size ?? destination?.byteLength() ?? 0;

    report('done');
    return {
      blob,
      byteLength,
      fileName: `${sequence.name || 'sequence'}.${codecs.extension}`,
      durationSeconds: T.toSeconds(duration),
      framesEncoded,
    };
  } catch (error) {
    destination?.cancel();
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

// ---------------------------------------------------------------------------
// Bitrate
// ---------------------------------------------------------------------------

/**
 * How good the picture should be, as a person would put it.
 *
 * Bits per second is the wrong unit to ask anyone for: the number that means "good"
 * depends on the frame size, the frame rate and the codec all at once, so the same
 * 8 Mbps is generous at 720p and thin at 4K. A quality level holds still across all
 * three, and the bitrate is derived from it — which is also why changing resolution
 * or codec can move the slider on its own.
 */
export type ExportQuality = 'low' | 'medium' | 'high' | 'best';

export const EXPORT_QUALITIES: readonly {
  readonly key: ExportQuality;
  readonly label: string;
  readonly factor: number;
}[] = [
  { key: 'low', label: 'Low', factor: 0.45 },
  { key: 'medium', label: 'Medium', factor: 1 },
  { key: 'high', label: 'High', factor: 1.8 },
  { key: 'best', label: 'Best', factor: 3 },
];

/**
 * Bits per pixel per second for H.264 at medium.
 *
 * Calibrated against the rates the large video services publish: this puts 1080p30 at
 * about 7.5 Mbps and 2160p30 at about 30 Mbps, both within their recommended bands.
 */
const BASE_BITS_PER_PIXEL = 0.12;

/** Floor and ceiling, so a postage stamp is not starved and 8K is not absurd. */
const MIN_BITRATE = 200_000;
const MAX_BITRATE = 100_000_000;

/** The audio rates worth offering, in bits per second. */
export const AUDIO_BITRATES: readonly number[] = [128_000, 192_000, 256_000, 320_000];

/** Transparent enough for stereo music in both AAC and Opus, and a common default. */
export const DEFAULT_AUDIO_BITRATE = 192_000;

/**
 * A sensible video bitrate for a size, rate, codec and quality, in bits per second.
 *
 * Codec efficiency is folded in, so switching to AV1 lowers the suggestion rather
 * than keeping the file the same size as H.264's and spending the saving on nothing.
 */
export function suggestBitrate(
  size: Size,
  frameRate: FrameRate,
  codec: VideoCodec = 'avc',
  quality: ExportQuality = 'medium',
): number {
  const pixelsPerSecond = size.width * size.height * T.fpsToNumber(frameRate);
  const efficiency = codecEfficiency(codec);
  const factor = EXPORT_QUALITIES.find((level) => level.key === quality)?.factor ?? 1;
  const raw = pixelsPerSecond * BASE_BITS_PER_PIXEL * efficiency * factor;
  return Math.round(Math.max(MIN_BITRATE, Math.min(MAX_BITRATE, raw)));
}

/** Relative bits needed by a codec; 1 is H.264. Unknown codecs are treated as H.264. */
function codecEfficiency(codec: VideoCodec): number {
  for (const profile of Object.values(CONTAINERS)) {
    const choice = profile.video.find((entry) => entry.codec === codec);
    if (choice) return choice.efficiency;
  }
  return 1;
}

/**
 * Roughly how large the finished file will be, in bytes.
 *
 * Both tracks run at a target rate, so the payload is simply rate × time; the few
 * percent added on top is container overhead — sample tables, cluster headers — which
 * is small but not nothing, and rounding it away would make every estimate read low.
 */
export function estimateExportBytes(settings: ExportSettings, durationSeconds: number): number {
  if (!(durationSeconds > 0)) return 0;
  const audio = settings.includeAudio ? settings.audioBitrate : 0;
  return Math.round(((settings.bitrate + audio) / 8) * durationSeconds * 1.02);
}
