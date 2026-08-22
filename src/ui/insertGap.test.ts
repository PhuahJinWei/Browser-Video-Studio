/**
 * What a drop into a timeline insert gap plans to build.
 *
 * The rule under test is that the selection keeps its shape: every member takes the
 * same step through its own stack as the grabbed clip does, and only the steps that
 * run off the end make new tracks. The ghosts drawn during the drag come from this
 * same plan, so a mistake here shows up as a preview that lies about where a clip
 * is going.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, sec, type Fixture } from '../model/fixtures';
import type { Clip, ClipId, Project } from '../model/types';
import { planGapInsert, type GapTarget, type MemberOrigin } from './insertGap';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/** The sequence's two track lists, which are all the planner reads of it. */
function seq(p: Project) {
  return p.sequences[f.seqId]!;
}

/** Where each clip is now, as the drag would have recorded it at pointer-down. */
function origins(p: Project, ids: readonly ClipId[]): MemberOrigin[] {
  return ids.map((clipId) => ({ clipId, trackId: p.clips[clipId]!.trackId }));
}

// The fixture has V1, V2 and A1; these are the gaps past each end.
const TOP: GapTarget = { where: 'above', trackKind: 'video', index: 2 };
const BOTTOM: GapTarget = { where: 'below', trackKind: 'audio', index: 1 };

/** A video clip and its own audio, linked so they move as one. */
function pair(): { project: Project; video: Clip; audio: Clip; unit: readonly ClipId[] } {
  const placed = run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }),
    insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(4), kind: 'audio' }),
  );
  const clips = Object.values(placed.clips);
  const video = clips.find((c) => c.kind !== 'audio')!;
  const audio = clips.find((c) => c.kind === 'audio')!;
  const project = run({ ...f, project: placed }, { type: 'linkClips', clipIds: [video.id, audio.id] });
  return { project, video: project.clips[video.id]!, audio: project.clips[audio.id]!, unit: [video.id, audio.id] };
}

describe('a single clip', () => {
  it('goes to one new track at the end of its own stack', () => {
    const project = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const clip = Object.values(project.clips)[0]!;

    const plan = planGapInsert(project, seq(project), clip.id, origins(project, [clip.id]), TOP)!;

    expect(plan.newTracks).toEqual([{ kind: 'video', index: 2, side: 'above' }]);
    expect(plan.moves).toEqual([{ clip, to: { newTrack: 0 } }]);
  });
});

describe('a linked A/V pair', () => {
  it('takes both halves outward: a new track for each when both run off the end', () => {
    const { project, video, audio, unit } = pair();

    // V1 to the top gap is two steps; A1 taking two steps runs off a one-track stack.
    const plan = planGapInsert(project, seq(project), video.id, origins(project, unit), TOP)!;

    expect(plan.newTracks).toEqual([
      { kind: 'video', index: 2, side: 'above' },
      { kind: 'audio', index: 1, side: 'below' },
    ]);
    expect(plan.moves).toEqual([
      { clip: video, to: { newTrack: 0 } },
      { clip: audio, to: { newTrack: 1 } },
    ]);
  });

  it('steps the other half onto an existing track when there is one to step to', () => {
    const { project, video, audio, unit } = pair();

    // A1 to the bottom gap is one step; V1 taking one step lands on V2, which exists.
    const plan = planGapInsert(project, seq(project), audio.id, origins(project, unit), BOTTOM)!;

    expect(plan.newTracks).toEqual([{ kind: 'audio', index: 1, side: 'below' }]);
    expect(plan.moves).toEqual([
      { clip: video, to: { track: f.v2 } },
      { clip: audio, to: { newTrack: 0 } },
    ]);
  });
});

describe('a selection across two tracks of the same kind', () => {
  function stacked(): { project: Project; onV1: Clip; onV2: Clip } {
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }),
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(2) }),
    );
    const clips = Object.values(project.clips);
    return {
      project,
      onV1: clips.find((c) => c.trackId === f.v1)!,
      onV2: clips.find((c) => c.trackId === f.v2)!,
    };
  }

  it('keeps its shape: grabbing the top clip makes one track and the lower clip moves up under it', () => {
    const { project, onV1, onV2 } = stacked();
    const unit = [onV2.id, onV1.id];

    const plan = planGapInsert(project, seq(project), onV2.id, origins(project, unit), TOP)!;

    expect(plan.newTracks).toEqual([{ kind: 'video', index: 2, side: 'above' }]);
    expect(plan.moves).toEqual([
      { clip: onV2, to: { newTrack: 0 } },
      { clip: onV1, to: { track: f.v2 } },
    ]);
  });

  it('makes as many tracks as the shape needs, with no empty lane between them', () => {
    const { project, onV1, onV2 } = stacked();
    const unit = [onV1.id, onV2.id];

    // Grabbing the lower clip, two steps lifts both past the top — but the two rows
    // become the next two tracks, not "two up" and "three up" with a gap between.
    const plan = planGapInsert(project, seq(project), onV1.id, origins(project, unit), TOP)!;

    expect(plan.newTracks).toEqual([
      { kind: 'video', index: 2, side: 'above' },
      { kind: 'video', index: 3, side: 'above' },
    ]);
    expect(plan.moves).toEqual([
      { clip: onV1, to: { newTrack: 0 } },
      { clip: onV2, to: { newTrack: 1 } },
    ]);
  });

  it('is measured from where the drag began, not from where the members are now', () => {
    const { project, onV1, onV2 } = stacked();
    // The drag has already stepped the V1 clip onto V2 in the live document; the
    // plan must still see it as the V1 member, or it would be stepped a second time.
    const live = run({ ...f, project }, {
      type: 'moveClips',
      moves: [
        { clipId: onV2.id, toTrackId: f.v2, toStart: sec(0) },
        { clipId: onV1.id, toTrackId: f.v2, toStart: sec(3) },
      ],
    });
    const started: MemberOrigin[] = [
      { clipId: onV2.id, trackId: f.v2 },
      { clipId: onV1.id, trackId: f.v1 },
    ];

    const plan = planGapInsert(live, seq(live), onV2.id, started, TOP)!;

    expect(plan.newTracks).toHaveLength(1);
    expect(plan.moves.find((m) => m.clip.id === onV1.id)!.to).toEqual({ track: f.v2 });
  });
});
