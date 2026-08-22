/**
 * Where a layer lands inside the frame.
 *
 * The compositor draws layers by giving the shader the *inverse* of their transform:
 * every output pixel is mapped back into the layer's own space, so rotation and
 * scaling need no geometry, just a matrix. That is the right thing for drawing and
 * the wrong thing for anything that needs to know where a layer actually is — the
 * on-screen bounding box of a title being dragged, say.
 *
 * Both directions are derived from the same placement here, so the box the interface
 * draws and the pixels the compositor draws cannot drift apart. Everything is in
 * frame pixels with the origin at the frame's top-left, which is the space the
 * document's transforms are already expressed in.
 */

import type { Size, Transform2D } from '../model/types';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Clockwise from the region's top-left, in frame pixels. */
export type Corners = readonly [Point, Point, Point, Point];

/**
 * A layer's transform, resolved against a frame and an image size.
 *
 * Pulled out because the composite shader's matrix and the corners below are two
 * views of these same eight numbers, and computing them twice is how the two would
 * come to disagree.
 */
export interface LayerPlacement {
  /** The image's size after scaling, in frame pixels. */
  readonly width: number;
  readonly height: number;
  /** Where the anchor sits in the frame. */
  readonly centreX: number;
  readonly centreY: number;
  /** The anchor's offset inside the scaled image. */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly cos: number;
  readonly sin: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export function layerPlacement(
  transform: Transform2D,
  frameSize: Size,
  imageSize: Size,
): LayerPlacement {
  const width = imageSize.width * transform.scaleX;
  const height = imageSize.height * transform.scaleY;
  const radians = (transform.rotation * Math.PI) / 180;
  return {
    width,
    height,
    // The layer is anchored inside the frame, offset from its centre by (x, y).
    centreX: frameSize.width / 2 + transform.x,
    centreY: frameSize.height / 2 + transform.y,
    anchorX: transform.anchorX * width,
    anchorY: transform.anchorY * height,
    cos: Math.cos(radians),
    sin: Math.sin(radians),
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
  };
}

/** One point of the layer image, in frame pixels. `ix`/`iy` are in image pixels. */
function project(p: LayerPlacement, ix: number, iy: number): Point {
  // Into the anchored, scaled space the rotation turns about...
  const lx = ix * p.scaleX - p.anchorX;
  const ly = iy * p.scaleY - p.anchorY;
  // ...then rotate and place. This is the forward of the shader's inverse matrix.
  return {
    x: p.centreX + lx * p.cos - ly * p.sin,
    y: p.centreY + lx * p.sin + ly * p.cos,
  };
}

/**
 * The four corners of a layer, or of a region within it, in frame pixels.
 *
 * `region` exists for titles. A title is rasterised at the full size of the frame
 * with its text somewhere in the middle, so the image's own corners are just the
 * frame's and say nothing about where the words are — which is the one thing worth
 * drawing a box around. Passing the text's rectangle gives a box around the text.
 */
export function layerCorners(
  transform: Transform2D,
  frameSize: Size,
  imageSize: Size,
  region?: Rect,
): Corners {
  const p = layerPlacement(transform, frameSize, imageSize);
  const left = region?.x ?? 0;
  const top = region?.y ?? 0;
  const right = left + (region?.width ?? imageSize.width);
  const bottom = top + (region?.height ?? imageSize.height);
  return [
    project(p, left, top),
    project(p, right, top),
    project(p, right, bottom),
    project(p, left, bottom),
  ];
}

/** The upright rectangle containing all four corners. Rotated layers give their extent. */
export function boundingBox(corners: Corners): Rect {
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
