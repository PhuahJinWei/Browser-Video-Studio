/**
 * Wipes and audio crossfades.
 *
 * The interesting cases are the ones where audio and video deliberately behave
 * differently: a wipe leaves the incoming picture fully opaque and masks it
 * spatially, while a crossfade has to reach past both clips' own edges and ramp
 * *both* sides, because audio sums where video composites.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import {
  audibleClipRange,
  audioSegments,
  DEFAULT_CROSSFADE_CURVE,
  DEFAULT_WIPE_SOFTNESS,
  ModelError,
  pairedCuts,
  renderListAt,
  transitionCurve,
  transitionSoftness,
  transitionSpan,
} from './selectors';
import * as T from './time';
import type { ClipId, Project, Transition } from './types';
import { assertValidProject } from './validate';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/** Two adjacent 4 s video clips on V1, each with a second of handle either side. */
function videoPair(): Project {
  return run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), sourceIn: sec(2), name: 'A' }),
    insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(4), sourceIn: sec(2), name: 'B' }),
  );
}

function clipIds(p: Project, trackId: string): readonly ClipId[] {
  return p.tracks[trackId as never]!.clipIds;
}

function addTransition(p: Project, trackId: string, transitionType?: string): Project {
  const [from, to] = clipIds(p, trackId);
  return runFrom(f, p, {
    type: 'addTransition',
    fromClipId: from!,
    toClipId: to!,
    duration: sec(2),
    ...(transitionType ? { transitionType } : {}),
  });
}

describe('wipes', () => {
  it('keeps the incoming clip opaque and masks it instead', () => {
    const p = addTransition(videoPair(), f.v1, 'wipe.right');
    const layers = renderListAt(p, f.seqId, sec(4));
    expect(layers).toHaveLength(2);

    const [outgoing, incoming] = layers;
    expect(outgoing!.opacity).toBe(1);
    expect(outgoing!.wipe).toBeNull();
    // A dissolve would put 0.5 here; a wipe reveals at full strength.
    expect(incoming!.opacity).toBe(1);
    expect(incoming!.wipe).toEqual({
      direction: 'right',
      progress: 0.5,
      softness: DEFAULT_WIPE_SOFTNESS,
    });
  });

  it('carries the direction through to the layer', () => {
    for (const [type, direction] of [
      ['wipe.left', 'left'],
      ['wipe.down', 'down'],
      ['wipe.up', 'up'],
      ['wipe.iris', 'iris'],
    ] as const) {
      const p = addTransition(videoPair(), f.v1, type);
      const layers = renderListAt(p, f.seqId, sec(4));
      expect(layers[1]!.wipe?.direction).toBe(direction);
    }
  });

  it('leaves a dissolve with no wipe at all', () => {
    const p = addTransition(videoPair(), f.v1);
    const layers = renderListAt(p, f.seqId, sec(4));
    expect(layers.every((l) => l.wipe === null)).toBe(true);
    expect(layers[1]!.opacity).toBeCloseTo(0.5, 6);
  });

  it('refuses a type it cannot draw, rather than silently dissolving', () => {
    expect(() => addTransition(videoPair(), f.v1, 'wipe.diagonal')).toThrow(ModelError);
  });
});

describe('audio crossfade', () => {
  /** Two adjacent 4 s audio clips on A1, both with handles. */
  function audioPair(): Project {
    return run(
      f,
      insertCommand(f, {
        trackId: f.a1, kind: 'audio', start: sec(0), duration: sec(4), sourceIn: sec(2), name: 'A',
      }),
      insertCommand(f, {
        trackId: f.a1, kind: 'audio', start: sec(4), duration: sec(4), sourceIn: sec(2), name: 'B',
      }),
    );
  }

  it('is allowed on an audio track', () => {
    const p = addTransition(audioPair(), f.a1);
    expect(Object.values(p.transitions)).toHaveLength(1);
    assertValidProject(p);
  });

  it('reaches past both clips into their handles', () => {
    const p = addTransition(audioPair(), f.a1);
    const [a, b] = clipIds(p, f.a1).map((id) => p.clips[id]!);

    // The cut is at 4 s and the transition spans 3 → 5.
    const outgoing = audibleClipRange(p, a!);
    expect(T.toSeconds(T.rangeEnd(outgoing.range))).toBe(5); // plays 1 s past its out point
    expect(outgoing.crossfadeOut).not.toBeNull();
    expect(outgoing.crossfadeIn).toBeNull();

    const incoming = audibleClipRange(p, b!);
    expect(T.toSeconds(incoming.range.start)).toBe(3); // starts 1 s before its in point
    expect(incoming.crossfadeIn).not.toBeNull();
    expect(incoming.crossfadeOut).toBeNull();
  });

  it('puts both clips in the mix during the overlap', () => {
    const p = addTransition(audioPair(), f.a1);
    // A 0.5 s window inside the transition: without the handles only B would be here.
    const segments = audioSegments(p, f.seqId, T.rangeFromBounds(sec(7, 2), sec(4)));
    expect(segments.map((s) => s.clip.name).sort()).toEqual(['A', 'B']);

    const outgoing = segments.find((s) => s.clip.name === 'A')!;
    expect(outgoing.crossfadeOut).not.toBeNull();
    // Reading past its out point: 2 s in-point + 3.5 s elapsed.
    expect(T.toSeconds(outgoing.sourceStart)).toBe(5.5);
  });

  it('leaves an ordinary cut with no crossfade marked', () => {
    const p = audioPair();
    const segments = audioSegments(p, f.seqId, T.rangeFromBounds(sec(0), sec(8)));
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.crossfadeIn === null && s.crossfadeOut === null)).toBe(true);
  });
});

describe('linked picture and sound', () => {
  /**
   * A video clip and its own audio, split down the middle so both tracks have the
   * same cut — exactly what dropping a clip and cutting it produces.
   */
  function linkedPair(): Project {
    const linkGroupId = 'lg_test';
    const p = run(
      f,
      {
        type: 'insertClip',
        trackId: f.v1,
        mode: 'overwrite',
        clip: { kind: 'video', assetId: f.assetId, start: sec(0), duration: sec(8), sourceIn: sec(1), linkGroupId },
      },
      {
        type: 'insertClip',
        trackId: f.a1,
        mode: 'overwrite',
        clip: { kind: 'audio', assetId: f.assetId, start: sec(0), duration: sec(8), sourceIn: sec(1), linkGroupId },
      },
    );
    return runFrom(f, p, { type: 'splitClips', trackIds: [f.v1, f.a1], at: sec(4) });
  }

  it('finds the sound cut underneath a picture cut', () => {
    const p = linkedPair();
    const [va, vb] = clipIds(p, f.v1).map((id) => p.clips[id]!);
    const cuts = pairedCuts(p, va!, vb!);

    expect(cuts).toHaveLength(2);
    const tracks = cuts.map((c) => c.from.trackId).sort();
    expect(tracks).toEqual([f.a1, f.v1].sort());
  });

  it('does not pair unrelated clips that merely sit next to each other', () => {
    const p = videoPair(); // no links at all
    const [a, b] = clipIds(p, f.v1).map((id) => p.clips[id]!);
    expect(pairedCuts(p, a!, b!)).toHaveLength(1);
  });

  it('crossfades the sound when the picture dissolves', () => {
    const p = linkedPair();
    const [va, vb] = clipIds(p, f.v1);

    // What the UI issues: one addTransition per paired cut, in a single batch.
    const cuts = pairedCuts(p, p.clips[va!]!, p.clips[vb!]!);
    const withTransitions = runFrom(
      f,
      p,
      ...cuts.map((cut) => ({
        type: 'addTransition' as const,
        fromClipId: cut.from.id,
        toClipId: cut.to.id,
        duration: sec(1),
      })),
    );

    const transitions = Object.values(withTransitions.transitions) as Transition[];
    expect(transitions).toHaveLength(2);
    expect(transitions.map((t) => t.trackId).sort()).toEqual([f.a1, f.v1].sort());

    // The picture blends...
    expect(renderListAt(withTransitions, f.seqId, sec(4))).toHaveLength(2);
    // ...and so does the sound, instead of cutting hard underneath it.
    const segments = audioSegments(withTransitions, f.seqId, T.rangeFromBounds(sec(0), sec(8)));
    expect(segments.filter((s) => s.crossfadeIn ?? s.crossfadeOut)).toHaveLength(2);
    assertValidProject(withTransitions);
  });
});

describe('alignment and softness', () => {
  it('re-fits the length when the overlap moves to one side of the cut', () => {
    // Centred, the 4 s tail and 2 s head each supply half, so 4 s fits.
    const p = addTransition(videoPair(), f.v1);
    expect(T.toSeconds(Object.values(p.transitions)[0]!.duration)).toBe(2);

    const grown = runFrom(f, p, {
      type: 'setTransitionDuration',
      transitionId: Object.values(p.transitions)[0]!.id,
      duration: sec(4),
    });
    expect(T.toSeconds(Object.values(grown.transitions)[0]!.duration)).toBe(4);

    // Wholly before the cut, only the incoming clip's 2 s head pays for it.
    const realigned = runFrom(f, grown, {
      type: 'setTransitionAlignment',
      transitionId: Object.values(grown.transitions)[0]!.id,
      alignment: 'end',
    });
    const t = Object.values(realigned.transitions)[0]!;
    expect(t.alignment).toBe('end');
    expect(T.toSeconds(t.duration)).toBe(2);
    assertValidProject(realigned);
  });

  it('moves the span to the right side of the cut', () => {
    const p = addTransition(videoPair(), f.v1);
    const id = Object.values(p.transitions)[0]!.id;

    // The cut is at 4 s and the transition is 2 s long.
    const centred = transitionSpan(p, Object.values(p.transitions)[0]!)!;
    expect(T.toSeconds(centred.start)).toBe(3);

    const atStart = runFrom(f, p, { type: 'setTransitionAlignment', transitionId: id, alignment: 'start' });
    const span = transitionSpan(atStart, Object.values(atStart.transitions)[0]!)!;
    expect(T.toSeconds(span.start)).toBe(4);
    expect(T.toSeconds(T.rangeEnd(span))).toBe(6);
  });

  it('defaults the wipe feather and carries an explicit one through', () => {
    const p = addTransition(videoPair(), f.v1, 'wipe.right');
    const id = Object.values(p.transitions)[0]!.id;
    expect(transitionSoftness(Object.values(p.transitions)[0]!)).toBe(DEFAULT_WIPE_SOFTNESS);

    const softened = runFrom(f, p, { type: 'setTransitionSoftness', transitionId: id, softness: 0.1 });
    expect(transitionSoftness(Object.values(softened.transitions)[0]!)).toBe(0.1);
    expect(renderListAt(softened, f.seqId, sec(4))[1]!.wipe?.softness).toBe(0.1);
  });

  it('clamps a nonsensical feather rather than refusing it', () => {
    const p = addTransition(videoPair(), f.v1, 'wipe.right');
    const id = Object.values(p.transitions)[0]!.id;
    const clamped = runFrom(f, p, { type: 'setTransitionSoftness', transitionId: id, softness: 5 });
    expect(transitionSoftness(Object.values(clamped.transitions)[0]!)).toBe(0.5);
  });
});

describe('crossfade curve', () => {
  function audioPairWithTransition(): Project {
    const p = run(
      f,
      insertCommand(f, {
        trackId: f.a1, kind: 'audio', start: sec(0), duration: sec(4), sourceIn: sec(2), name: 'A',
      }),
      insertCommand(f, {
        trackId: f.a1, kind: 'audio', start: sec(4), duration: sec(4), sourceIn: sec(2), name: 'B',
      }),
    );
    return addTransition(p, f.a1);
  }

  it('is constant power unless asked otherwise', () => {
    const p = audioPairWithTransition();
    expect(DEFAULT_CROSSFADE_CURVE).toBe('equal-power');
    expect(transitionCurve(Object.values(p.transitions)[0]!)).toBe('equal-power');
  });

  it('reaches the mixer through the segment, on both sides of the cut', () => {
    const p = audioPairWithTransition();
    const linear = runFrom(f, p, {
      type: 'setTransitionCurve',
      transitionId: Object.values(p.transitions)[0]!.id,
      curve: 'linear',
    });
    expect(transitionCurve(Object.values(linear.transitions)[0]!)).toBe('linear');

    const segments = audioSegments(linear, f.seqId, T.rangeFromBounds(sec(7, 2), sec(4)));
    const outgoing = segments.find((s) => s.clip.name === 'A')!;
    const incoming = segments.find((s) => s.clip.name === 'B')!;
    expect(outgoing.crossfadeOut?.curve).toBe('linear');
    expect(incoming.crossfadeIn?.curve).toBe('linear');
  });

  it('leaves the span alone when only the curve changes', () => {
    const p = audioPairWithTransition();
    const before = audibleClipRange(p, p.clips[p.tracks[f.a1 as never]!.clipIds[0]!]!);
    const linear = runFrom(f, p, {
      type: 'setTransitionCurve',
      transitionId: Object.values(p.transitions)[0]!.id,
      curve: 'linear',
    });
    const after = audibleClipRange(linear, linear.clips[linear.tracks[f.a1 as never]!.clipIds[0]!]!);
    expect(T.toSeconds(after.range.duration)).toBe(T.toSeconds(before.range.duration));
  });

  it('refuses a curve it does not have', () => {
    const p = audioPairWithTransition();
    expect(() =>
      runFrom(f, p, {
        type: 'setTransitionCurve',
        transitionId: Object.values(p.transitions)[0]!.id,
        curve: 's-curve' as never,
      }),
    ).toThrow(ModelError);
  });
});
