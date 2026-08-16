/**
 * Fades against black, and the rule that keeps transitions off each other.
 *
 * A one-sided transition is the same object with one end left empty. It never plays
 * a clip past its own edge, so it needs no handles and has no cut to align around —
 * only the clip's own length bounds it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import {
  activeTransitionAt,
  maxTransitionDuration,
  ModelError,
  renderListAt,
  transitionSpan,
} from './selectors';
import * as T from './time';
import type { ClipId, Project, Transition } from './types';
import { assertValidProject, validateProject } from './validate';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/** One 4 s clip on V1, taking the middle of the asset. */
function single(): Project {
  return run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), sourceIn: sec(2), name: 'A' }),
  );
}

function ids(p: Project): readonly ClipId[] {
  return p.tracks[f.v1 as never]!.clipIds;
}

function only(p: Project): Transition {
  const all = Object.values(p.transitions);
  expect(all).toHaveLength(1);
  return all[0]!;
}

describe('fading in from black', () => {
  it('sits at the head of the clip, with nothing on the far side', () => {
    const base = single();
    const p = runFrom(f, base, {
      type: 'addTransition',
      fromClipId: null,
      toClipId: ids(base)[0]!,
      duration: sec(1),
    });
    const t = only(p);
    expect(t.fromClipId).toBeNull();
    expect(t.toClipId).not.toBeNull();

    // Wholly inside the clip: a fade never reaches past an edge.
    const span = transitionSpan(p, t)!;
    expect(T.toSeconds(span.start)).toBe(0);
    expect(T.toSeconds(T.rangeEnd(span))).toBe(1);
    assertValidProject(p);
  });

  it('ramps the clip up from nothing', () => {
    const base = single();
    const p = runFrom(f, base, {
      type: 'addTransition', fromClipId: null, toClipId: ids(base)[0]!, duration: sec(2),
    });
    const opacityAt = (num: number, den = 1): number =>
      renderListAt(p, f.seqId, sec(num, den))[0]!.opacity;

    expect(opacityAt(0)).toBeCloseTo(0, 6);
    expect(opacityAt(1, 2)).toBeCloseTo(0.25, 6);
    expect(opacityAt(1)).toBeCloseTo(0.5, 6);
    expect(opacityAt(3, 2)).toBeCloseTo(0.75, 6);
    // Past the fade the clip stands at its own opacity again.
    expect(opacityAt(3)).toBe(1);
  });

  it('draws only the one clip — there is nothing to blend with', () => {
    const base = single();
    const p = runFrom(f, base, {
      type: 'addTransition', fromClipId: null, toClipId: ids(base)[0]!, duration: sec(2),
    });
    expect(renderListAt(p, f.seqId, sec(1))).toHaveLength(1);

    const active = activeTransitionAt(p, f.v1, sec(1))!;
    expect(active.from).toBeNull();
    expect(active.to?.name).toBe('A');
  });

  it('needs no handles, only the clip to be long enough', () => {
    const p = single();
    const clip = p.clips[ids(p)[0]!]!;
    // A dissolve here would be capped by the source either side; a fade is not.
    expect(T.toSeconds(maxTransitionDuration(p, null, clip))).toBe(4);
  });
});

describe('fading out to black', () => {
  it('sits at the tail of the clip', () => {
    const base = single();
    const p = runFrom(f, base, {
      type: 'addTransition', fromClipId: ids(base)[0]!, toClipId: null, duration: sec(1),
    });
    const span = transitionSpan(p, only(p))!;
    expect(T.toSeconds(span.start)).toBe(3);
    expect(T.toSeconds(T.rangeEnd(span))).toBe(4);
    assertValidProject(p);
  });

  it('ramps the clip down to nothing', () => {
    const base = single();
    const p = runFrom(f, base, {
      type: 'addTransition', fromClipId: ids(base)[0]!, toClipId: null, duration: sec(2),
    });
    const opacityAt = (num: number, den = 1): number =>
      renderListAt(p, f.seqId, sec(num, den))[0]!.opacity;

    expect(opacityAt(1)).toBe(1); // before it starts
    expect(opacityAt(2)).toBeCloseTo(1, 6);
    expect(opacityAt(3)).toBeCloseTo(0.5, 6);
    expect(opacityAt(7, 2)).toBeCloseTo(0.25, 6);
  });

  it('takes the picture away rather than bringing it in, when it is a wipe', () => {
    const base = single();
    const p = runFrom(f, base, {
      type: 'addTransition',
      fromClipId: ids(base)[0]!,
      toClipId: null,
      duration: sec(2),
      transitionType: 'wipe.right',
    });
    const layer = renderListAt(p, f.seqId, sec(3))[0]!;
    // Full opacity — the mask does the work — and inverted, so the edge hides.
    expect(layer.opacity).toBe(1);
    expect(layer.wipe?.hide).toBe(true);
    expect(layer.wipe?.direction).toBe('right');
  });
});

describe('refusals', () => {
  it('rejects a transition with black on both sides', () => {
    expect(() =>
      runFrom(f, single(), {
        type: 'addTransition', fromClipId: null, toClipId: null, duration: sec(1),
      }),
    ).toThrow(ModelError);
  });

  it('rejects a second fade on the same edge', () => {
    const base = single();
    const p = runFrom(f, base, {
      type: 'addTransition', fromClipId: null, toClipId: ids(base)[0]!, duration: sec(1),
    });
    expect(() =>
      runFrom(f, p, {
        type: 'addTransition', fromClipId: null, toClipId: ids(p)[0]!, duration: sec(1),
      }),
    ).toThrow(ModelError);
  });

  it('lets one clip have a fade at each end', () => {
    const base = single();
    const p = runFrom(
      f,
      base,
      { type: 'addTransition', fromClipId: null, toClipId: ids(base)[0]!, duration: sec(1) },
      { type: 'addTransition', fromClipId: ids(base)[0]!, toClipId: null, duration: sec(1) },
    );
    expect(Object.values(p.transitions)).toHaveLength(2);
    assertValidProject(p);
  });
});

describe('transitions keeping out of each other', () => {
  /** A, B and C in a row, each 4 s with handles either side. */
  function three(): Project {
    return run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), sourceIn: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(4), sourceIn: sec(2), name: 'B' }),
      insertCommand(f, { trackId: f.v1, start: sec(8), duration: sec(4), sourceIn: sec(2), name: 'C' }),
    );
  }

  it('shortens a second transition rather than letting the spans overlap', () => {
    const p = three();
    const [a, b, c] = ids(p);
    // 4 s centred on the cut at 4 s occupies 2 → 6.
    const first = runFrom(f, p, {
      type: 'addTransition', fromClipId: a!, toClipId: b!, duration: sec(4),
    });
    expect(T.toSeconds(Object.values(first.transitions)[0]!.duration)).toBe(4);

    // 4 s centred on the cut at 8 s would want 6 → 10, which touches but does not
    // overlap. Ask for more and it is trimmed back to what is free.
    const second = runFrom(f, first, {
      type: 'addTransition', fromClipId: b!, toClipId: c!, duration: sec(4),
    });
    const spans = Object.values(second.transitions).map((t) => transitionSpan(second, t)!);
    expect(spans).toHaveLength(2);
    expect(T.toSeconds(T.rangeEnd(spans[0]!))).toBeLessThanOrEqual(T.toSeconds(spans[1]!.start));
    assertValidProject(second);
  });

  it('will not let an alignment change push one transition into another', () => {
    const p = three();
    const [a, b, c] = ids(p);
    const both = runFrom(
      f,
      p,
      { type: 'addTransition', fromClipId: a!, toClipId: b!, duration: sec(4) },
      { type: 'addTransition', fromClipId: b!, toClipId: c!, duration: sec(4) },
    );

    // This is the shape that used to render clip C not at all: both spans 4 → 8.
    const [first, second] = Object.values(both.transitions);
    const moved = runFrom(
      f,
      both,
      { type: 'setTransitionAlignment', transitionId: first!.id, alignment: 'start' },
      { type: 'setTransitionAlignment', transitionId: second!.id, alignment: 'end' },
    );

    const spans = Object.values(moved.transitions).map((t) => transitionSpan(moved, t)!);
    const overlap =
      T.toSeconds(spans[0]!.start) < T.toSeconds(T.rangeEnd(spans[1]!)) &&
      T.toSeconds(spans[1]!.start) < T.toSeconds(T.rangeEnd(spans[0]!));
    expect(overlap).toBe(false);
    assertValidProject(moved);
  });

  it('is reported by validation if it somehow happens anyway', () => {
    const p = three();
    const [a, b, c] = ids(p);
    const both = runFrom(
      f,
      p,
      { type: 'addTransition', fromClipId: a!, toClipId: b!, duration: sec(2) },
      { type: 'addTransition', fromClipId: b!, toClipId: c!, duration: sec(2) },
    );

    // Force the overlap past the commands, the way a corrupt file would.
    const [first, second] = Object.values(both.transitions);
    const corrupt: Project = {
      ...both,
      transitions: {
        ...both.transitions,
        [first!.id]: { ...first!, alignment: 'start', duration: sec(4) },
        [second!.id]: { ...second!, alignment: 'end', duration: sec(4) },
      },
    };
    const problems = validateProject(corrupt);
    expect(problems.some((issue) => /Overlaps transition/.test(issue.message))).toBe(true);
  });
});
