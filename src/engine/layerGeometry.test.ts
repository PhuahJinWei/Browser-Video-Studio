/**
 * The forward projection, checked against the inverse the shader actually uses.
 *
 * The point of this module is that a box drawn round a layer and the pixels drawn
 * for it come from one calculation. The round-trip test below is what makes that a
 * fact rather than an intention: it rebuilds the composite shader's matrix exactly
 * as `writeLayerUniforms` does, and asserts that pushing a point through both
 * directions returns it unchanged.
 */

import { describe, expect, it } from 'vitest';
import { boundingBox, layerCorners, layerPlacement } from './layerGeometry';
import type { Size, Transform2D } from '../model/types';

const FRAME: Size = { width: 1920, height: 1080 };

function transform(overrides: Partial<Transform2D> = {}): Transform2D {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5, ...overrides };
}

/** The shader's mapping: a frame pixel back into image pixels. Mirrors the uniform. */
function inverseProject(t: Transform2D, frame: Size, image: Size, px: number, py: number) {
  const p = layerPlacement(t, frame, image);
  const sx = p.width === 0 ? 0 : image.width / p.width;
  const sy = p.height === 0 ? 0 : image.height / p.height;
  return {
    x: (p.cos * sx) * px + (p.sin * sx) * py + (-p.cos * p.centreX - p.sin * p.centreY + p.anchorX) * sx,
    y: (-p.sin * sy) * px + (p.cos * sy) * py + (p.sin * p.centreX - p.cos * p.centreY + p.anchorY) * sy,
  };
}

describe('layerCorners round-trips through the shader matrix', () => {
  const image: Size = { width: 640, height: 360 };
  const cases: readonly [string, Transform2D][] = [
    ['identity', transform()],
    ['translated', transform({ x: -300, y: 120 })],
    ['scaled', transform({ scaleX: 1.75, scaleY: 0.6 })],
    ['rotated', transform({ rotation: 37 })],
    ['off-centre anchor', transform({ anchorX: 0, anchorY: 1 })],
    ['everything at once', transform({ x: 210, y: -95, scaleX: 1.3, scaleY: 1.3, rotation: -22, anchorX: 0.2, anchorY: 0.8 })],
  ];

  for (const [name, t] of cases) {
    it(`agrees with the inverse: ${name}`, () => {
      const corners = layerCorners(t, FRAME, image);
      // The four corners are the image's own corners, so the inverse must return them.
      const expected = [
        { x: 0, y: 0 },
        { x: image.width, y: 0 },
        { x: image.width, y: image.height },
        { x: 0, y: image.height },
      ];
      corners.forEach((corner, index) => {
        const back = inverseProject(t, FRAME, image, corner.x, corner.y);
        expect(back.x).toBeCloseTo(expected[index]!.x, 6);
        expect(back.y).toBeCloseTo(expected[index]!.y, 6);
      });
    });
  }
});

describe('layerCorners', () => {
  it('puts an untransformed full-frame layer exactly on the frame', () => {
    const corners = layerCorners(transform(), FRAME, FRAME);
    expect(corners.map((c) => [Math.round(c.x), Math.round(c.y)])).toEqual([
      [0, 0],
      [1920, 0],
      [1920, 1080],
      [0, 1080],
    ]);
  });

  it('moves with the transform, which is what a drag changes', () => {
    const corners = layerCorners(transform({ x: -500 }), FRAME, FRAME);
    expect(corners[0].x).toBe(-500);
    expect(corners[1].x).toBe(1420);
  });

  it('bounds a region rather than the whole image, for a title inside its frame', () => {
    // A title is rasterised frame-sized with its words in the middle; the words are
    // the only part worth drawing a box around.
    const text = { x: 760, y: 490, width: 400, height: 100 };
    const corners = layerCorners(transform(), FRAME, FRAME, text);
    expect(boundingBox(corners)).toEqual({ x: 760, y: 490, width: 400, height: 100 });
  });

  it('carries a region along with the layer it belongs to', () => {
    const text = { x: 760, y: 490, width: 400, height: 100 };
    const box = boundingBox(layerCorners(transform({ x: -900, y: 40 }), FRAME, FRAME, text));
    expect(box).toEqual({ x: -140, y: 530, width: 400, height: 100 });
  });
});

describe('boundingBox', () => {
  it('grows to contain a rotated layer rather than reporting its unrotated size', () => {
    const square: Size = { width: 100, height: 100 };
    const box = boundingBox(layerCorners(transform({ rotation: 45 }), FRAME, square));
    // A 45-degree square spans its own diagonal.
    expect(box.width).toBeCloseTo(Math.SQRT2 * 100, 6);
    expect(box.height).toBeCloseTo(Math.SQRT2 * 100, 6);
  });
});
