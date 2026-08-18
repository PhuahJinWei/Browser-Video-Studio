/**
 * Which tracks a "remove empty tracks" sweep takes.
 *
 * The interesting cases are the ones it declines to take: the sweep is a tidy-up,
 * and handing back a sequence with no lane of a kind would be a repair job.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, sec, type Fixture } from '../model/fixtures';
import { emptyTracksToRemove } from './store';

let f: Fixture;

beforeEach(() => {
  f = makeFixture();
});

describe('with something on the timeline', () => {
  it('takes every track that holds nothing, stack by stack', () => {
    // V1 keeps a clip, so V2 goes. A1 is bare too, but it is the whole audio
    // stack — the sweep looks at each kind on its own and spares that one.
    const project = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    expect(emptyTracksToRemove(project, f.seqId)).toEqual([f.v2]);
  });

  it('takes an upper video track once the one below is spoken for', () => {
    const withThird = f.ids.track();
    const project = run(
      f,
      { type: 'addTrack', sequenceId: f.seqId, kind: 'video', trackId: withThird },
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }),
      insertCommand(f, { trackId: f.a1, kind: 'audio', start: sec(0), duration: sec(4) }),
    );
    expect(emptyTracksToRemove(project, f.seqId)).toEqual([f.v2, withThird]);
  });

  it('leaves a track alone once it has a clip', () => {
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }),
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(4) }),
      insertCommand(f, { trackId: f.a1, kind: 'audio', start: sec(0), duration: sec(4) }),
    );
    expect(emptyTracksToRemove(project, f.seqId)).toEqual([]);
  });

  it('spares the bottom video track when the whole picture stack is bare', () => {
    // Only the audio carries anything, so V1 survives as somewhere to drop picture.
    const project = run(
      f,
      insertCommand(f, { trackId: f.a1, kind: 'audio', start: sec(0), duration: sec(4) }),
    );
    expect(emptyTracksToRemove(project, f.seqId)).toEqual([f.v2]);
  });
});

describe('on an empty sequence', () => {
  it('keeps one lane of each kind and takes the rest', () => {
    expect(emptyTracksToRemove(f.project, f.seqId)).toEqual([f.v2]);
  });

  it('never empties a stack it has already reduced to one', () => {
    const once = run(f, ...emptyTracksToRemove(f.project, f.seqId).map((trackId) => ({
      type: 'removeTrack' as const,
      trackId,
    })));
    expect(emptyTracksToRemove(once, f.seqId)).toEqual([]);
  });
});
