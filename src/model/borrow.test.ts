/**
 * Transitions on clips with no handles.
 *
 * Dropping two whole files onto a track leaves neither clip anything to play past
 * its own cut, which is the commonest edit there is. The overlap then has to come
 * out of the clips themselves.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { applyAll } from './commands';
import { insertCommand, makeFixture, run, sec, type Fixture } from './fixtures';
import { planTransition } from './planTransition';
import { clipEnd, clipTrimHandles, getClip, transitionSpan } from './selectors';
import * as T from './time';
import type { Project } from './types';
import { assertValidProject } from './validate';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/** One frame at the fixture's 25 fps. */
const FRAME = T.time(1, 25);

/**
 * Two clips that each use their whole 10 s source, back to back — what dropping the
 * same file twice produces. Neither has a single spare frame.
 */
function wholeFiles(): Project {
  return run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(10), sourceIn: sec(0), name: 'A' }),
    insertCommand(f, { trackId: f.v1, start: sec(10), duration: sec(10), sourceIn: sec(0), name: 'B' }),
  );
}

function clips(p: Project): readonly { name: string; span: string; sourceIn: number }[] {
  return p.tracks[f.v1 as never]!.clipIds.map((id) => {
    const clip = getClip(p, id);
    return {
      name: clip.name,
      span: `${T.toSeconds(clip.start)}..${T.toSeconds(clipEnd(clip))}`,
      sourceIn: T.toSeconds((clip as { sourceIn: typeof FRAME }).sourceIn),
    };
  });
}

function plan(p: Project, duration = sec(1)) {
  const [a, b] = p.tracks[f.v1 as never]!.clipIds.map((id) => getClip(p, id));
  return planTransition(p, [{ from: a!, to: b! }], { duration, minimumClip: FRAME });
}

describe('when neither clip has a handle', () => {
  it('confirms the starting point: no spare frames at all', () => {
    const p = wholeFiles();
    const [a, b] = p.tracks[f.v1 as never]!.clipIds.map((id) => getClip(p, id));
    expect(T.toSeconds(clipTrimHandles(p, a!).tailroom!)).toBe(0);
    expect(T.toSeconds(clipTrimHandles(p, b!).headroom!)).toBe(0);
  });

  it('takes half the length off each side', () => {
    const result = plan(wholeFiles());
    expect(T.toSeconds(result.borrowedFromOutgoing)).toBe(0.5);
    expect(T.toSeconds(result.borrowedFromIncoming)).toBe(0.5);
    expect(T.toSeconds(result.shortenedBy)).toBe(1);
    expect(T.toSeconds(result.duration)).toBe(1);
  });

  it('leaves the track gapless and one second shorter', () => {
    const before = wholeFiles();
    const after = applyAll(before, plan(before).commands, f.ids);

    expect(clips(after)).toEqual([
      // A gives up its last half second, which becomes the tail the overlap reads.
      { name: 'A', span: '0..9.5', sourceIn: 0 },
      // B gives up its first half second and moves up to meet A.
      { name: 'B', span: '9.5..19', sourceIn: 0.5 },
    ]);
    assertValidProject(after);
  });

  it('produces a transition that actually fits the new handles', () => {
    const before = wholeFiles();
    const after = applyAll(before, plan(before).commands, f.ids);

    const transition = Object.values(after.transitions)[0]!;
    expect(T.toSeconds(transition.duration)).toBe(1);

    // Centred on the new cut at 9.5 s.
    const span = transitionSpan(after, transition)!;
    expect(T.toSeconds(span.start)).toBe(9);
    expect(T.toSeconds(T.rangeEnd(span))).toBe(10);

    // And both clips can now reach across it.
    const [a, b] = after.tracks[f.v1 as never]!.clipIds.map((id) => getClip(after, id));
    expect(T.toSeconds(clipTrimHandles(after, a!).tailroom!)).toBe(0.5);
    expect(T.toSeconds(clipTrimHandles(after, b!).headroom!)).toBe(0.5);
  });

  it('ripples everything downstream, not just the clip it touched', () => {
    // The 3 s asset used whole, so A and B really have nothing spare.
    const before = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(3), sourceIn: sec(0), assetId: f.shortAssetId, name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(3), duration: sec(3), sourceIn: sec(0), assetId: f.shortAssetId, name: 'B' }),
      insertCommand(f, { trackId: f.v1, start: sec(6), duration: sec(2), sourceIn: sec(0), name: 'C' }),
    );
    const after = applyAll(before, plan(before).commands, f.ids);
    const spans = clips(after).map((c) => c.span);

    // C never had a transition, but it moves up so no gap opens ahead of it.
    expect(spans).toEqual(['0..2.5', '2.5..5', '5..7']);
    assertValidProject(after);
  });
});

describe('when the handles are only partly short', () => {
  it('borrows just the shortfall', () => {
    // 2 s in from a 10 s source, using 4 s: 2 s of head, 4 s of tail.
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), sourceIn: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(4), sourceIn: sec(0), name: 'B' }),
    );
    // A 3 s centred dissolve wants 1.5 s each way. A has 4 s of tail — plenty. B has
    // no head at all, so it alone gives up the 1.5 s.
    const result = plan(p, sec(3));
    expect(T.toSeconds(result.borrowedFromOutgoing)).toBe(0);
    expect(T.toSeconds(result.borrowedFromIncoming)).toBe(1.5);
    expect(T.toSeconds(result.shortenedBy)).toBe(1.5);
  });

  it('borrows nothing when the handles already cover it', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), sourceIn: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(4), sourceIn: sec(2), name: 'B' }),
    );
    const result = plan(p, sec(1));
    expect(T.toSeconds(result.shortenedBy)).toBe(0);
    expect(result.commands).toHaveLength(1); // just the add
  });
});

describe('limits', () => {
  it('shortens the transition rather than consuming a clip', () => {
    // Two 1 s clips using their whole source: a 4 s dissolve is impossible, but a
    // shorter one is not.
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(1), sourceIn: sec(0), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(1), duration: sec(1), sourceIn: sec(0), name: 'B' }),
    );
    const result = plan(p, sec(4));
    expect(T.toSeconds(result.duration)).toBeLessThan(4);
    expect(T.isPositive(result.duration)).toBe(true);

    const after = applyAll(p, result.commands, f.ids);
    for (const clip of after.tracks[f.v1 as never]!.clipIds.map((id) => getClip(after, id))) {
      expect(T.isPositive(clip.duration)).toBe(true);
    }
    assertValidProject(after);
  });

  it('keeps picture and sound in step by borrowing the same from both', () => {
    // The audio stream is fractionally shorter than the video, so left to themselves
    // the two tracks would give up different amounts and drift apart.
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(6), sourceIn: sec(0), name: 'VA' }),
      insertCommand(f, { trackId: f.v1, start: sec(6), duration: sec(6), sourceIn: sec(0), name: 'VB' }),
      insertCommand(f, { trackId: f.a1, kind: 'audio', start: sec(0), duration: sec(6), sourceIn: sec(0), name: 'AA' }),
      insertCommand(f, { trackId: f.a1, kind: 'audio', start: sec(6), duration: sec(6), sourceIn: sec(0), name: 'AB' }),
    );
    const [va, vb] = p.tracks[f.v1 as never]!.clipIds.map((id) => getClip(p, id));
    const [aa, ab] = p.tracks[f.a1 as never]!.clipIds.map((id) => getClip(p, id));

    const result = planTransition(
      p,
      [{ from: va!, to: vb! }, { from: aa!, to: ab! }],
      { duration: sec(1), minimumClip: FRAME },
    );
    const after = applyAll(p, result.commands, f.ids);

    const cutOn = (trackId: string): number =>
      T.toSeconds(getClip(after, after.tracks[trackId as never]!.clipIds[1]!).start);
    expect(cutOn(f.v1)).toBe(cutOn(f.a1));
    assertValidProject(after);
  });
});
