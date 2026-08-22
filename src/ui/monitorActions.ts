/**
 * What the program monitor's menu does to a clip's frame.
 *
 * The maths and the command lists live here rather than in the component so they can
 * be read and tested on their own — every one of these is "put these numbers back",
 * and the only interesting part is which numbers.
 */

import { staticParam } from '../model/params';
import type { ClipParamKey, Command } from '../model/commands';
import type { ClipId, Size } from '../model/types';

/**
 * The scale that makes a source exactly fit inside a frame.
 *
 * Both directions: a source smaller than the frame is enlarged to meet it. That is
 * what "fit to frame" means when a person asks for it in the monitor, and it is not
 * what placement wants — dropping a small clip should leave it at its own size
 * rather than blow it up, so `fitScale` clamps this at 1 for that case.
 */
export function scaleToFit(source: Size, frame: Size): number {
  if (source.width <= 0 || source.height <= 0) return 1;
  return Math.min(frame.width / source.width, frame.height / source.height);
}

function set(clipId: ClipId, key: ClipParamKey, value: number): Command {
  return { type: 'setClipParam', clipId, key, param: staticParam(value) };
}

/** Back to the middle of the frame, leaving scale and rotation as they are. */
export function resetPositionCommands(clipIds: readonly ClipId[]): readonly Command[] {
  return clipIds.flatMap((clipId) => [
    set(clipId, 'transform.x', 0),
    set(clipId, 'transform.y', 0),
  ]);
}

/**
 * Everything the frame controls back to neutral.
 *
 * Anchors are left alone: they say what a clip rotates and scales *about*, which is
 * a property of the clip rather than of where it has been put, and resetting one
 * would move a rotated clip rather than un-rotate it.
 */
export function resetTransformCommands(clipIds: readonly ClipId[]): readonly Command[] {
  return clipIds.flatMap((clipId) => [
    set(clipId, 'transform.x', 0),
    set(clipId, 'transform.y', 0),
    set(clipId, 'transform.scaleX', 1),
    set(clipId, 'transform.scaleY', 1),
    set(clipId, 'transform.rotation', 0),
  ]);
}

/** Scale a clip to meet the frame, keeping its aspect and where it sits. */
export function fitToFrameCommands(
  clipId: ClipId,
  source: Size,
  frame: Size,
): readonly Command[] {
  const scale = scaleToFit(source, frame);
  return [
    set(clipId, 'transform.scaleX', scale),
    set(clipId, 'transform.scaleY', scale),
  ];
}
