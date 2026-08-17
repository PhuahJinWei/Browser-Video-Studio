/**
 * Sequence format: resolution and frame rate.
 *
 * The invariant that matters is that changing the rate is a change of *counting*,
 * not of content. Clip positions are exact rational seconds, so nothing may move.
 */

import { describe, expect, it } from 'vitest';
import { apply } from './commands';
import { insertCommand, makeFixture, run, sec } from './fixtures';
import { clipEnd, getSequence } from './selectors';
import * as T from './time';
import { validateProject } from './validate';

describe('setSequenceSettings', () => {
  it('changes resolution and frame rate', () => {
    const f = makeFixture();
    const p = apply(
      f.project,
      {
        type: 'setSequenceSettings',
        sequenceId: f.seqId,
        size: { width: 576, height: 360 },
        frameRate: T.FPS_60,
      },
      f.ids,
    );

    const seq = getSequence(p, f.seqId);
    expect(seq.size).toEqual({ width: 576, height: 360 });
    expect(seq.frameRate).toEqual(T.FPS_60);
    expect(validateProject(p)).toEqual([]);
  });

  it('leaves the other field alone when only one is given', () => {
    const f = makeFixture();
    const before = getSequence(f.project, f.seqId);
    const p = apply(
      f.project,
      { type: 'setSequenceSettings', sequenceId: f.seqId, size: { width: 640, height: 480 } },
      f.ids,
    );
    expect(getSequence(p, f.seqId).frameRate).toEqual(before.frameRate);
  });

  it('does not move a single clip when the frame rate changes', () => {
    const f = makeFixture();
    const before = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(1), duration: sec(2) }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(3) }),
    );
    const positions = before.tracks[f.v1]!.clipIds.map((id) => {
      const clip = before.clips[id]!;
      return [clip.start, clipEnd(clip)] as const;
    });

    // 25 fps to 59.94, which shares no frame boundary with it whatsoever.
    const after = apply(
      before,
      { type: 'setSequenceSettings', sequenceId: f.seqId, frameRate: T.FPS_59_94 },
      f.ids,
    );

    const moved = after.tracks[f.v1]!.clipIds.map((id) => {
      const clip = after.clips[id]!;
      return [clip.start, clipEnd(clip)] as const;
    });
    expect(moved).toEqual(positions);
    expect(validateProject(after)).toEqual([]);
  });

  it('refuses a size that an encoder could not use', () => {
    const f = makeFixture();
    const bad = (size: { width: number; height: number }): (() => unknown) =>
      () => apply(f.project, { type: 'setSequenceSettings', sequenceId: f.seqId, size }, f.ids);

    expect(bad({ width: 0, height: 1080 })).toThrow(/positive/);
    expect(bad({ width: 1920, height: -1 })).toThrow(/positive/);
    expect(bad({ width: 1920.5, height: 1080 })).toThrow(/whole pixels/);
  });

  it('refuses a frame rate that would divide by zero', () => {
    const f = makeFixture();
    expect(() =>
      apply(
        f.project,
        { type: 'setSequenceSettings', sequenceId: f.seqId, frameRate: { num: 30, den: 0 } },
        f.ids,
      ),
    ).toThrow(/positive/);
  });

  it('reports an unknown sequence rather than silently doing nothing', () => {
    const f = makeFixture();
    expect(() =>
      apply(
        f.project,
        { type: 'setSequenceSettings', sequenceId: 'sq_nope' as never, frameRate: T.FPS_24 },
        f.ids,
      ),
    ).toThrow();
  });
});
