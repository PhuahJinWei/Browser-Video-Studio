/**
 * Rolling edits.
 *
 * The defining property is that nothing else moves: one clip gains exactly what the
 * other gives up, so the pair covers the same span and everything downstream stays
 * where it was. That, and the clamping — a roll may not consume a clip, and may not
 * ask for source material that is not there.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import { clipEnd, getClip, ModelError, rollBounds } from './selectors';
import * as T from './time';
import type { ClipId, Project } from './types';
import { assertValidProject } from './validate';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/**
 * A (0–4 s) then B (4–8 s), both taking the middle of the 10 s asset. A therefore
 * has 4 s of tail spare and B has 2 s of head.
 */
function pair(): Project {
  return run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), sourceIn: sec(2), name: 'A' }),
    insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(4), sourceIn: sec(2), name: 'B' }),
  );
}

function ids(p: Project): readonly ClipId[] {
  return p.tracks[f.v1 as never]!.clipIds;
}

function roll(p: Project, to: ReturnType<typeof sec>): Project {
  const [a, b] = ids(p);
  return runFrom(f, p, { type: 'rollEdit', fromClipId: a!, toClipId: b!, to });
}

function shape(p: Project): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids(p)) {
    const clip = getClip(p, id);
    out[clip.name] =
      `${T.toSeconds(clip.start)}..${T.toSeconds(clipEnd(clip))} @${T.toSeconds((clip as { sourceIn: ReturnType<typeof sec> }).sourceIn)}`;
  }
  return out;
}

describe('moving the cut', () => {
  it('gives one clip exactly what the other loses', () => {
    const rolled = roll(pair(), sec(5));
    expect(shape(rolled)).toEqual({
      // A keeps its start and plays a second longer, out of its tail handle.
      A: '0..5 @2',
      // B starts a second later and reads a second further into the source, so the
      // picture at any surviving moment of B is unchanged.
      B: '5..8 @3',
    });
    assertValidProject(rolled);
  });

  it('leaves the pair covering the same span', () => {
    const before = pair();
    for (const target of [sec(5), sec(3), sec(7), sec(2)]) {
      const rolled = roll(before, target);
      const clips = ids(rolled).map((id) => getClip(rolled, id));
      expect(T.toSeconds(clips[0]!.start)).toBe(0);
      expect(T.toSeconds(clipEnd(clips[1]!))).toBe(8);
    }
  });

  it('rolls the other way just as well', () => {
    const rolled = roll(pair(), sec(3));
    expect(shape(rolled)).toEqual({ A: '0..3 @2', B: '3..8 @1' });
    assertValidProject(rolled);
  });

  it('does nothing when asked to roll to where the cut already is', () => {
    const before = pair();
    const after = roll(before, sec(4));
    expect(shape(after)).toEqual(shape(before));
  });
});

describe('what bounds it', () => {
  it('stops where the outgoing clip runs out of tail', () => {
    const p = pair();
    const [a, b] = ids(p).map((id) => getClip(p, id));
    // A has 4 s of tail; B is 4 s long and must keep a frame, so 3.96 s binds first.
    const bounds = rollBounds(p, a!, b!, T.time(1, 25));
    expect(T.toSeconds(bounds.latest)).toBe(7.96);
  });

  it('stops where the incoming clip runs out of head', () => {
    const p = pair();
    const [a, b] = ids(p).map((id) => getClip(p, id));
    // B has only 2 s of head, which binds well before A's 3.96 s of room.
    const bounds = rollBounds(p, a!, b!, T.time(1, 25));
    expect(T.toSeconds(bounds.earliest)).toBe(2);
  });

  it('clamps an over-long roll instead of refusing it', () => {
    // Asking to roll back to 0 would need 4 s of head on B, which has 2 s.
    const rolled = roll(pair(), sec(0));
    expect(shape(rolled)).toEqual({ A: '0..2 @2', B: '2..8 @0' });
    assertValidProject(rolled);
  });

  it('never consumes a clip entirely', () => {
    const rolled = roll(pair(), sec(20));
    const clips = ids(rolled).map((id) => getClip(rolled, id));
    expect(clips).toHaveLength(2);
    // B keeps a single frame at 25 fps.
    expect(T.toSeconds(clips[1]!.duration)).toBe(0.04);
    assertValidProject(rolled);
  });
});

describe('refusals', () => {
  it('rejects clips that are not adjacent', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(5), duration: sec(2), name: 'B' }),
    );
    const [a, b] = ids(p);
    expect(() =>
      runFrom(f, p, { type: 'rollEdit', fromClipId: a!, toClipId: b!, to: sec(3) }),
    ).toThrow(ModelError);
  });

  it('rejects clips on different tracks', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
      insertCommand(f, { trackId: f.v2, start: sec(4), duration: sec(4), name: 'B' }),
    );
    const a = p.tracks[f.v1 as never]!.clipIds[0]!;
    const b = p.tracks[f.v2 as never]!.clipIds[0]!;
    expect(() =>
      runFrom(f, p, { type: 'rollEdit', fromClipId: a, toClipId: b, to: sec(5) }),
    ).toThrow(ModelError);
  });

  it('rejects a locked clip', () => {
    const p = pair();
    const [a] = ids(p);
    const locked = runFrom(f, p, {
      type: 'setClipProps',
      clipId: a!,
      props: { locked: true },
    });
    expect(() => roll(locked, sec(5))).toThrow(ModelError);
  });
});

describe('a transition sitting on the cut', () => {
  function withTransition(): Project {
    const p = pair();
    const [a, b] = ids(p);
    return runFrom(f, p, {
      type: 'addTransition',
      fromClipId: a!,
      toClipId: b!,
      duration: sec(2),
    });
  }

  it('travels with the cut it belongs to', () => {
    const p = withTransition();
    const rolled = roll(p, sec(5));
    const transition = Object.values(rolled.transitions)[0]!;
    // Anchored to the clips, so its span follows them rather than staying at 4 s.
    expect(T.toSeconds(getClip(rolled, transition.toClipId).start)).toBe(5);
    assertValidProject(rolled);
  });

  it('is shortened when the roll leaves it less room', () => {
    const p = withTransition();
    expect(T.toSeconds(Object.values(p.transitions)[0]!.duration)).toBe(2);

    // Rolling forward gives B *more* head — its in-point moves deeper into the
    // source — so what binds is how short B gets. At 6.5 s it is down to 1.5 s, and
    // a transition may not be longer than the shorter of the two clips.
    const rolled = roll(p, sec(13, 2));
    expect(T.toSeconds(Object.values(rolled.transitions)[0]!.duration)).toBe(1.5);
    assertValidProject(rolled);
  });

  it('is dropped when the roll leaves nothing to blend with', () => {
    const p = withTransition();
    // Rolling back to 2 s spends every frame of B's head, so a centred transition —
    // which needs head on the incoming side — has nothing left to work with.
    const rolled = roll(p, sec(2));
    expect(Object.values(rolled.transitions)).toHaveLength(0);
    assertValidProject(rolled);
  });
});
