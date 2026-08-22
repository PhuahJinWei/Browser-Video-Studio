/**
 * The program monitor's frame commands.
 */

import { describe, expect, it } from 'vitest';
import type { Command } from '../model/commands';
import type { ClipId } from '../model/types';
import {
  fitToFrameCommands,
  resetPositionCommands,
  resetTransformCommands,
  scaleToFit,
} from './monitorActions';

const a = 'cl_a' as ClipId;
const b = 'cl_b' as ClipId;
const HD = { width: 1920, height: 1080 };

/** The key/value pairs a command list sets, for terse assertions. */
function pairs(commands: readonly Command[]) {
  return commands
    .filter((c): c is Extract<Command, { type: 'setClipParam' }> => c.type === 'setClipParam')
    .map((c) => [c.clipId, c.key, (c.param as { value: number }).value]);
}

describe('scaling to meet a frame', () => {
  it('shrinks a source larger than the frame', () => {
    expect(scaleToFit({ width: 3840, height: 2160 }, HD)).toBe(0.5);
  });

  it('enlarges a source smaller than it — the monitor means fit, not shrink', () => {
    expect(scaleToFit({ width: 960, height: 540 }, HD)).toBe(2);
  });

  it('keeps aspect by taking the tighter of the two axes', () => {
    // Wider than the frame but not as tall: width is what limits it.
    expect(scaleToFit({ width: 3840, height: 1080 }, HD)).toBe(0.5);
  });

  it('leaves a source with no size alone rather than dividing by zero', () => {
    expect(scaleToFit({ width: 0, height: 0 }, HD)).toBe(1);
    expect(Number.isFinite(scaleToFit({ width: 0, height: 1080 }, HD))).toBe(true);
  });
});

describe('reset position', () => {
  it('centres a clip and touches nothing else', () => {
    expect(pairs(resetPositionCommands([a]))).toEqual([
      [a, 'transform.x', 0],
      [a, 'transform.y', 0],
    ]);
  });

  it('covers every clip in the selection', () => {
    expect(resetPositionCommands([a, b]).length).toBe(4);
  });

  it('does nothing for an empty selection', () => {
    expect(resetPositionCommands([])).toEqual([]);
  });
});

describe('reset all transform', () => {
  it('puts position, scale and rotation back to neutral', () => {
    expect(pairs(resetTransformCommands([a]))).toEqual([
      [a, 'transform.x', 0],
      [a, 'transform.y', 0],
      [a, 'transform.scaleX', 1],
      [a, 'transform.scaleY', 1],
      [a, 'transform.rotation', 0],
    ]);
  });

  it('leaves the anchors alone', () => {
    // An anchor says what a clip turns about; resetting one moves the clip rather
    // than un-turning it, which is not what "reset" is being asked for.
    const keys = resetTransformCommands([a]).flatMap((c) => (c.type === 'setClipParam' ? [c.key] : []));
    expect(keys).not.toContain('transform.anchorX');
    expect(keys).not.toContain('transform.anchorY');
  });
});

describe('fit to frame', () => {
  it('scales both axes by the same amount, so the aspect holds', () => {
    expect(pairs(fitToFrameCommands(a, { width: 3840, height: 2160 }, HD))).toEqual([
      [a, 'transform.scaleX', 0.5],
      [a, 'transform.scaleY', 0.5],
    ]);
  });

  it('leaves the clip where it is', () => {
    // Fitting is about size. A clip deliberately placed low in the frame should not
    // jump back to the middle because it was resized.
    const keys = fitToFrameCommands(a, { width: 960, height: 540 }, HD).flatMap((c) => (c.type === 'setClipParam' ? [c.key] : []));
    expect(keys).toEqual(['transform.scaleX', 'transform.scaleY']);
  });
});
