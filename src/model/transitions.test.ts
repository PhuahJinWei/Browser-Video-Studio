/**
 * Transitions.
 *
 * The two things worth pinning down are the handle arithmetic — a dissolve is only
 * possible when both clips have unused source past their own cut — and the mix the
 * render list produces, which has to be a true cross-dissolve rather than two
 * independent fades.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import {
  activeTransitionAt,
  maxTransitionDuration,
  ModelError,
  renderListAt,
  transitionSpan,
  trackTransitions,
} from './selectors';
import * as T from './time';
import type { ClipId, Project, Transition } from './types';
import { assertValidProject } from './validate';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/**
 * Two adjacent 4 s clips on V1, each taking the middle of the 10 s asset so both
 * have a second of material to spare on either side.
 */
function adjacentPair(sourceIn = sec(2)): Project {
  return run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), sourceIn, name: 'A' }),
    insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(4), sourceIn, name: 'B' }),
  );
}

function clipIds(p: Project): readonly ClipId[] {
  return p.tracks[f.v1 as never]!.clipIds;
}

function addDissolve(p: Project, duration = sec(1)): Project {
  const [from, to] = clipIds(p);
  return runFrom(f, p, { type: 'addTransition', fromClipId: from!, toClipId: to!, duration });
}

function onlyTransition(p: Project): Transition {
  const all = Object.values(p.transitions);
  expect(all).toHaveLength(1);
  return all[0]!;
}

describe('adding', () => {
  it('straddles the cut, centred by default', () => {
    const p = addDissolve(adjacentPair());
    const t = onlyTransition(p);
    expect(t.transitionType).toBe('dissolve');
    expect(t.alignment).toBe('centered');
    expect(T.toSeconds(t.duration)).toBe(1);

    // Cut is at 4 s, so a 1 s centred dissolve runs 3.5 → 4.5.
    const span = transitionSpan(p, t)!;
    expect(T.toSeconds(span.start)).toBe(3.5);
    expect(T.toSeconds(T.rangeEnd(span))).toBe(4.5);
    assertValidProject(p);
  });

  it('is listed on its track and in its sequence', () => {
    const p = addDissolve(adjacentPair());
    const t = onlyTransition(p);
    expect(trackTransitions(p, f.v1).map((x) => x.id)).toEqual([t.id]);
    expect(p.sequences[f.seqId]!.transitionIds).toContain(t.id);
  });

  it('refuses two transitions on one cut', () => {
    const p = addDissolve(adjacentPair());
    expect(() => addDissolve(p)).toThrow(ModelError);
  });

  it('refuses clips that are not adjacent', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(5), duration: sec(2), name: 'B' }),
    );
    const [a, b] = clipIds(p);
    expect(() =>
      runFrom(f, p, { type: 'addTransition', fromClipId: a!, toClipId: b!, duration: sec(1) }),
    ).toThrow(ModelError);
  });

  it('refuses clips on different tracks', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
      insertCommand(f, { trackId: f.v2, start: sec(4), duration: sec(4), name: 'B' }),
    );
    const a = p.tracks[f.v1 as never]!.clipIds[0]!;
    const b = p.tracks[f.v2 as never]!.clipIds[0]!;
    expect(() =>
      runFrom(f, p, { type: 'addTransition', fromClipId: a, toClipId: b, duration: sec(1) }),
    ).toThrow(ModelError);
  });
});

describe('fitting to the available handles', () => {
  it('allows twice the smaller handle when centred', () => {
    // Both clips start 2 s into the asset and use 4 s of a 10 s source, so the
    // outgoing clip has 4 s of tail and the incoming one 2 s of head.
    const p = adjacentPair();
    const [a, b] = clipIds(p).map((id) => p.clips[id]!);
    // The incoming clip's 2 s of headroom is the binding constraint: 2 × 2 = 4 s.
    expect(T.toSeconds(maxTransitionDuration(p, a!, b!))).toBe(4);
  });

  it('shortens an over-long request instead of refusing it', () => {
    const p = addDissolve(adjacentPair(), sec(30));
    // Capped by the clips themselves (4 s each) rather than by the handles.
    expect(T.toSeconds(onlyTransition(p).duration)).toBe(4);
    assertValidProject(p);
  });

  it('refuses outright when the cut has no spare frames at all', () => {
    // Each clip consumes the asset from its very first frame to its very last,
    // so neither has anything to play past its own cut.
    const p = run(
      f,
      insertCommand(f, {
        trackId: f.v1,
        start: sec(0),
        duration: sec(3),
        sourceIn: sec(0),
        assetId: f.shortAssetId,
        name: 'A',
      }),
      insertCommand(f, {
        trackId: f.v1,
        start: sec(3),
        duration: sec(3),
        sourceIn: sec(0),
        assetId: f.shortAssetId,
        name: 'B',
      }),
    );
    const [a, b] = clipIds(p);
    // A has no tailroom and B no headroom, so a centred dissolve has nothing to use.
    expect(T.toSeconds(maxTransitionDuration(p, p.clips[a!]!, p.clips[b!]!))).toBe(0);
    expect(() =>
      runFrom(f, p, { type: 'addTransition', fromClipId: a!, toClipId: b!, duration: sec(1) }),
    ).toThrow(/no spare frames/);
  });

  it('needs only the outgoing clip when aligned to start after the cut', () => {
    const p = adjacentPair();
    const [a, b] = clipIds(p).map((id) => p.clips[id]!);
    // 'start' spends only the outgoing clip's 4 s tail.
    expect(T.toSeconds(maxTransitionDuration(p, a!, b!, 'start'))).toBe(4);
    // 'end' spends only the incoming clip's 2 s head.
    expect(T.toSeconds(maxTransitionDuration(p, a!, b!, 'end'))).toBe(2);
  });

  it('re-fits when the duration is changed later', () => {
    const p = addDissolve(adjacentPair());
    const grown = runFrom(f, p, {
      type: 'setTransitionDuration',
      transitionId: onlyTransition(p).id,
      duration: sec(60),
    });
    expect(T.toSeconds(onlyTransition(grown).duration)).toBe(4);
  });
});

describe('the mix it renders', () => {
  const at = (p: Project, seconds: number, den = 1): readonly { name: string; opacity: number }[] =>
    renderListAt(p, f.seqId, sec(seconds, den)).map((l) => ({
      name: l.clip.name,
      opacity: l.opacity,
    }));

  it('shows one clip either side of the transition', () => {
    const p = addDissolve(adjacentPair());
    expect(at(p, 2)).toEqual([{ name: 'A', opacity: 1 }]);
    expect(at(p, 6)).toEqual([{ name: 'B', opacity: 1 }]);
  });

  it('cross-dissolves rather than fading both out', () => {
    const p = addDissolve(adjacentPair());
    // Halfway through the 3.5 → 4.5 span. The outgoing clip stays fully opaque and
    // only the incoming one ramps: compositing B at 0.5 over an opaque A gives
    // 0.5·B + 0.5·A. Ramping both would give 0.5·B + 0.25·A — a dip to black.
    const mid = at(p, 4);
    expect(mid).toEqual([
      { name: 'A', opacity: 1 },
      { name: 'B', opacity: 0.5 },
    ]);
  });

  it('ramps the incoming clip from nothing to everything', () => {
    const p = addDissolve(adjacentPair());
    const opacityOfB = (seconds: number, den = 1): number | undefined =>
      at(p, seconds, den).find((l) => l.name === 'B')?.opacity;

    expect(opacityOfB(7, 2)).toBeCloseTo(0, 6); // 3.5 s — the very start
    expect(opacityOfB(15, 4)).toBeCloseTo(0.25, 6); // 3.75 s
    expect(opacityOfB(17, 4)).toBeCloseTo(0.75, 6); // 4.25 s
    // The span is half-open, so at 4.5 s the transition is over and B stands alone.
    expect(at(p, 9, 2)).toEqual([{ name: 'B', opacity: 1 }]);
  });

  it('keeps the outgoing clip on screen past its own out point', () => {
    const p = addDissolve(adjacentPair());
    // A ends at 4 s, but the dissolve runs to 4.5 s, so it must still be drawn —
    // reading a frame from the handle beyond its out point.
    const layers = renderListAt(p, f.seqId, sec(17, 4));
    const a = layers.find((l) => l.clip.name === 'A')!;
    expect(a).toBeDefined();
    // 4.25 s of timeline, 2 s in-point, so 6.25 s into the source.
    expect(T.toSeconds(a.sourceTime!)).toBe(6.25);
  });

  it('reports which transition is running', () => {
    const p = addDissolve(adjacentPair());
    expect(activeTransitionAt(p, f.v1, sec(2))).toBeNull();

    const active = activeTransitionAt(p, f.v1, sec(4))!;
    expect(active.from.name).toBe('A');
    expect(active.to.name).toBe('B');
    expect(active.progress).toBeCloseTo(0.5, 6);
  });
});

describe('staying consistent with the clips', () => {
  it('is dropped when the cut it spans is broken', () => {
    const p = addDissolve(adjacentPair());
    expect(Object.values(p.transitions)).toHaveLength(1);

    // Slide the incoming clip away so the two are no longer adjacent.
    const [, b] = clipIds(p);
    const moved = runFrom(f, p, {
      type: 'moveClips',
      moves: [{ clipId: b!, toTrackId: f.v1, toStart: sec(6) }],
    });
    expect(Object.values(moved.transitions)).toHaveLength(0);
    assertValidProject(moved);
  });

  it('is dropped when one of its clips is deleted', () => {
    const p = addDissolve(adjacentPair());
    const [a] = clipIds(p);
    const deleted = runFrom(f, p, { type: 'removeClips', clipIds: [a!] });
    expect(Object.values(deleted.transitions)).toHaveLength(0);
    assertValidProject(deleted);
  });

  it('can be removed on its own, leaving both clips alone', () => {
    const p = addDissolve(adjacentPair());
    const removed = runFrom(f, p, {
      type: 'removeTransition',
      transitionId: onlyTransition(p).id,
    });
    expect(Object.values(removed.transitions)).toHaveLength(0);
    expect(clipIds(removed)).toHaveLength(2);
    expect(removed.sequences[f.seqId]!.transitionIds).toHaveLength(0);
    assertValidProject(removed);
  });
});
