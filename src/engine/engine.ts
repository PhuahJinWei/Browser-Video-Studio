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
import type { AssetId, AssetKind, ClipId, Project, SequenceId, Size, Time } from '../model/types';
import { AudioPlayer } from './audio';
import { Compositor, type DrawLayer } from './compositor';
import { foldEffects, NEUTRAL_EFFECTS } from './effects';
import { MediaLibrary } from './media';
import { renderSolid } from './solids';
import type { Rect } from './layerGeometry';
import { renderTitle } from './titles';

/** How big a clip's picture turned out to be, and which part of it is the subject. */
export interface LayerBounds {
  readonly imageSize: Size;
  /**
   * The part worth pointing at, in image pixels, when that is not the whole image.
   *
   * Set for titles, whose picture is the size of the frame with the words somewhere
   * inside it. Absent means the image is its own subject.
   */
  readonly contentRect?: Rect;
}

export type LayerBoundsMap = ReadonlyMap<ClipId, LayerBounds>;

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
  private layerBounds: LayerBoundsMap = new Map();
  private attachedCanvas: HTMLCanvasElement | null = null;
  private attaching: Promise<void> | null = null;
  private player: AudioPlayer | null = null;
  /** Output-only listening gain; deliberately downstream of the project mix. */
  private monitorGain = 1;
  private rafHandle: number | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private playbackPosition: Time = T.TIME_ZERO;
  /** Timeline position playback is measured from, and the wall clock at that point. */
  private playOrigin: Time = T.TIME_ZERO;
  private playOriginWall = 0;
  private playUntil: Time = T.TIME_ZERO;
  private rendering = false;
  /** The render loop currently draining, so a still can wait for it rather than race it. */
  private draining: Promise<void> | null = null;
  private pendingSeek: Time | null = null;
  private lastRenderedAt: Time | null = null;
  /** Most recent time asked for, whether or not that render has finished yet. */
  private lastRequestedAt: Time | null = null;
  /** Last position handed to the transport, so identical ones cost nothing. */
  private lastReported: Time | null = null;
  /** Registered once, to resume the audio device on the first gesture. */
  private audioArmed = false;

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
    // Start the audio device opening alongside the GPU one. Both are slow, neither
    // waits on the other, and this is the last moment before the user can press Play.
    this.warmUpAudio();

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

  /**
   * Follow a change of sequence resolution.
   *
   * The canvas element resizes on its own — it is bound to the sequence in the
   * preview's markup — but the compositor's render targets are allocated once at the
   * size it was created with. Without this they stay at the old resolution and the
   * blit stretches whatever was last composited across the new canvas.
   */
  setSize(size: Size): void {
    const compositor = this.compositor;
    if (!compositor) return;
    if (this.attachedCanvas) {
      this.attachedCanvas.width = size.width;
      this.attachedCanvas.height = size.height;
    }
    compositor.resize(size);
    this.requestRender(this.lastRequestedAt ?? this.playbackPosition);
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
  async collectLayers(
    at: Time,
    /**
     * True when `at` is stepping forward frame by frame, as playback does, so the
     * decoders can walk with it instead of seeking from a keyframe every time.
     */
    sequential = false,
  ): Promise<{ layers: DrawLayer[]; owned: VideoFrame[]; bounds: Map<ClipId, LayerBounds> }> {
    const project = this.getProject();
    const sequence = project.sequences[this.sequenceId];
    if (!sequence) return { layers: [], owned: [], bounds: new Map() };

    const renderLayers = renderListAt(project, this.sequenceId, at);
    const layers: DrawLayer[] = [];
    const owned: VideoFrame[] = [];
    /*
     * Recorded as the layers are built, because this is the only place that knows
     * how big a clip's picture turned out to be — a decoded frame's real dimensions,
     * a still's, a title's rasterised frame. Working it out a second time somewhere
     * else is how a selection box comes to sit somewhere the picture is not.
     */
    const bounds = new Map<ClipId, LayerBounds>();

    for (const layer of renderLayers) {
      const relative = T.sub(at, layer.clip.start);
      const effects = foldEffects(
        [...layer.effects, ...layer.trackEffects],
        relative,
        NEUTRAL_EFFECTS,
      );

      if (layer.clip.kind === 'title') {
        const { image, size, textRect } = renderTitle(layer.clip, sequence.size);
        bounds.set(layer.clip.id, { imageSize: size, contentRect: textRect });
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
        const { image, size } = renderSolid(layer.clip.fill, sequence.size);
        bounds.set(layer.clip.id, { imageSize: size });
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

      // Stills are decoded once and drawn directly; there is nothing to seek.
      if (layer.clip.kind === 'image') {
        const still = this.media.getStill(layer.clip.assetId);
        if (!still) continue;
        bounds.set(layer.clip.id, { imageSize: { width: still.width, height: still.height } });
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
      const sample = await (sequential
        ? this.media.sequentialFrame(layer.clip.id, layer.clip.assetId, layer.sourceTime)
        : this.media.getFrame(layer.clip.assetId, layer.sourceTime)
      ).catch(() => null);
      if (!sample) continue;

      const frame = sample.toVideoFrame();
      sample.close();
      owned.push(frame);

      bounds.set(layer.clip.id, {
        imageSize: { width: frame.displayWidth, height: frame.displayHeight },
      });
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

    return { layers, owned, bounds };
  }

  /** Decode, composite and present the frame at `at`. */
  async renderAt(at: Time): Promise<void> {
    const compositor = this.compositor;
    if (!compositor) return;

    const started = performance.now();
    const { layers, owned, bounds } = await this.collectLayers(at, this.telemetry.playing);
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
    this.layerBounds = bounds;
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
    this.draining = this.drainRenderQueue();
  }

  /**
   * A still of the composited frame at `at`, at full sequence resolution.
   *
   * Read back from the compositor's own render target, never from the canvas. A
   * WebGPU canvas gives no guarantee that its drawing buffer survives presentation,
   * so `canvas.toBlob` on it returns a blank or a stale frame often enough to be
   * useless — while the render target is exactly what export already reads.
   *
   * The target holds straight (non-premultiplied) RGBA and is cleared transparent,
   * whereas the canvas is presented over black. The readback is therefore composited
   * onto black here, so a screenshot matches what the preview shows rather than
   * coming out see-through wherever nothing was stacked.
   */
  async grabStill(at: Time, type = 'image/png', quality?: number): Promise<Blob> {
    const compositor = this.compositor;
    if (!compositor) throw new Error('No canvas is attached, so there is nothing to grab');

    const sequence = this.getProject().sequences[this.sequenceId];
    if (!sequence) throw new Error('No active sequence to grab a frame from');
    const { width, height } = sequence.size;

    // Let any preview frame already in flight finish, then hold the render queue:
    // a playback frame landing mid-grab would swap the ping-pong targets and the
    // readback would return someone else's composite.
    await this.draining?.catch(() => undefined);
    this.rendering = true;
    let pixels: Uint8ClampedArray<ArrayBuffer>;
    try {
      await this.renderAt(at);
      pixels = await compositor.readPixels();
    } finally {
      this.rendering = false;
    }
    // Anything that asked for a frame while we held the queue still wants one.
    if (this.pendingSeek !== null) this.draining = this.drainRenderQueue();

    const source = new OffscreenCanvas(width, height);
    const sourceCtx = source.getContext('2d');
    if (!sourceCtx) throw new Error('Could not get a 2D context to read the frame into');
    sourceCtx.putImageData(new ImageData(pixels, width, height), 0, 0);

    // `putImageData` replaces the destination alpha rather than blending into it,
    // so the black has to go underneath a *drawn* copy, not behind a put one.
    const out = new OffscreenCanvas(width, height);
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Could not get a 2D context to compose the still');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0);

    return out.convertToBlob({ type, ...(quality !== undefined ? { quality } : {}) });
  }

  /** Capture an unedited source frame for the asset currently open in the source monitor. */
  async grabAssetStill(assetId: AssetId, at: Time, type = 'image/png', quality?: number): Promise<Blob> {
    const asset = this.getProject().assets[assetId];
    if (!asset?.video) throw new Error('That source has no picture to capture');

    let image: CanvasImageSource;
    let owned: VideoFrame | null = null;
    if (asset.kind === 'image') {
      const still = this.media.getStill(assetId);
      if (!still) throw new Error('That still is not available');
      image = still;
    } else {
      const sample = await this.media.getFrame(assetId, at);
      if (!sample) throw new Error('No source frame exists at this position');
      owned = sample.toVideoFrame();
      sample.close();
      image = owned;
    }

    const width = asset.image?.size.width ?? asset.video.size.width;
    const height = asset.image?.size.height ?? asset.video.size.height;
    const out = new OffscreenCanvas(width, height);
    const ctx = out.getContext('2d');
    if (!ctx) {
      owned?.close();
      throw new Error('Could not prepare the captured frame');
    }
    try {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      return await out.convertToBlob({ type, ...(quality !== undefined ? { quality } : {}) });
    } finally {
      owned?.close();
    }
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
   * Open the audio output device now, rather than on the first press of Play.
   *
   * Both halves of the cost land on whoever asks first: the constructor blocks the
   * main thread acquiring the device, and the clock then stays at zero for a good
   * while after. Spending that at load, when nothing is waiting on it, is the whole
   * of the fix -- there is no way to make the device open faster, only to open it
   * somewhere the delay does not show.
   */
  warmUpAudio(): void {
    this.player ??= new AudioPlayer(this.media, this.getProject, this.sequenceId);
    this.player.setMonitorGain(this.monitorGain);
    void this.player.warmUp();

    // Autoplay policy holds a context created before any gesture suspended, and its
    // clock with it, so the first gesture anywhere is the earliest this can succeed.
    if (this.audioArmed) return;
    this.audioArmed = true;
    const resume = (): void => void this.player?.warmUp();
    window.addEventListener('pointerdown', resume, { once: true, capture: true });
    window.addEventListener('keydown', resume, { once: true, capture: true });
  }

  /**
   * Where the transport is now.
   *
   * The audio clock leads whenever it is running. While the device is still opening
   * the transport deliberately stands still: running the picture on wall time and
   * then handing over to an audio clock that starts from zero is what used to drag
   * the play head backwards a second into every first play.
   */
  private positionNow(): Time {
    const player = this.player;
    if (!player) return this.playbackPosition;

    const clock = player.clockState();
    if (clock === 'live') return player.currentTime();
    if (clock === 'pending') {
      // Keep the fallback anchored to now, so if the device turns out to be blocked
      // rather than slow the picture starts from here instead of leaping to wherever
      // wall time had wandered while it waited.
      this.playOriginWall = performance.now();
      return this.playOrigin;
    }
    const wallElapsed = (performance.now() - this.playOriginWall) / 1000;
    return T.add(this.playOrigin, T.fromSeconds(wallElapsed, 1_000_000));
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
    this.player.setMonitorGain(this.monitorGain);
    this.telemetry.playing = true;
    this.playUntil = until;
    this.playbackPosition = from;
    this.playOrigin = from;
    this.playOriginWall = performance.now();
    this.lastReported = from;
    await this.player.start(from);

    const advance = (): void => {
      if (!this.telemetry.playing || !this.player) return;
      const position = this.positionNow();

      if (T.gte(position, this.playUntil)) {
        this.playbackPosition = this.playUntil;
        onPosition(this.playUntil);
        void this.pause();
        return;
      }

      this.playbackPosition = position;
      // Reporting the same position again still writes the document and re-renders
      // the whole timeline, and the clock stands still on purpose while the audio
      // device opens -- which is exactly when the transport can least afford it.
      if (this.lastReported === null || !T.eq(position, this.lastReported)) {
        this.lastReported = position;
        onPosition(position);
      }
    };

    const draw = (): void => {
      if (!this.telemetry.playing) return;
      // Read the clock here rather than reusing the timer's copy: sampled every
      // CLOCK_INTERVAL_MS, that value is up to a whole tick stale by the time a
      // frame is drawn, and frames landing on a coarser grid than they are shown at
      // is judder whatever the decoder does.
      const at = this.positionNow();
      this.playbackPosition = at;
      if (this.lastRequestedAt === null || !T.eq(at, this.lastRequestedAt)) {
        this.requestRender(at);
      }
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
    this.lastReported = at;

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
    // Sequential decoders are only worth their open decoder while something is
    // walking them; what comes next is scrubbing, which wants random access.
    this.media.releaseCursors();
    // Land on the exact position the transport stopped at.
    this.requestRender(this.playbackPosition);
    this.emitTelemetry();
  }

  /**
   * How big each clip's picture was in the frame most recently rendered.
   *
   * Only the parts a caller cannot work out for itself: the transform is document
   * state and is better read live, so a box drawn round a layer follows a drag
   * immediately rather than a rendered frame behind it.
   */
  lastLayerBounds(): LayerBoundsMap {
    return this.layerBounds;
  }

  /**
   * Show or hide the transparency grid on the program monitor.
   *
   * Kept on the compositor rather than in the render path, because it changes only
   * how the finished composite is presented — the frame itself, and everything the
   * exporter reads, is identical either way. Re-presenting is therefore enough; a
   * full re-render would decode frames again to no purpose.
   */
  setTransparencyGrid(on: boolean): void {
    this.compositor?.setTransparencyGrid(on);
    this.compositor?.present();
  }

  /** Change only what the local monitor hears, never the document or export mix. */
  setMonitorGain(gain: number): void {
    this.monitorGain = Math.max(0, Math.min(1, gain));
    this.player?.setMonitorGain(this.monitorGain);
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

  /**
   * Hand the bytes for an asset to the decoder that suits it.
   *
   * The kind comes from the document, never from `blob.type`. Media cached in OPFS
   * is keyed by asset id with no file extension, so a still read back off disk
   * arrives with an empty type and would be sent to the demuxer — which rejects it,
   * taking the rest of the reopen down with it. The document has always known what
   * each asset is; this asks it.
   */
  async openAsset(assetId: AssetId, blob: Blob, kind: AssetKind): Promise<void> {
    if (kind === 'image') await this.media.openImage(assetId, blob);
    else await this.media.open(assetId, blob);
  }

  async openProxy(assetId: AssetId, blob: Blob): Promise<void> {
    await this.media.openProxy(assetId, blob);
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
