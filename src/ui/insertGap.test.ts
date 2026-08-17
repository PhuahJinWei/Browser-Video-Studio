/**
 * What a drop into a timeline insert gap plans to build.
 *
 * The interesting case is the linked pair: it needs two tracks rather than one, and
 * the ghosts drawn during the drag come from this same plan, so a mistake here shows
 * up as a preview that lies about where the clip is going.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, sec, type Fixture } from '../model/fixtures';
import type { Clip, ClipId, Project } from '../model/types';
import { planGapInsert, type GapTarget } from './insertGap';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/** The sequence's two track lists, which are all the planner reads of it. */
function seq(p: Project) {
  return p.sequences[f.seqId]!;
}

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

describe('a clip with no partner of the other kind', () => {
  it('takes the gap it was actually dropped into, and makes one track', () => {
    const project = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const clip = Object.values(project.clips)[0]!;

    const plan = planGapInsert(project, seq(project), clip.id, [clip.id], BOTTOM)!;

    expect(plan.primaryTrack).toEqual({ kind: 'audio', index: 1, side: 'below' });
    expect(plan.partners).toEqual([]);
    expect(plan.partnerTrack).toBeNull();
  });
});

describe('a linked A/V pair', () => {
  it('brackets the stack: picture above every video lane, sound below every audio one', () => {
    const { project, video, audio, unit } = pair();

    const plan = planGapInsert(project, seq(project), video.id, unit, TOP)!;

    expect(plan.primary.id).toBe(video.id);
    expect(plan.primaryTrack).toEqual({ kind: 'video', index: 2, side: 'above' });
    expect(plan.partners.map((c) => c.id)).toEqual([audio.id]);
    expect(plan.partnerTrack).toEqual({ kind: 'audio', index: 1, side: 'below' });
  });

  it('plans the same two tracks whichever half is dragged, and into whichever gap', () => {
    const { project, video, audio, unit } = pair();

    const fromVideo = planGapInsert(project, seq(project), video.id, unit, TOP)!;
    const fromAudio = planGapInsert(project, seq(project), audio.id, unit, BOTTOM)!;

    // The roles swap with the grabbed half; the tracks they describe do not.
    expect(fromAudio.primaryTrack).toEqual(fromVideo.partnerTrack);
    expect(fromAudio.partnerTrack).toEqual(fromVideo.primaryTrack);
  });

  it('puts one ghost in each gap rather than two in the one aimed at', () => {
    const { project, video, unit } = pair();

    const plan = planGapInsert(project, seq(project), video.id, unit, BOTTOM)!;

    expect(plan.primaryTrack.side).not.toBe(plan.partnerTrack!.side);
  });
});

describe('a group of clips that are all the same kind', () => {
  it('keeps the single-track behaviour, since there is no other end to use', () => {
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }),
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(2) }),
    );
    const both = Object.values(project.clips).map((c) => c.id);

    const plan = planGapInsert(project, seq(project), both[0]!, both, TOP)!;

    expect(plan.partners).toEqual([]);
    expect(plan.partnerTrack).toBeNull();
  });
});
