/**
 * Whether Split would cut anything, and what it says when it would not.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, sec, type Fixture } from '../model/fixtures';
import { canSplitAt, splitHint, trackSplitsAt } from './splitAvailability';

let f: Fixture;

beforeEach(() => {
  f = makeFixture();
});

/** One clip on V1 spanning 0–4s. */
function withClip() {
  return run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
}

describe('whether a track would be cut', () => {
  it('cuts where the playhead is inside a clip', () => {
    expect(trackSplitsAt(withClip(), f.v1, sec(2))).toBe(true);
  });

  /*
   * Both edges are excluded. At the start the left half would be empty; at the end
   * the right half would be — which is to say the cut asked for is already there.
   */
  it('does not cut at the very start of a clip', () => {
    expect(trackSplitsAt(withClip(), f.v1, sec(0))).toBe(false);
  });

  it('does not cut at the very end of a clip', () => {
    expect(trackSplitsAt(withClip(), f.v1, sec(4))).toBe(false);
  });

  it('does not cut in a gap past the end', () => {
    expect(trackSplitsAt(withClip(), f.v1, sec(9))).toBe(false);
  });

  it('does not cut an empty track', () => {
    expect(trackSplitsAt(withClip(), f.v2, sec(2))).toBe(false);
  });

  /* The command refuses a locked track outright, so the button must too. */
  it('does not cut a locked track, clip or no clip', () => {
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }),
      { type: 'setTrackProps', trackId: f.v1, props: { locked: true } },
    );
    expect(trackSplitsAt(project, f.v1, sec(2))).toBe(false);
  });
});

describe('whether any track would be cut', () => {
  it('is true when one of several would', () => {
    const project = withClip();
    expect(canSplitAt(project, [f.v1, f.v2, f.a1], sec(2))).toBe(true);
  });

  it('is false when none would', () => {
    const project = withClip();
    expect(canSplitAt(project, [f.v2, f.a1], sec(2))).toBe(false);
  });

  it('is false with no tracks at all', () => {
    expect(canSplitAt(withClip(), [], sec(2))).toBe(false);
  });
});

describe('what the button says when it cannot', () => {
  const tracks = () => [f.v1, f.v2, f.a1];

  it('names the shortcut when it can', () => {
    expect(splitHint(withClip(), tracks(), true, true)).toBe('Split at the playhead (S)');
  });

  /* An empty timeline needs a different next step from a playhead parked in a gap. */
  it('points at the timeline when there is nothing on it', () => {
    expect(splitHint(f.project, tracks(), false, false)).toBe(
      'Nothing on the timeline to split yet',
    );
  });

  it('points at the playhead when there are clips but not here', () => {
    expect(splitHint(withClip(), tracks(), false, true)).toBe(
      'Move the playhead over a clip to split it',
    );
  });

  it('names the lock when that is what is in the way', () => {
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }),
      { type: 'setTrackProps', trackId: f.v1, props: { locked: true } },
    );
    expect(splitHint(project, [f.v1], false, true)).toBe(
      'Every track here is locked — unlock one to split it',
    );
  });

  it('never returns an empty string', () => {
    for (const canSplit of [false, true]) {
      for (const hasClips of [false, true]) {
        expect(splitHint(withClip(), tracks(), canSplit, hasClips).length).toBeGreaterThan(0);
      }
    }
  });
});
