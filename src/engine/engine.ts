/**
 * Engine facade.
 *
 * Turns `(document, time)` into pixels and sound. The UI never touches media,
 * decoders or the GPU directly — it edits the document and asks the engine for
 * frames. Playback and export both go through `composeFrameAt`, so the preview and
 * the exported file cannot drift apart.
 */

import { renderListAt } from '../model/selectors';
import * as T from '../model/time';
import type { AssetId, Project, SequenceId, Size, Time } from '../model/types';
import { AudioPlayer } from './audio';
import { Compositor, type DrawLayer } from './compositor';
import { foldEffects, NEUTRAL_EFFECTS } from './effects';
import { MediaLibrary } from './media';
import { renderTitle } from './titles';

export interface EngineTelemetry {
  /** Frames actually presented in the last second. */
  fps: number;
  /** Frames the render loop skipped because the previous one was still in flight. */
  droppedFrames: number;
  /** Wall-clock milliseconds the last frame took to decode + composite. */
  lastFrameMs: number;
  decodeMs: number;
  compositeMs: number;
  layerCount: number;
  playing: boolean;
}

export type TelemetryListener = (telemetry: Readonly<EngineTelemetry>) => void;

export class Engine {
  private compositor: Compositor | null = null;
  private player: AudioPlayer | null = null;
  private rafHandle: number | null = null;
  private rendering = false;
  private pendingSeek: Time | null = null;
  private lastRenderedAt: Time | null = null;

  private readonly telemetry: EngineTelemetry = {
    fps: 0,
    droppedFrames: 0,
    lastFrameMs: 0,
    decodeMs: 0,
    compositeMs: 0,
    layerCount: 0,
    playing: false,
  };
  private readonly telemetryListeners = new Set<TelemetryListener>();
  private frameTimestamps: number[] = [];

  readonly media = new MediaLibrary();

  private constructor(
    private getProject: () => Project,
    private sequenceId: SequenceId,
  ) {}

  static create(getProject: () => Project, sequenceId: SequenceId): Engine {
    return new Engine(getProject, sequenceId);
  }

  /** Attach a canvas. Safe to call again after the sequence size changes. */
  async attachCanvas(canvas: HTMLCanvasElement, size: Size): Promise<void> {
    if (this.compositor) {
      this.compositor.resize(size);
      return;
    }
    canvas.width = size.width;
    canvas.height = size.height;
    this.compositor = await Compositor.create(canvas, size);
  }

  get hasCanvas(): boolean {
    return this.compositor !== null;
  }

  setSequence(sequenceId: SequenceId): void {
    this.sequenceId = sequenceId;
  }

  onTelemetry(listener: TelemetryListener): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }

  private emitTelemetry(): void {
    for (const listener of this.telemetryListeners) listener(this.telemetry);
  }

  // -------------------------------------------------------------------------
  // Frame composition
  // -------------------------------------------------------------------------

  /**
   * Gather every layer visible at `at`, decoding the frames they need.
   * The returned `VideoFrame`s are owned by the caller and must be closed.
   */
  async collectLayers(at: Time): Promise<{ layers: DrawLayer[]; owned: VideoFrame[] }> {
    const project = this.getProject();
    const sequence = project.sequences[this.sequenceId];
    if (!sequence) return { layers: [], owned: [] };

    const renderLayers = renderListAt(project, this.sequenceId, at);
    const layers: DrawLayer[] = [];
    const owned: VideoFrame[] = [];

    for (const layer of renderLayers) {
      const relative = T.sub(at, layer.clip.start);
      const effects = foldEffects(
        [...layer.effects, ...layer.trackEffects],
        relative,
        NEUTRAL_EFFECTS,
      );

      if (layer.clip.kind === 'title') {
        const { image, size } = renderTitle(layer.clip, sequence.size);
        layers.push({
          image,
          imageSize: size,
          transform: layer.transform,
          opacity: layer.opacity,
          crop: layer.crop,
          blendMode: layer.blendMode,
          effects,
        });
        continue;
      }

      if (!layer.sourceTime) continue;
      const sample = await this.media.getFrame(layer.clip.assetId, layer.sourceTime).catch(() => null);
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
        effects,
      });
    }

    return { layers, owned };
  }

  /** Decode, composite and present the frame at `at`. */
  async renderAt(at: Time): Promise<void> {
    const compositor = this.compositor;
    if (!compositor) return;

    const started = performance.now();
    const { layers, owned } = await this.collectLayers(at);
    const decoded = performance.now();

    try {
      compositor.renderToCanvas(layers);
    } finally {
      for (const frame of owned) frame.close();
    }

    const finished = performance.now();
    this.telemetry.decodeMs = decoded - started;
    this.telemetry.compositeMs = finished - decoded;
    this.telemetry.lastFrameMs = finished - started;
    this.telemetry.layerCount = layers.length;
    this.lastRenderedAt = at;

    this.frameTimestamps.push(finished);
    const cutoff = finished - 1000;
    while (this.frameTimestamps.length > 0 && this.frameTimestamps[0]! < cutoff) {
      this.frameTimestamps.shift();
    }
    this.telemetry.fps = this.frameTimestamps.length;
    this.emitTelemetry();
  }

  /**
   * Render at `at`, coalescing requests: while one frame is in flight the newest
   * pending time replaces any older one. Scrubbing therefore always converges on the
   * position the pointer is actually at instead of queueing every intermediate frame.
   */
  requestRender(at: Time): void {
    this.pendingSeek = at;
    if (this.rendering) {
      this.telemetry.droppedFrames++;
      return;
    }
    void this.drainRenderQueue();
  }

  private async drainRenderQueue(): Promise<void> {
    this.rendering = true;
    try {
      while (this.pendingSeek !== null) {
        const target = this.pendingSeek;
        this.pendingSeek = null;
        await this.renderAt(target);
      }
    } finally {
      this.rendering = false;
    }
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  get isPlaying(): boolean {
    return this.telemetry.playing;
  }

  /**
   * Begin playback from `from`. `onPosition` is called once per animation frame with
   * the position derived from the audio clock — the caller moves the playhead.
   */
  async play(from: Time, onPosition: (at: Time) => void, until: Time): Promise<void> {
    if (this.telemetry.playing) return;

    this.player ??= new AudioPlayer(this.media, this.getProject, this.sequenceId);
    this.telemetry.playing = true;
    await this.player.start(from);

    const startedWall = performance.now();

    const tick = (): void => {
      if (!this.telemetry.playing || !this.player) return;

      // The audio clock is authoritative; fall back to wall time if audio is silent.
      const audioTime = this.player.currentTime();
      const wallElapsed = (performance.now() - startedWall) / 1000;
      const fallback = T.add(from, T.fromSeconds(wallElapsed, 1_000_000));
      const position = T.gt(audioTime, from) ? audioTime : fallback;

      if (T.gte(position, until)) {
        void this.pause();
        onPosition(until);
        return;
      }

      onPosition(position);
      this.requestRender(position);
      this.rafHandle = requestAnimationFrame(tick);
    };

    this.rafHandle = requestAnimationFrame(tick);
    this.emitTelemetry();
  }

  async pause(): Promise<void> {
    this.telemetry.playing = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    await this.player?.stop();
    this.emitTelemetry();
  }

  /** Re-render the current position, e.g. after an edit. */
  refresh(): void {
    if (this.lastRenderedAt) this.requestRender(this.lastRenderedAt);
  }

  async openAsset(assetId: AssetId, blob: Blob): Promise<void> {
    await this.media.open(assetId, blob);
  }

  async destroy(): Promise<void> {
    await this.pause();
    await this.player?.close();
    this.player = null;
    this.media.closeAll();
    this.compositor?.destroy();
    this.compositor = null;
  }
}
