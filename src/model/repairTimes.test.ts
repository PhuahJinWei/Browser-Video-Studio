/**
 * Repairing a document whose exact times grew denominators too large to work with.
 */

import { describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, sec } from './fixtures';
import { MAX_REASONABLE_DEN, repairProjectTimes } from './repairTimes';
import * as T from './time';
import type { ClipId, Project } from './types';

/** A project with one clip, whose start has been forced to a pathological value. */
function withDamagedStart(): { project: Project; clipId: ClipId } {
  const f = makeFixture();
  const base = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
  const clipId = base.tracks[f.v1]!.clipIds[0]!;
  const clip = base.clips[clipId]!;
  return {
    project: {
      ...base,
      clips: { ...base.clips, [clipId]: { ...clip, start: T.time(13151068, 847255111) } },
    },
    clipId,
  };
}

describe('a healthy document', () => {
  it('is handed back untouched', () => {
    const f = makeFixture();
    const project = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));

    const result = repairProjectTimes(project);

    expect(result.repaired).toBe(0);
    expect(result.project).toBe(project);
  });

  it('leaves a sensible odd denominator alone rather than normalising everything', () => {
    const f = makeFixture();
    // A third of a second is not on the 25 fps grid, and has every right not to be.
    const project = run(f, insertCommand(f, { trackId: f.v1, start: sec(1, 3), duration: sec(4) }));

    expect(repairProjectTimes(project).repaired).toBe(0);
  });
});

describe('a document carrying a time too large to work with', () => {
  it('moves it onto the frame grid', () => {
    const { project, clipId } = withDamagedStart();

    const result = repairProjectTimes(project);

    expect(result.repaired).toBe(1);
    const start = result.project.clips[clipId]!.start;
    expect(start.den).toBeLessThanOrEqual(MAX_REASONABLE_DEN);
    expect(T.isFrameAligned(start, T.FPS_25)).toBe(true);
  });

  it('moves it only as far as the nearest frame', () => {
    const { project, clipId } = withDamagedStart();
    const before = T.toSeconds(project.clips[clipId]!.start);

    const after = T.toSeconds(repairProjectTimes(project).project.clips[clipId]!.start);

    const halfFrame = T.toSeconds(T.frameDuration(T.FPS_25)) / 2;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(halfFrame + 1e-9);
  });

  it('leaves the clips it did not have to touch identical', () => {
    const f = makeFixture();
    const base = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(4), name: 'B' }),
    );
    const [a, b] = base.tracks[f.v1]!.clipIds as [ClipId, ClipId];
    const damaged: Project = {
      ...base,
      clips: { ...base.clips, [a]: { ...base.clips[a]!, start: T.time(1, 999_331_337) } },
    };

    const result = repairProjectTimes(damaged);

    expect(result.repaired).toBe(1);
    expect(result.project.clips[b]).toBe(base.clips[b]);
  });

  it('never rounds a clip away to nothing', () => {
    const f = makeFixture();
    const base = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const clipId = base.tracks[f.v1]!.clipIds[0]!;
    // Shorter than half a frame, so rounding to the nearest would erase it.
    const damaged: Project = {
      ...base,
      clips: { ...base.clips, [clipId]: { ...base.clips[clipId]!, duration: T.time(1, 999_331_337) } },
    };

    const duration = repairProjectTimes(damaged).project.clips[clipId]!.duration;

    expect(T.isPositive(duration)).toBe(true);
    expect(duration).toEqual(T.frameDuration(T.FPS_25));
  });

  it('leaves a repaired document able to take another edit without overflowing', () => {
    const { project, clipId } = withDamagedStart();
    const repaired = repairProjectTimes(project).project;

    // The edit that used to throw: add a fresh pointer-derived delta to the start.
    let start = repaired.clips[clipId]!.start;
    for (let i = 0; i < 50; i++) {
      const delta = T.fromSeconds((i * 7 - 100) / (60 + i * 3.7), 100_000);
      start = T.snapToFrame(T.max(T.TIME_ZERO, T.add(start, delta)), T.FPS_25);
    }

    expect(start.den).toBeLessThanOrEqual(MAX_REASONABLE_DEN);
  });
});
