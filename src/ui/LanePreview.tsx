/**
 * The picture and sound drawn behind the clips on one track.
 *
 * One canvas per lane, covering the visible width and nothing more. Previously each
 * clip carried a stack of CSS `background-image` layers, which meant every zoom
 * needed new images built, every scroll needed new tiles fetched, and any change to
 * a preview re-rendered the whole timeline to rebuild the style strings.
 *
 * Drawing it instead makes zoom and scroll a repaint. The canvas is sized to the
 * viewport in device pixels, so a waveform column is exactly one pixel however the
 * display is scaled — the fractional-offset blur that CSS backgrounds suffer from
 * cannot arise. React renders this element once per lane and never again for a
 * preview: the painter reads the layout from a ref and repaints on its own.
 */

import { useEffect, useRef } from 'react';
import { drawPeaks, type PreviewStore } from '../engine/previewStore';
import { heightTierFor, quantiseDensity } from '../engine/thumbnails';
import type { AssetId, ClipId } from '../model/types';

/** One clip's preview, in the lane's own pixel space. */
export interface LaneClip {
  readonly id: ClipId;
  readonly kind: 'video' | 'audio';
  readonly assetId: AssetId;
  /** Left edge in content pixels, and width, as the lane lays the clip out. */
  readonly x: number;
  readonly width: number;
  /** Source seconds at the clip's left edge, and how fast source time advances. */
  readonly sourceIn: number;
  readonly speed: number;
  /** Total source available, so a cell past the end is not asked for. */
  readonly sourceSeconds: number;
  /** Frame shape, so cells are the picture's aspect rather than a guess. */
  readonly frameAspect: number;
}

export interface LanePreviewProps {
  readonly clips: readonly LaneClip[];
  readonly previews: PreviewStore | null;
  readonly pxPerSecond: number;
  /** The element that scrolls horizontally, read for the visible window. */
  readonly scrollerRef: React.RefObject<HTMLElement | null>;
  readonly height: number;
}

/** Divider drawn down the right edge of each filmstrip cell. */
const CELL_DIVIDER = 'rgb(4 10 16 / 68%)';
const WAVEFORM_FILL = 'rgba(255, 255, 255, 0.72)';
/** Fallback if the stylesheet has not defined the bed yet. */
const DEFAULT_BED = '#11141b';

/**
 * The colour under a clip's preview, read from the stylesheet.
 *
 * Waveforms are white peaks on nothing, so they need something dark beneath them or
 * a light theme erases them. That used to be a background on the clip itself, but
 * the clip now sits *above* this canvas and an opaque one would hide it — so the bed
 * is painted here instead. Cached against the theme, since reading a computed style
 * forces the browser to resolve style and this runs on every scrolled frame.
 */
function bedColour(element: HTMLElement): string {
  const theme = document.documentElement.dataset.theme ?? '';
  if (theme !== bedTheme) {
    bedTheme = theme;
    bedCache = getComputedStyle(element).getPropertyValue('--clip-bed').trim() || DEFAULT_BED;
  }
  return bedCache;
}
let bedTheme: string | null = null;
let bedCache = DEFAULT_BED;

export function LanePreview({
  clips,
  previews,
  pxPerSecond,
  scrollerRef,
  height,
}: LanePreviewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read by the painter rather than closed over, so a layout change costs one
  // assignment instead of tearing down and rebuilding the repaint loop.
  const state = useRef({ clips, previews, pxPerSecond, height });
  state.current = { clips, previews, pxPerSecond, height };
  const repaintRef = useRef<((force: boolean) => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let frame: number | null = null;
    let disposed = false;
    let dirty = true;
    /** What the last paint was for, so a scroll that changed nothing costs nothing. */
    let painted = '';

    const paint = (): void => {
      frame = null;
      if (disposed) return;

      const { clips: laneClips, previews: store, pxPerSecond: scale, height: laneHeight } = state.current;
      const scrollX = scroller?.scrollLeft ?? 0;
      const viewWidth = Math.max(0, Math.ceil(scroller?.clientWidth ?? 0));
      const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

      const signature = `${scrollX}|${viewWidth}|${scale}|${laneHeight}|${ratio}|${laneClips.length}`;
      if (!dirty && signature === painted) return;
      dirty = false;
      painted = signature;

      const deviceWidth = Math.max(1, Math.round(viewWidth * ratio));
      const deviceHeight = Math.max(1, Math.round(laneHeight * ratio));
      if (canvas.width !== deviceWidth) canvas.width = deviceWidth;
      if (canvas.height !== deviceHeight) canvas.height = deviceHeight;
      canvas.style.width = `${viewWidth}px`;
      canvas.style.height = `${laneHeight}px`;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, deviceWidth, deviceHeight);
      if (!store || viewWidth <= 0) return;
      const bed = bedColour(canvas);

      for (const clip of laneClips) {
        // Everything below is in device pixels relative to the canvas's left edge,
        // which is the viewport's left edge.
        const left = (clip.x - scrollX) * ratio;
        const right = left + clip.width * ratio;
        if (right <= 0 || left >= deviceWidth) continue;

        const from = Math.max(0, left);
        const to = Math.min(deviceWidth, right);
        ctx.save();
        ctx.beginPath();
        ctx.rect(from, 0, to - from, deviceHeight);
        ctx.clip();
        ctx.fillStyle = bed;
        ctx.fillRect(from, 0, to - from, deviceHeight);
        if (clip.kind === 'audio') drawWaveform(ctx, store, clip, left, right, deviceWidth, deviceHeight, ratio, scale);
        else drawFilmstrip(ctx, store, clip, left, right, deviceWidth, deviceHeight, ratio, scale);
        ctx.restore();
      }
    };

    const schedule = (force: boolean): void => {
      if (force) dirty = true;
      if (frame !== null || disposed) return;
      frame = requestAnimationFrame(paint);
    };

    // A scroll changes what is visible without changing a single React prop, so the
    // painter listens for it directly rather than being told. Only the scroller is
    // observed for resize: the canvas's own size is set inside `paint`, so watching
    // it would make every paint schedule the next one.
    const onScroll = (): void => schedule(false);
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => schedule(true));
    if (scroller) observer.observe(scroller);
    schedule(true);

    repaintRef.current = schedule;

    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      scroller?.removeEventListener('scroll', onScroll);
      observer.disconnect();
      repaintRef.current = null;
    };
  }, [scrollerRef]);

  // Props changed — new clips, a new zoom, a taller lane, a preview that landed.
  // Always forced: the signature cannot see decoded frames arriving.
  useEffect(() => {
    repaintRef.current?.(true);
  });

  return <canvas ref={canvasRef} className="lane-preview" aria-hidden />;
}

/**
 * Fill a clip's box with the frames under it.
 *
 * Cells are laid out in source time and mapped through the clip's speed, so a
 * retimed clip shows the frames it actually plays. Missing cells fall back to the
 * nearest decoded frame at any density, which keeps a zoom from flashing empty
 * while the exact thumbnails decode.
 */
function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  store: PreviewStore,
  clip: LaneClip,
  left: number,
  right: number,
  deviceWidth: number,
  deviceHeight: number,
  ratio: number,
  pxPerSecond: number,
): void {
  const cellWidth = Math.max(8, deviceHeight * clip.frameAspect);
  const sourcePerDevicePixel = clip.speed / (pxPerSecond * ratio);
  const density = quantiseDensity(1 / (cellWidth * sourcePerDevicePixel));
  const tier = heightTierFor(deviceHeight);

  const firstDevice = Math.max(0, Math.floor(left));
  const lastDevice = Math.min(deviceWidth, Math.ceil(right));

  // Cells are anchored to source time, not to the clip, so trimming a clip slides
  // the picture inside it instead of resampling the whole strip.
  const sourceAt = (device: number): number => clip.sourceIn + (device - left) * sourcePerDevicePixel;
  const firstIndex = Math.floor(sourceAt(firstDevice) * density);
  const lastIndex = Math.floor(sourceAt(lastDevice) * density);

  const wanted: number[] = [];
  const maxIndex = Math.max(0, Math.ceil(clip.sourceSeconds * density) - 1);
  for (let index = Math.max(0, firstIndex); index <= Math.min(maxIndex, lastIndex); index++) {
    wanted.push(index);
  }
  if (wanted.length > 0) {
    store.thumbnails.request(clip.assetId, clip.sourceSeconds, density, tier, wanted);
  }

  for (const index of wanted) {
    const cellSourceStart = index / density;
    const x = left + (cellSourceStart - clip.sourceIn) / sourcePerDevicePixel;
    const width = 1 / density / sourcePerDevicePixel;

    const bitmap =
      store.thumbnails.get({ assetId: clip.assetId, density, heightTier: tier, index }) ??
      store.thumbnails.nearest(clip.assetId, tier, cellSourceStart);
    if (bitmap) {
      // Drawn at the cell's own aspect and cropped to the cell, so a frame is never
      // stretched to fit a cell the zoom made a different shape.
      const scale = deviceHeight / bitmap.height;
      const drawWidth = bitmap.width * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, width, deviceHeight);
      ctx.clip();
      ctx.drawImage(bitmap, x, 0, drawWidth, deviceHeight);
      ctx.restore();
    }

    // One device pixel whatever the zoom, unlike a divider baked into a strip, which
    // grew into a dark slash as the strip was enlarged.
    ctx.fillStyle = CELL_DIVIDER;
    ctx.fillRect(x + width - 1, 0, 1, deviceHeight);
  }
}

/** Fill a clip's box with its peaks, one column per device pixel. */
function drawWaveform(
  ctx: CanvasRenderingContext2D,
  store: PreviewStore,
  clip: LaneClip,
  left: number,
  right: number,
  deviceWidth: number,
  deviceHeight: number,
  ratio: number,
  pxPerSecond: number,
): void {
  const peaks = store.getPeaks(clip.assetId);
  if (!peaks) return;

  const from = Math.max(0, Math.floor(left));
  const to = Math.min(deviceWidth, Math.ceil(right));
  const columns = to - from;
  if (columns <= 0) return;

  const sourcePerDevicePixel = clip.speed / (pxPerSecond * ratio);
  const sourceStart = clip.sourceIn + (from - left) * sourcePerDevicePixel;

  ctx.fillStyle = WAVEFORM_FILL;
  drawPeaks(ctx, peaks, sourceStart, columns * sourcePerDevicePixel, columns, deviceHeight, from);
}
