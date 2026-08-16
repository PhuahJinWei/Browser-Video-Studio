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
import { renderSolid } from './solids';
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

/** How often the transport clock is sampled during playback. */
const CLOCK_INTERVAL_MS = 25;

export class Engine {
  private compositor: Compositor | null = null;
  private attachedCanvas: HTMLCanvasElement | null = null;
  private attaching: Promise<void> | null = null;
  private player: AudioPlayer | null = null;
  private rafHandle: number | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private playbackPosition: Time = T.TIME_ZERO;
  /** Timeline position playback is measured from, and the wall clock at that point. */
  private playOrigin: Time = T.TIME_ZERO;
  private playOriginWall = 0;
  private playUntil: Time = T.TIME_ZERO;
  private rendering = false;
  private pendingSeek: Time | null = null;
  private lastRenderedAt: Time | null = null;
  /** Most recent time asked for, whether or not that render has finished yet. */
  private lastRequestedAt: Time | null = null;

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

  /**
   * Attach a canvas. Safe to call again after the sequence size changes.
   *
   * Concurrent calls share one creation. Without this, two overlapping calls each
   * see no compositor and each build a `GPUDevice`; the canvas ends up configured
   * with one device while rendering submits on the other, and every frame silently
   * fails validation. React StrictMode double-invokes effects in development, so
   * this is the normal path, not an edge case.
   */
  async attachCanvas(canvas: HTMLCanvasElement, size: Size): Promise<void> {
    if (this.compositor && this.attachedCanvas === canvas) {
      this.compositor.resize(size);
      return;
    }
    if (this.attaching) return this.attaching;

    this.attaching = (async () => {
      // A different canvas means the old device's swap chain is gone.
      if (this.compositor) {
        this.compositor.destroy();
        this.compositor = null;
      }
      canvas.width = size.width;
      canvas.height = size.height;
      this.compositor = await Compositor.create(canvas, size);
      this.attachedCanvas = canvas;
    })();

    try {
      await this.attaching;
    } finally {
      this.attaching = null;
    }
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

      if (layer.clip.kind === 'solid') {
        const { image, size } = renderSolid(layer.clip.fill, sequence.size);
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

      // Stills are decoded once and drawn directly; there is nothing to seek.
      if (layer.clip.kind === 'image') {
        const still = this.media.getStill(layer.clip.assetId);
        if (!still) continue;
        layers.push({
          image: still,
          imageSize: { width: still.width, height: still.height },
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
    this.lastRequestedAt = at;
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
   * Begin playback from `from`. `onPosition` reports the position derived from the
   * audio clock — the caller moves the playhead.
   *
   * The clock and the renderer are deliberately separate. `requestAnimationFrame`
   * stops firing whenever the page is not compositing (background tab, hidden
   * window), but audio keeps playing, so driving the position from rAF would let the
   * playhead freeze while the sound ran on — real desync on return. A timer owns the
   * position; rAF only decides when to draw.
   */
  async play(from: Time, onPosition: (at: Time) => void, until: Time): Promise<void> {
    if (this.telemetry.playing) return;

    this.player ??= new AudioPlayer(this.media, this.getProject, this.sequenceId);
    this.telemetry.playing = true;
    this.playUntil = until;
    this.playbackPosition = from;
    this.playOrigin = from;
    this.playOriginWall = performance.now();
    await this.player.start(from);

    const advance = (): void => {
      if (!this.telemetry.playing || !this.player) return;

      // The audio clock is authoritative; wall time covers a silent or blocked
      // AudioContext (autoplay policy) so the picture still runs at the right rate.
      const audioTime = this.player.currentTime();
      const wallElapsed = (performance.now() - this.playOriginWall) / 1000;
      const fallback = T.add(this.playOrigin, T.fromSeconds(wallElapsed, 1_000_000));
      const position = T.gt(audioTime, this.playOrigin) ? audioTime : fallback;

      if (T.gte(position, this.playUntil)) {
        this.playbackPosition = this.playUntil;
        onPosition(this.playUntil);
        void this.pause();
        return;
      }

      this.playbackPosition = position;
      onPosition(position);
    };

    const draw = (): void => {
      if (!this.telemetry.playing) return;
      this.requestRender(this.playbackPosition);
      this.rafHandle = requestAnimationFrame(draw);
    };

    this.clockTimer = setInterval(advance, CLOCK_INTERVAL_MS);
    this.rafHandle = requestAnimationFrame(draw);
    this.emitTelemetry();
  }

  /**
   * Move the play head, during playback as well as when stopped.
   *
   * Seeking mid-playback has to re-base the transport and restart the audio from
   * the new position; otherwise the clock keeps counting from where playback began
   * and immediately drags the picture back to where it was.
   */
  async seek(at: Time): Promise<void> {
    this.playbackPosition = at;

    if (this.telemetry.playing && this.player) {
      this.playOrigin = at;
      this.playOriginWall = performance.now();
      await this.player.start(at);
    }
    this.requestRender(at);
  }

  async pause(): Promise<void> {
    this.telemetry.playing = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.clockTimer !== null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    await this.player?.stop();
    // Land on the exact position the transport stopped at.
    this.requestRender(this.playbackPosition);
    this.emitTelemetry();
  }

  /**
   * Re-render the current position, e.g. after an edit.
   *
   * Uses the last *requested* time rather than the last completed one: an edit made
   * while a render is still in flight would otherwise re-render a stale position, or
   * nothing at all before the first frame has ever finished.
   */
  refresh(): void {
    const at = this.lastRequestedAt ?? this.lastRenderedAt;
    if (at) this.requestRender(at);
  }

  async openAsset(assetId: AssetId, blob: Blob): Promise<void> {
    if (blob.type.startsWith('image/')) await this.media.openImage(assetId, blob);
    else await this.media.open(assetId, blob);
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
