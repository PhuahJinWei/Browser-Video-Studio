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
  EncodedPacketSink,
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
  /** Reads the container index without decoding; for finding keyframes. */
  packetSink: EncodedPacketSink | null;
  /** Presentation times of every video keyframe, walked once and kept. */
  keyframes: Promise<readonly number[]> | null;
  readonly durationSeconds: number;
}

/** How long a still lasts when first placed. Stills stretch freely afterwards. */
export const DEFAULT_STILL_DURATION_SECONDS = 5;

/**
 * A decoder walking one clip forward in step with the play head.
 *
 * `getSample` is random access: it builds a decoder, seeks back to the keyframe
 * before the time asked for, decodes the whole run up to it, flushes and closes --
 * every call. That is the right shape for scrubbing and the wrong one for playing,
 * where the next request is a frame later and re-decodes almost the same run. On a
 * 1080p H.264 clip it measured 26-143 ms per frame, rising with distance from the
 * keyframe. Walking a single iterator instead decodes each packet once.
 */
interface FrameCursor {
  readonly assetId: AssetId;
  iterator: AsyncGenerator<VideoSample, void, unknown> | null;
  /** Latest sample at or before the last time asked for. Owned by the cursor. */
  current: VideoSample | null;
  /** Pulled from the iterator but still in the future. Owned by the cursor. */
  lookahead: VideoSample | null;
  /** Source seconds last asked for, so a jump can be told from a step. */
  at: number;
  /** Monotonic stamp for least-recently-used eviction. */
  used: number;
}

/**
 * How far ahead a cursor will walk before starting over instead.
 *
 * Walking wins only while the frames wanted are the frames coming next. Past about
 * a second the skipped frames cost more to decode and throw away than a fresh seek
 * to the nearest keyframe costs outright.
 */
const CURSOR_RESYNC_SECONDS = 1;

/**
 * Cursors kept alive at once.
 *
 * Each holds an open decoder, so this is a real resource. Two is the common case (a
 * dissolve), and the limit only bites on a stack deeper than most projects have.
 */
const MAX_CURSORS = 8;

/** Timestamps are floats; a frame boundary must not miss itself by a rounding error. */
const TIMESTAMP_EPSILON = 1e-9;

export function isImageFile(file: File | Blob): boolean {
  return file.type.startsWith('image/');
}

/**
 * Opens media and serves decoded frames and audio.
 *
 * Handles are cached per asset because constructing a sink re-reads the container
 * index; recreating one per seek would make scrubbing unusable.
 */
export class MediaLibrary {
  private readonly handles = new Map<AssetId, MediaHandle>();
  /** Lower-resolution video handles used only by sequential preview playback. */
  private readonly proxies = new Map<AssetId, MediaHandle>();
  private readonly opening = new Map<AssetId, Promise<MediaHandle>>();
  /** Decoded stills, which have no container and so no demuxer handle. */
  private readonly stills = new Map<AssetId, ImageBitmap>();
  /** Sequential decoders, keyed by whatever is walking them -- one per clip. */
  private readonly cursors = new Map<string, FrameCursor>();
  private cursorClock = 0;

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

  /**
   * Import a still.
   *
   * Images have no container for Mediabunny to demux, so they take their own
   * path: decode once to an ImageBitmap and describe the asset from that. The
   * asset carries a nominal video stream so placement, drop ghosts and the
   * inspector can treat it like any other visual clip; `clipTrimHandles`
   * already reports stills as unbounded, so it still stretches freely.
   */
  static async importImage(assetId: AssetId, file: File | Blob, name: string): Promise<Asset> {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();

    const duration = T.time(DEFAULT_STILL_DURATION_SECONDS);
    const asset = createAsset({ id: assetId, name, kind: 'image', videoDuration: duration, size });
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
      image: { size },
      video: asset.video ? { ...asset.video, codec: file.type || 'image', frameRate: null } : null,
      audio: null,
    };
  }

  /** Register a decoded still so the compositor can draw it. */
  async openImage(assetId: AssetId, file: Blob): Promise<void> {
    if (this.stills.has(assetId)) return;
    this.stills.set(assetId, await createImageBitmap(file));
  }

  /** The decoded still for an asset, or null when it is not an image. */
  getStill(assetId: AssetId): ImageBitmap | null {
    return this.stills.get(assetId) ?? null;
  }

  /** Register a blob for an asset so frames can be requested for it. */
  async open(assetId: AssetId, blob: Blob): Promise<void> {
    if (this.handles.has(assetId)) return;
    await this.handleFor(assetId, blob);
  }

  async openProxy(assetId: AssetId, blob: Blob): Promise<void> {
    this.closeProxy(assetId);
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    if (!(await input.canRead())) throw new MediaError('Unsupported proxy format');
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new MediaError('Proxy contains no video track');
    const durationSeconds =
      (await input.getDurationFromMetadata().catch(() => null)) ?? (await input.computeDuration());
    this.proxies.set(assetId, {
      assetId,
      blob,
      input,
      videoTrack,
      audioTrack: null,
      videoSink: null,
      audioSink: null,
      packetSink: null,
      keyframes: null,
      durationSeconds,
    });
    // Any active walk belongs to the old source choice.
    for (const [key, cursor] of this.cursors) {
      if (cursor.assetId !== assetId) continue;
      this.cursors.delete(key);
      void closeCursor(cursor);
    }
  }

  closeProxy(assetId: AssetId): void {
    const handle = this.proxies.get(assetId);
    if (!handle) return;
    for (const [key, cursor] of this.cursors) {
      if (cursor.assetId !== assetId) continue;
      this.cursors.delete(key);
      void closeCursor(cursor);
    }
    void handle.input.dispose?.();
    this.proxies.delete(assetId);
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
        packetSink: null,
        keyframes: null,
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

  /**
   * The frames at a sorted list of source times, decoded in one pass.
   *
   * One decoder serves the whole list, and a run of times inside the same group of
   * pictures decodes its lead-in once rather than once per time -- which is what
   * `getFrame` in a loop does. Yields null where a time has no frame. Samples are
   * owned by the caller.
   */
  async *framesAt(assetId: AssetId, seconds: readonly number[]): AsyncGenerator<VideoSample | null, void, unknown> {
    const handle = await this.handleFor(assetId);
    if (!handle.videoTrack) return;
    handle.videoSink ??= new VideoSampleSink(handle.videoTrack);
    yield* handle.videoSink.samplesAtTimestamps(seconds);
  }

  /**
   * Presentation times of the video keyframes, in order.
   *
   * Read from the container index, so this costs a walk over the packet table and
   * no decoding. A keyframe is the one picture that can be decoded on its own,
   * which makes these the cheap places to sample a long source.
   */
  async keyframeTimes(assetId: AssetId): Promise<readonly number[]> {
    const handle = await this.handleFor(assetId);
    if (!handle.videoTrack) return [];
    handle.packetSink ??= new EncodedPacketSink(handle.videoTrack);
    const sink = handle.packetSink;
    handle.keyframes ??= (async () => {
      const times: number[] = [];
      let packet = await sink.getFirstKeyPacket({ metadataOnly: true });
      while (packet) {
        times.push(packet.timestamp);
        packet = await sink.getNextKeyPacket(packet, { metadataOnly: true });
      }
      return times;
    })().catch(() => []);
    return handle.keyframes;
  }

  /**
   * The frame at a source time, decoded by walking forward from the last one.
   *
   * For playback, where the caller asks for a steadily advancing series of times.
   * `key` identifies the walker -- the clip id, so two clips cut from one file each
   * keep their own decoder instead of dragging a shared one back and forth.
   *
   * Going backwards, or forwards further than `CURSOR_RESYNC_SECONDS`, starts a new
   * walk, so a seek mid-playback costs what a seek always cost. The caller owns the
   * returned sample and must close it, exactly as with `getFrame`.
   */
  async sequentialFrame(key: string, assetId: AssetId, at: Time): Promise<VideoSample | null> {
    const handle = this.proxies.get(assetId) ?? await this.handleFor(assetId);
    if (!handle.videoTrack) return null;
    handle.videoSink ??= new VideoSampleSink(handle.videoTrack);

    const seconds = T.toSeconds(at);
    if (seconds < 0 || seconds > handle.durationSeconds) return null;

    let cursor = this.cursors.get(key);
    if (
      cursor &&
      (cursor.assetId !== assetId ||
        seconds < cursor.at ||
        seconds > cursor.at + CURSOR_RESYNC_SECONDS)
    ) {
      this.cursors.delete(key);
      void closeCursor(cursor);
      cursor = undefined;
    }

    if (!cursor) {
      cursor = {
        assetId,
        iterator: handle.videoSink.samples(seconds),
        current: null,
        lookahead: null,
        at: seconds,
        // Stamped before eviction runs, not after: a cursor created with the lowest
        // stamp in the map is the one eviction would throw away first, so at
        // capacity a new walk would close itself the moment it opened.
        used: ++this.cursorClock,
      };
      this.cursors.set(key, cursor);
      this.evictCursors();
    }
    cursor.at = seconds;
    cursor.used = ++this.cursorClock;

    // Draw the walk forward until the next sample is still in the future, which
    // makes `current` the latest frame at or before the time asked for.
    while (cursor.iterator) {
      if (!cursor.lookahead) {
        const next = await cursor.iterator.next();
        if (next.done) {
          cursor.iterator = null;
          break;
        }
        cursor.lookahead = next.value;
      }
      if (cursor.lookahead.timestamp > seconds + TIMESTAMP_EPSILON) break;

      cursor.current?.close();
      cursor.current = cursor.lookahead;
      cursor.lookahead = null;
    }

    // Cloned because the caller closes what it is given, and the cursor still needs
    // this frame: at 60 Hz over 30 fps material the same one is asked for twice.
    return cursor.current ? cursor.current.clone() : null;
  }

  /** Drop every sequential decoder -- playback has stopped, or the edit moved on. */
  releaseCursors(): void {
    for (const cursor of this.cursors.values()) void closeCursor(cursor);
    this.cursors.clear();
  }

  private evictCursors(): void {
    if (this.cursors.size <= MAX_CURSORS) return;
    const oldest = [...this.cursors.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, cursor] of oldest.slice(0, this.cursors.size - MAX_CURSORS)) {
      this.cursors.delete(key);
      void closeCursor(cursor);
    }
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
    this.closeProxy(assetId);
    const still = this.stills.get(assetId);
    if (still) {
      still.close();
      this.stills.delete(assetId);
    }
    const handle = this.handles.get(assetId);
    if (!handle) return;
    // The cursors walk this handle's sink, so they cannot outlive it.
    for (const [key, cursor] of this.cursors) {
      if (cursor.assetId !== assetId) continue;
      this.cursors.delete(key);
      void closeCursor(cursor);
    }
    void handle.input.dispose?.();
    this.handles.delete(assetId);
  }

  closeAll(): void {
    this.releaseCursors();
    for (const assetId of [...this.handles.keys()]) this.close(assetId);
    for (const assetId of [...this.proxies.keys()]) this.closeProxy(assetId);
    for (const bitmap of this.stills.values()) bitmap.close();
    this.stills.clear();
  }
}

/** End a walk and let go of its decoder. Never throws; there is nothing to retry. */
async function closeCursor(cursor: FrameCursor): Promise<void> {
  cursor.current?.close();
  cursor.lookahead?.close();
  cursor.current = null;
  cursor.lookahead = null;
  const iterator = cursor.iterator;
  cursor.iterator = null;
  try {
    await iterator?.return();
  } catch {
    // The walk is being abandoned either way.
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

/**
 * Snap a measured rate onto a standard one.
 *
 * The tolerance has to be tight: 29.97 and 30 differ by only 0.1 % (a factor of
 * 1.001), as do 23.976/24 and 59.94/60. A loose window would silently label every
 * 30 fps clip as 29.97 — so this picks the *closest* rate and only accepts it well
 * inside that gap.
 */
const SNAP_TOLERANCE = 0.0004;

function snapToBroadcastRate(fps: number): FrameRate {
  let best: FrameRate | null = null;
  let bestError = Infinity;

  for (const rate of COMMON_RATES) {
    const error = Math.abs(T.fpsToNumber(rate) - fps) / fps;
    if (error < bestError) {
      bestError = error;
      best = rate;
    }
  }

  if (best && bestError < SNAP_TOLERANCE) return best;
  const approx = T.fromSeconds(fps, 1000);
  return T.frameRate(approx.num, approx.den);
}
