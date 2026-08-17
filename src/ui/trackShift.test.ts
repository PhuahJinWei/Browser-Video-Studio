/**
 * Where the rest of a dragged unit lands when the clip under the pointer changes
 * track.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture, run, type Fixture } from '../model/fixtures';
import type { Project, TrackId } from '../model/types';
import { shiftedTrack } from './trackShift';

let f: Fixture;
let base: Project;
/** A second audio track, so the audio stack is as deep as the video one. */
let a2: TrackId;

beforeEach(() => {
  f = makeFixture();
  a2 = f.ids.track();
  base = run(f, { type: 'addTrack', sequenceId: f.seqId, kind: 'audio', index: 1, trackId: a2 });
});

function seq(p: Project) {
  return p.sequences[f.seqId]!;
}

describe('a linked partner', () => {
  it('takes the same step through its own stack: V2 → V1 carries A2 → A1', () => {
    expect(shiftedTrack(base, seq(base), f.v2, f.v1, a2)).toBe(f.a1);
  });

  it('follows back the other way too', () => {
    expect(shiftedTrack(base, seq(base), f.v1, f.v2, f.a1)).toBe(a2);
  });

  it('stays put when the clip under the pointer did not change track', () => {
    expect(shiftedTrack(base, seq(base), f.v1, f.v1, f.a1)).toBe(f.a1);
  });
});

describe('when the step has nowhere to land', () => {
  it('leaves the member alone rather than blocking the drag', () => {
    // Only A1 exists in this project, so a step down the audio stack runs off it.
    const single = f.project;
    expect(shiftedTrack(single, seq(single), f.v2, f.v1, f.a1)).toBe(f.a1);
  });

  it('leaves the member alone when the track it would take is locked', () => {
    const locked = run(
      { ...f, project: base },
      { type: 'setTrackProps', trackId: f.a1, props: { locked: true } },
    );
    expect(shiftedTrack(locked, seq(locked), f.v2, f.v1, a2)).toBe(a2);
  });
});
