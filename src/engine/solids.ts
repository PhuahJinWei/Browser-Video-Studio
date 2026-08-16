/**
 * Fill-colour rendering.
 *
 * A solid is drawn to a 2D canvas at sequence resolution and handed to the
 * compositor like any other layer image, so it picks up transforms, opacity,
 * blending and effects for free.
 *
 * Full resolution looks wasteful for a uniform colour, but the compositor uses a
 * layer's `imageSize` as the copy extent *and* as the quad's size in output pixels:
 * a small texture would be a small rectangle, not a stretched fill. Caching by
 * colour and size keeps it to one allocation per distinct solid.
 */

import type { Size } from '../model/types';

interface CacheEntry {
  readonly canvas: OffscreenCanvas;
  readonly size: Size;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 8;

/** Rasterise a fill at sequence resolution. The returned canvas is owned by the cache. */
export function renderSolid(fill: string, sequenceSize: Size): { image: OffscreenCanvas; size: Size } {
  const key = `${fill} ${sequenceSize.width}x${sequenceSize.height}`;
  const hit = cache.get(key);
  if (hit) return { image: hit.canvas, size: hit.size };

  const size: Size = {
    width: Math.max(1, Math.round(sequenceSize.width)),
    height: Math.max(1, Math.round(sequenceSize.height)),
  };
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context for a fill layer');

  // An unparsable colour leaves the canvas transparent rather than throwing, which
  // would take the whole frame down over a typo in the colour field.
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, size.width, size.height);

  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { canvas, size });
  return { image: canvas, size };
}
