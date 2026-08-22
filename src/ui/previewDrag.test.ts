/**
 * Dragging a clip about in the program monitor.
 *
 * The parts worth pinning are the two that are easy to get quietly wrong: the
 * monitor is a scaled view, so screen pixels are not frame pixels; and a position
 * that is animated must gain a keyframe rather than be flattened to a constant.
 */

import { describe, expect, it } from 'vitest';
import { keyframe, keyframedParam, staticParam } from '../model/params';
import * as T from '../model/time';
import type { Clip } from '../model/types';
import { draggedParam, isPositionable, monitorScale, paramOrigin, pictureRect } from './previewDrag';

const sec = (n: number): T.Time => T.time(n);

describe('which clips can be moved', () => {
  it('takes anything with a picture', () => {
    for (const kind of ['video', 'title', 'solid'] as const) {
      expect(isPositionable({ kind } as Clip)).toBe(true);
    }
  });

  it('leaves sound alone, which has nowhere to be moved to', () => {
    expect(isPositionable({ kind: 'audio' } as Clip)).toBe(false);
  });
});

describe('turning screen pixels into frame pixels', () => {
  it('scales up when the monitor is smaller than the frame', () => {
    // A 1920-wide frame shown 480 wide: one screen pixel is four frame pixels.
    expect(monitorScale(1920, 480)).toBe(4);
  });

  it('scales down when the monitor is larger than the frame', () => {
    expect(monitorScale(640, 1280)).toBe(0.5);
  });

  it('is one-to-one at native size', () => {
    expect(monitorScale(1920, 1920)).toBe(1);
  });

  it('does not divide by a monitor that has no width yet', () => {
    // A hidden or unmeasured panel, which must not produce Infinity or NaN.
    expect(monitorScale(1920, 0)).toBe(1);
    expect(Number.isFinite(monitorScale(1920, 0))).toBe(true);
  });
});

describe('what a drag writes back', () => {
  it('replaces a static position outright', () => {
    const next = draggedParam(staticParam(10), sec(1), 250);
    expect(next).toEqual(staticParam(250));
  });

  it('keyframes an animated one instead of flattening it', () => {
    const animated = keyframedParam([keyframe(sec(0), 0), keyframe(sec(4), 100)]);

    const next = draggedParam(animated, sec(2), 250);

    expect(next.kind).toBe('keyframed');
    // The keyframes that were already there survive the drag.
    const ats = next.kind === 'keyframed' ? next.keyframes.map((k) => T.toSeconds(k.at)) : [];
    expect(ats).toContain(0);
    expect(ats).toContain(4);
    expect(ats).toContain(2);
  });

  it('moves an existing keyframe rather than adding a second at the same moment', () => {
    const animated = keyframedParam([keyframe(sec(0), 0), keyframe(sec(4), 100)]);

    const next = draggedParam(animated, sec(4), 999);

    const frames = next.kind === 'keyframed' ? next.keyframes : [];
    expect(frames.length).toBe(2);
    expect(frames.find((k) => T.toSeconds(k.at) === 4)?.value).toBe(999);
  });
});

describe('where a drag starts from', () => {
  it('reads a static value straight off', () => {
    expect(paramOrigin(staticParam(42), sec(3))).toBe(42);
  });

  it('reads an animated one at the moment being looked at', () => {
    const animated = keyframedParam([keyframe(sec(0), 0), keyframe(sec(4), 100)]);
    expect(paramOrigin(animated, sec(2))).toBeCloseTo(50, 6);
  });
});

describe('pictureRect', () => {
  const frame = { width: 1920, height: 1080 };
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

  it('is the whole box when the panel already shares the frame shape', () => {
    expect(pictureRect(frame, box(0, 0, 640, 360))).toEqual(box(0, 0, 640, 360));
  });

  it('bars the sides when the panel is wider than the frame', () => {
    // 800x360 holds a 16:9 picture 640 wide, leaving 80 either side.
    expect(pictureRect(frame, box(0, 0, 800, 360))).toEqual(box(80, 0, 640, 360));
  });

  it('bars the top and bottom when the panel is taller', () => {
    // 640x480 holds a 16:9 picture 360 tall, leaving 60 above and below.
    expect(pictureRect(frame, box(0, 0, 640, 480))).toEqual(box(0, 60, 640, 360));
  });

  it('keeps the box offset, since callers work in client coordinates', () => {
    expect(pictureRect(frame, box(100, 50, 800, 360))).toEqual(box(180, 50, 640, 360));
  });

  it('is what a drag must scale by, not the element', () => {
    // The measured case: a 320x180 sequence in a 603x297 panel.
    const picture = pictureRect({ width: 320, height: 180 }, box(0, 0, 603, 297));
    expect(Math.round(picture.width)).toBe(528);
    // Scaling by the element instead would move the picture 12% short of the pointer.
    expect(monitorScale(320, picture.width)).toBeGreaterThan(monitorScale(320, 603));
  });

  it('hands back a collapsed panel unchanged rather than dividing by zero', () => {
    expect(pictureRect(frame, box(0, 0, 0, 0))).toEqual(box(0, 0, 0, 0));
    expect(pictureRect({ width: 0, height: 0 }, box(0, 0, 100, 50))).toEqual(box(0, 0, 100, 50));
  });
});
