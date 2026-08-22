/**
 * Moving a clip by dragging it in the program monitor.
 *
 * The maths lives here, away from the component, because the awkward parts are all
 * arithmetic: the monitor is a scaled view of the frame, so a pointer travelling one
 * screen pixel moves the picture by more than one sequence pixel, and a position that
 * is animated must take a keyframe rather than be flattened to a constant.
 */

import { evalNumber, staticParam, upsertKeyframe } from '../model/params';
import type { AudioClip, Clip, Param, Time } from '../model/types';

/** A clip carrying a transform — everything but sound, which has nowhere to be. */
export type PositionableClip = Exclude<Clip, AudioClip>;

export function isPositionable(clip: Clip): clip is PositionableClip {
  return clip.kind !== 'audio';
}

/**
 * Sequence pixels per screen pixel.
 *
 * The monitor letterboxes, so the picture's drawn width is what matters rather than
 * the element's — but the canvas keeps the frame's own aspect, so one ratio serves
 * both axes. Guarded against a zero-width element, which is what a hidden panel is.
 *
 * Pass `pictureRect(...).width`, not the element's. They are not the same number and
 * the difference is not small: a 16:9 frame in a 2:1 panel is drawn 12% narrower
 * than its element, and a drag scaled by the element moved the picture 12% short of
 * the pointer — which reads as the title lagging behind the mouse.
 */
export function monitorScale(frameWidth: number, drawnWidth: number): number {
  return drawnWidth > 0 ? frameWidth / drawnWidth : 1;
}

/** A rectangle in whatever coordinates its caller is already using. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the picture actually lands inside the monitor's box.
 *
 * `object-fit: contain` fits the frame within the element and centres it, so unless
 * the panel happens to share the frame's shape the element's own rectangle includes
 * bars that are not picture. Anything converting between screen and frame pixels —
 * a drag, a selection outline — has to work from this rather than from the element.
 */
export function pictureRect(frameSize: { width: number; height: number }, box: Box): Box {
  if (box.width <= 0 || box.height <= 0 || frameSize.width <= 0 || frameSize.height <= 0) {
    return box;
  }
  const frameAspect = frameSize.width / frameSize.height;
  const wide = box.width / box.height > frameAspect;
  const width = wide ? box.height * frameAspect : box.width;
  const height = wide ? box.height : box.width / frameAspect;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/**
 * The param a dragged position should become.
 *
 * A static position simply takes the new value. An animated one takes a keyframe at
 * the moment being looked at instead: flattening it would silently throw away every
 * other keyframe on the track, which is a great deal to lose to a drag.
 */
export function draggedParam(param: Param<number>, at: Time, value: number): Param<number> {
  return param.kind === 'static' ? staticParam(value) : upsertKeyframe(param, at, value);
}

/** Where a param stands at a moment, as the drag's starting point. */
export function paramOrigin(param: Param<number>, at: Time): number {
  return evalNumber(param, at);
}
