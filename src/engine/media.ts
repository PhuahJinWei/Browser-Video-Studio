/**
 * Media access layer.
 *
 * Wraps Mediabunny so the rest of the engine deals in project types (`AssetId`,
 * `Time`) rather than container details. One `MediaHandle` per asset owns the demuxer
 * and the decode sinks; sinks keep their own decoder warm and handle keyframe seeking,
 * which is why there is no hand-rolled sample index here.
 *
 * Frame ownership: `getFrame` returns a `VideoSample` the **caller must close**.
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  VideoSample,
  VideoSampleSink,
  type WrappedAudioBuffer,
} from 'mediabunny';
import { createAsset } from '../model/factories';
import * as T from '../model/time';
import type { Asset, AssetId, FrameRate, Size, Time } from '../model/types';

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaError';
  }
}

/** What probing a file told us, before it becomes an `Asset`. */
export interface MediaProbe {
  readonly durationSeconds: number;
  readonly video: {
    readonly codec: string;
    readonly size: Size;
    readonly displaySize: Size;
    readonly rotation: 0 | 90 | 180 | 270;
    readonly frameRate: FrameRate | null;
  } | null;
  readonly audio: {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
  } | null;
}

interface MediaHandle {
  readonly assetId: AssetId;
  readonly blob: Blob;
  readonly input: Input;
  readonly videoTrack: InputVideoTrack | null;
  readonly audioTrack: InputAudioTrack | null;
  videoSink: VideoSampleSink | null;
  audioSink: AudioBufferSink | null;
  readonly durationSeconds: number;
}

/**
 * Opens media and serves decoded frames and audio.
 *
 * Handles are cached per asset because constructing a sink re-reads the container
 * index; recreating one per seek would make scrubbing unusable.
 */
export class MediaLibrary {
  private readonly handles = new Map<AssetId, MediaHandle>();
  private readonly opening = new Map<AssetId, Promise<MediaHandle>>();

  /** Inspect a file without registering it. Used by the import flow. */
  static async probe(blob: Blob): Promise<MediaProbe> {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    if (!(await input.canRead())) {
      throw new MediaError('Unrecognised or unsupported media format');
    }

    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack && !audioTrack) throw new MediaError('File contains no audio or video tracks');

    const durationSeconds =
      (await input.getDurationFromMetadata().catch(() => null)) ?? (await input.computeDuration());

    let video: MediaProbe['video'] = null;
    if (videoTrack) {
      const codec = (await videoTrack.getCodecParameterString()) ?? videoTrack.codec ?? 'unknown';
      video = {
        codec,
        size: { width: await videoTrack.getCodedWidth(), height: await videoTrack.getCodedHeight() },
        displaySize: {
          width: await videoTrack.getDisplayWidth(),
          height: await videoTrack.getDisplayHeight(),
        },
        rotation: (await videoTrack.getRotation()) as 0 | 90 | 180 | 270,
        frameRate: await estimateFrameRate(videoTrack, durationSeconds),
      };
    }

    let audio: MediaProbe['audio'] = null;
    if (audioTrack) {
      const codec = (await audioTrack.getCodecParameterString()) ?? audioTrack.codec ?? 'unknown';
      audio = {
        codec,
        sampleRate: await audioTrack.getSampleRate(),
        channels: await audioTrack.getNumberOfChannels(),
      };
    }

    return { durationSeconds, video, audio };
  }

  /** Probe a file and build the `Asset` describing it. */
  static async importFile(assetId: AssetId, file: File | Blob, name: string): Promise<Asset> {
    const probe = await MediaLibrary.probe(file);
    const duration = T.fromSeconds(probe.durationSeconds, 1_000_000);

    const asset = createAsset({
      id: assetId,
      name,
      kind: probe.video ? 'video' : 'audio',
      ...(probe.video ? { videoDuration: duration, size: probe.video.displaySize } : {}),
      ...(probe.video?.frameRate ? { frameRate: probe.video.frameRate } : {}),
      ...(probe.audio ? { audioDuration: duration, sampleRate: probe.audio.sampleRate } : {}),
    });

    // Overlay the real codec details the placeholder factory cannot know.
    return {
      ...asset,
      source: {
        fileName: name,
        byteLength: file.size,
        mimeType: file.type,
        opfsPath: null,
        hasFileHandle: false,
        contentHash: null,
      },
      video:
        asset.video && probe.video
          ? {
              ...asset.video,
              codec: probe.video.codec,
              size: probe.video.displaySize,
              rotation: probe.video.rotation,
            }
          : asset.video,
      audio:
        asset.audio && probe.audio
          ? { ...asset.audio, codec: probe.audio.codec, channels: probe.audio.channels }
          : asset.audio,
    };
  }

  /** Register a blob for an asset so frames can be requested for it. */
  async open(assetId: AssetId, blob: Blob): Promise<void> {
    if (this.handles.has(assetId)) return;
    await this.handleFor(assetId, blob);
  }

  has(assetId: AssetId): boolean {
    return this.handles.has(assetId) || this.opening.has(assetId);
  }

  private async handleFor(assetId: AssetId, blob?: Blob): Promise<MediaHandle> {
    const existing = this.handles.get(assetId);
    if (existing) return existing;

    const pending = this.opening.get(assetId);
    if (pending) return pending;

    if (!blob) throw new MediaError(`Asset "${assetId}" has no media registered`);

    const promise = (async (): Promise<MediaHandle> => {
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      if (!(await input.canRead())) throw new MediaError('Unsupported media format');

      const videoTrack = await input.getPrimaryVideoTrack();
      const audioTrack = await input.getPrimaryAudioTrack();
      const durationSeconds =
        (await input.getDurationFromMetadata().catch(() => null)) ?? (await input.computeDuration());

      const handle: MediaHandle = {
        assetId,
        blob,
        input,
        videoTrack,
        audioTrack,
        videoSink: null,
        audioSink: null,
        durationSeconds,
      };
      this.handles.set(assetId, handle);
      this.opening.delete(assetId);
      return handle;
    })();

    this.opening.set(assetId, promise);
    return promise;
  }

  /**
   * Decoded frame at a source time. The caller owns the returned sample and must
   * close it. Returns null when the asset has no video or the time is out of range.
   */
  async getFrame(assetId: AssetId, at: Time): Promise<VideoSample | null> {
    const handle = await this.handleFor(assetId);
    if (!handle.videoTrack) return null;
    handle.videoSink ??= new VideoSampleSink(handle.videoTrack);

    const seconds = T.toSeconds(at);
    if (seconds < 0 || seconds > handle.durationSeconds) return null;
    return handle.videoSink.getSample(seconds);
  }

  /** Decoded audio covering a source time, or null. */
  async getAudio(assetId: AssetId, at: Time): Promise<WrappedAudioBuffer | null> {
    const handle = await this.handleFor(assetId);
    if (!handle.audioTrack) return null;
    handle.audioSink ??= new AudioBufferSink(handle.audioTrack);

    const seconds = T.toSeconds(at);
    if (seconds < 0 || seconds > handle.durationSeconds) return null;
    return handle.audioSink.getBuffer(seconds);
  }

  /** Sequential audio over a source range — used by the mixer and by export. */
  async *audioRange(
    assetId: AssetId,
    from: Time,
    to: Time,
  ): AsyncGenerator<WrappedAudioBuffer, void, unknown> {
    const handle = await this.handleFor(assetId);
    if (!handle.audioTrack) return;
    handle.audioSink ??= new AudioBufferSink(handle.audioTrack);
    yield* handle.audioSink.buffers(T.toSeconds(from), T.toSeconds(to));
  }

  /** Sequential frames over a source range — used by export. */
  async *frameRange(assetId: AssetId, from: Time, to: Time): AsyncGenerator<VideoSample, void, unknown> {
    const handle = await this.handleFor(assetId);
    if (!handle.videoTrack) return;
    handle.videoSink ??= new VideoSampleSink(handle.videoTrack);
    yield* handle.videoSink.samples(T.toSeconds(from), T.toSeconds(to));
  }

  hasVideo(assetId: AssetId): boolean {
    return this.handles.get(assetId)?.videoTrack != null;
  }

  hasAudio(assetId: AssetId): boolean {
    return this.handles.get(assetId)?.audioTrack != null;
  }

  /** Release a single asset's demuxer and decoders. */
  close(assetId: AssetId): void {
    const handle = this.handles.get(assetId);
    if (!handle) return;
    void handle.input.dispose?.();
    this.handles.delete(assetId);
  }

  closeAll(): void {
    for (const assetId of [...this.handles.keys()]) this.close(assetId);
  }
}

/**
 * Frame rate from the container when it is constant, else null.
 *
 * Mediabunny does not expose a nominal rate, so this samples the first second of
 * packets. Variable-rate sources (most phone video) legitimately return null, and
 * the sequence rate is used instead.
 */
async function estimateFrameRate(
  track: InputVideoTrack,
  durationSeconds: number,
): Promise<FrameRate | null> {
  try {
    const sink = new VideoSampleSink(track);
    const timestamps: number[] = [];
    for await (const sample of sink.samples(0, Math.min(1, durationSeconds))) {
      timestamps.push(sample.timestamp);
      sample.close();
      if (timestamps.length >= 30) break;
    }
    if (timestamps.length < 3) return null;

    const gaps = timestamps.slice(1).map((t, i) => t - timestamps[i]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean <= 0) return null;

    // Reject variable frame rate: more than 1 % spread means we cannot claim a rate.
    const spread = Math.max(...gaps) - Math.min(...gaps);
    if (spread / mean > 0.01) return null;

    return snapToBroadcastRate(1 / mean);
  } catch {
    return null;
  }
}

const COMMON_RATES: readonly FrameRate[] = [
  T.FPS_23_976,
  T.FPS_24,
  T.FPS_25,
  T.FPS_29_97,
  T.FPS_30,
  T.FPS_50,
  T.FPS_59_94,
  T.FPS_60,
];

/** Snap a measured rate onto a standard one when it is within 0.5 %. */
function snapToBroadcastRate(fps: number): FrameRate {
  for (const rate of COMMON_RATES) {
    if (Math.abs(T.fpsToNumber(rate) - fps) / fps < 0.005) return rate;
  }
  const approx = T.fromSeconds(fps, 1000);
  return T.frameRate(approx.num, approx.den);
}
