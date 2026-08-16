import { beforeEach, describe, expect, it } from 'vitest';
import { apply, applyAll } from './commands';
import { describeSources, describeTrack, insertCommand, makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import { keyframe, keyframedParam, staticParam } from './params';
import { getClip, getTrack, ModelError } from './selectors';
import * as T from './time';
import type { ClipId, Project, VideoClip } from './types';
import { assertValidProject, validateProject } from './validate';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/** Ids are sequential, so the nth clip created in a test is predictable. */
function clipsOf(p: Project, trackId: string): readonly ClipId[] {
  return p.tracks[trackId as never]!.clipIds;
}

describe('purity', () => {
  it('never mutates the input project', () => {
    const before = JSON.stringify(f.project);
    run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }));
    expect(JSON.stringify(f.project)).toBe(before);
  });

  it('shares structure with the previous version', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const p2 = apply(p1, { type: 'setView', sequenceId: f.seqId, view: { zoom: 200 } }, f.ids);
    // Only the sequences map changed; clips and tracks are the same objects.
    expect(p2.clips).toBe(p1.clips);
    expect(p2.tracks).toBe(p1.tracks);
    expect(p2.sequences).not.toBe(p1.sequences);
  });

  it('discards the whole batch when one command in it throws', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }));
    expect(() =>
      applyAll(
        p1,
        [
          insertCommand(f, { trackId: f.v1, start: sec(6), duration: sec(2), name: 'B' }),
          { type: 'removeTrack', trackId: 'tr_nope' as never },
        ],
        f.ids,
      ),
    ).toThrow(ModelError);
    expect(describeTrack(p1, f.v1)).toBe('A[0..4)');
  });
});

describe('tracks', () => {
  it('adds, names and orders tracks', () => {
    const p = run(f, { type: 'addTrack', sequenceId: f.seqId, kind: 'video', name: 'Overlay' });
    const seq = p.sequences[f.seqId]!;
    expect(seq.videoTrackIds).toHaveLength(3);
    expect(getTrack(p, seq.videoTrackIds[2]!).name).toBe('Overlay');
  });

  it('inserts at an index', () => {
    const p = run(f, { type: 'addTrack', sequenceId: f.seqId, kind: 'video', name: 'Mid', index: 1 });
    const seq = p.sequences[f.seqId]!;
    expect(getTrack(p, seq.videoTrackIds[1]!).name).toBe('Mid');
    expect(seq.videoTrackIds[0]).toBe(f.v1);
  });

  it('removes a track together with its clips', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    expect(Object.keys(p1.clips)).toHaveLength(1);
    const p2 = runFrom(f, p1, { type: 'removeTrack', trackId: f.v1 });
    expect(Object.keys(p2.clips)).toHaveLength(0);
    expect(p2.sequences[f.seqId]!.videoTrackIds).toEqual([f.v2]);
  });

  it('reorders within its own kind', () => {
    const p = run(f, { type: 'moveTrack', trackId: f.v1, toIndex: 1 });
    expect(p.sequences[f.seqId]!.videoTrackIds).toEqual([f.v2, f.v1]);
    expect(p.sequences[f.seqId]!.audioTrackIds).toEqual([f.a1]);
  });

  it('sets flags', () => {
    const p = run(f, { type: 'setTrackProps', trackId: f.a1, props: { muted: true, name: 'Music' } });
    expect(getTrack(p, f.a1).muted).toBe(true);
    expect(getTrack(p, f.a1).name).toBe('Music');
  });

  it('refuses to edit a locked track', () => {
    const p = run(f, { type: 'setTrackProps', trackId: f.v1, props: { locked: true } });
    expect(() =>
      apply(p, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }), f.ids),
    ).toThrow(/locked/);
  });
});

describe('insertClip', () => {
  it('rejects an audio clip on a video track and vice versa', () => {
    expect(() =>
      apply(f.project, insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(2) }), f.ids),
    ).toThrow(/cannot go on a audio track/);
    expect(() =>
      apply(
        f.project,
        insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), kind: 'audio' }),
        f.ids,
      ),
    ).toThrow(/cannot go on a video track/);
  });

  it('rejects a zero-length or negative-start clip', () => {
    expect(() =>
      apply(f.project, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(0) }), f.ids),
    ).toThrow(/non-positive duration/);
    expect(() =>
      apply(f.project, insertCommand(f, { trackId: f.v1, start: sec(-1), duration: sec(2) }), f.ids),
    ).toThrow(/before zero/);
  });

  it('overwrites an exactly covered clip', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'B' }),
    );
    expect(describeTrack(p, f.v1)).toBe('B[0..4)');
  });

  it('trims a clip it partially covers', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(3), duration: sec(3), name: 'B' }),
    );
    expect(describeTrack(p, f.v1)).toBe('A[0..3) B[3..6)');
  });

  it('trims the head of a clip it overlaps from the left', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(4), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(3), name: 'B' }),
    );
    expect(describeTrack(p, f.v1)).toBe('B[0..3) A[3..6)');
    // A now starts one second into its source, so the picture does not jump.
    expect(describeSources(p, f.v1)).toBe('B@0 A@1');
  });

  it('splits a clip when the new one lands inside it', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(8), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(3), duration: sec(2), name: 'B' }),
    );
    expect(describeTrack(p, f.v1)).toBe('A[0..3) B[3..5) A[5..8)');
    expect(describeSources(p, f.v1)).toBe('A@0 B@0 A@5');
  });

  it('ripples later clips in insert mode', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(2), name: 'B' }),
      insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(3), name: 'C', mode: 'insert' }),
    );
    expect(describeTrack(p, f.v1)).toBe('A[0..2) C[2..5) B[5..7)');
  });

  it('splits a straddled clip in insert mode', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(6), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(1), name: 'B', mode: 'insert' }),
    );
    expect(describeTrack(p, f.v1)).toBe('A[0..2) B[2..3) A[3..7)');
    expect(describeSources(p, f.v1)).toBe('A@0 B@0 A@2');
  });
});

describe('removeClips', () => {
  const three = (fx: Fixture) => [
    insertCommand(fx, { trackId: fx.v1, start: sec(0), duration: sec(2), name: 'A' }),
    insertCommand(fx, { trackId: fx.v1, start: sec(2), duration: sec(2), name: 'B' }),
    insertCommand(fx, { trackId: fx.v1, start: sec(4), duration: sec(2), name: 'C' }),
  ];

  it('lifts, leaving a gap', () => {
    const p1 = run(f, ...three(f));
    const b = clipsOf(p1, f.v1)[1]!;
    const p2 = runFrom(f, p1, { type: 'removeClips', clipIds: [b], mode: 'lift' });
    expect(describeTrack(p2, f.v1)).toBe('A[0..2) C[4..6)');
  });

  it('ripples, closing the gap', () => {
    const p1 = run(f, ...three(f));
    const b = clipsOf(p1, f.v1)[1]!;
    const p2 = runFrom(f, p1, { type: 'removeClips', clipIds: [b], mode: 'ripple' });
    expect(describeTrack(p2, f.v1)).toBe('A[0..2) C[2..4)');
  });

  it('ripples several removals with the right cumulative shift', () => {
    const p1 = run(f, ...three(f));
    const [a, b] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'removeClips', clipIds: [a!, b!], mode: 'ripple' });
    expect(describeTrack(p2, f.v1)).toBe('C[0..2)');
  });

  it('ignores ids that are already gone', () => {
    const p1 = run(f, ...three(f));
    const p2 = runFrom(f, p1, { type: 'removeClips', clipIds: ['cl_nope' as ClipId] });
    expect(describeTrack(p2, f.v1)).toBe('A[0..2) B[2..4) C[4..6)');
  });
});

describe('moveClips', () => {
  it('moves within a track and overwrites what it lands on', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2), name: 'B' }),
    );
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'moveClips',
      moves: [{ clipId: a!, toTrackId: f.v1, toStart: sec(5) }],
    });
    expect(describeTrack(p2, f.v1)).toBe('B[4..5) A[5..7)');
  });

  it('moves across tracks', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'moveClips',
      moves: [{ clipId: a!, toTrackId: f.v2, toStart: sec(1) }],
    });
    expect(describeTrack(p2, f.v1)).toBe('');
    expect(describeTrack(p2, f.v2)).toBe('A[1..3)');
    expect(getClip(p2, a!).trackId).toBe(f.v2);
  });

  it('clamps a drag past the start of the timeline', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2), name: 'A' }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'moveClips',
      moves: [{ clipId: a!, toTrackId: f.v1, toStart: sec(-3) }],
    });
    expect(describeTrack(p2, f.v1)).toBe('A[0..2)');
  });

  it('moves two clips at once without them eating each other', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(2), name: 'B' }),
    );
    const [a, b] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'moveClips',
      moves: [
        { clipId: a!, toTrackId: f.v1, toStart: sec(5) },
        { clipId: b!, toTrackId: f.v1, toStart: sec(7) },
      ],
    });
    expect(describeTrack(p2, f.v1)).toBe('A[5..7) B[7..9)');
  });

  it('rejects a move that stacks two moved clips on top of each other', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(2), name: 'B' }),
    );
    const [a, b] = clipsOf(p1, f.v1);
    expect(() =>
      apply(
        p1,
        {
          type: 'moveClips',
          moves: [
            { clipId: a!, toTrackId: f.v1, toStart: sec(5) },
            { clipId: b!, toTrackId: f.v1, toStart: sec(6) },
          ],
        },
        f.ids,
      ),
    ).toThrow(/overlap/);
  });

  it('refuses to move a clip onto an incompatible track', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }));
    const [a] = clipsOf(p1, f.v1);
    expect(() =>
      apply(p1, { type: 'moveClips', moves: [{ clipId: a!, toTrackId: f.a1, toStart: sec(0) }] }, f.ids),
    ).toThrow(/cannot go on a audio track/);
  });
});

describe('trimClip', () => {
  it('trims the out-point', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'trimClip', clipId: a!, edge: 'out', to: sec(3) });
    expect(describeTrack(p2, f.v1)).toBe('A[0..3)');
  });

  it('trims the in-point and advances the source to match', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'trimClip', clipId: a!, edge: 'in', to: sec(1) });
    expect(describeTrack(p2, f.v1)).toBe('A[1..4)');
    expect(describeSources(p2, f.v1)).toBe('A@1');
  });

  it('clamps the out-point to the available source', () => {
    // The asset is 10 s long, so a clip starting at source 0 cannot exceed 10 s.
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'trimClip', clipId: a!, edge: 'out', to: sec(30) });
    expect(describeTrack(p2, f.v1)).toBe('A[0..10)');
  });

  it('clamps the in-point to the available head', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(5), duration: sec(2), sourceIn: sec(1), name: 'A' }),
    );
    const [a] = clipsOf(p1, f.v1);
    // Only 1 s of head exists, so the in-point cannot move earlier than 4 s.
    const p2 = runFrom(f, p1, { type: 'trimClip', clipId: a!, edge: 'in', to: sec(0) });
    expect(describeTrack(p2, f.v1)).toBe('A[4..7)');
    expect(describeSources(p2, f.v1)).toBe('A@0');
  });

  it('never lets a trim push a clip before zero', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(1), duration: sec(2), sourceIn: sec(5), name: 'A' }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'trimClip', clipId: a!, edge: 'in', to: sec(-4) });
    expect(describeTrack(p2, f.v1)).toBe('A[0..3)');
  });

  it('rejects a trim that would empty the clip', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }));
    const [a] = clipsOf(p1, f.v1);
    expect(() =>
      apply(p1, { type: 'trimClip', clipId: a!, edge: 'out', to: sec(0) }, f.ids),
    ).toThrow(/non-positive duration/);
  });

  it('pulls the rest of the track along when rippling the out-point', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2), name: 'B' }),
    );
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'trimClip', clipId: a!, edge: 'out', to: sec(3), ripple: true });
    expect(describeTrack(p2, f.v1)).toBe('A[0..3) B[3..5)');
  });

  it('keeps the clip in place when rippling the in-point', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2), name: 'B' }),
    );
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'trimClip', clipId: a!, edge: 'in', to: sec(1), ripple: true });
    expect(describeTrack(p2, f.v1)).toBe('A[0..3) B[3..5)');
    expect(describeSources(p2, f.v1)).toBe('A@1 B@0');
  });
});

describe('slipClip', () => {
  it('changes the source without moving the clip', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(2), sourceIn: sec(3), name: 'A' }),
    );
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'slipClip', clipId: a!, by: sec(1) });
    expect(describeTrack(p2, f.v1)).toBe('A[2..4)');
    expect(describeSources(p2, f.v1)).toBe('A@4');
  });

  it('clamps against both ends of the source', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), sourceIn: sec(1), name: 'A' }),
    );
    const [a] = clipsOf(p1, f.v1);
    expect(describeSources(runFrom(f, p1, { type: 'slipClip', clipId: a!, by: sec(-9) }), f.v1)).toBe('A@0');
    expect(describeSources(runFrom(f, p1, { type: 'slipClip', clipId: a!, by: sec(99) }), f.v1)).toBe('A@8');
  });
});

describe('splitClips', () => {
  it('splits the clip under the playhead', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(6), name: 'A' }));
    const p2 = runFrom(f, p1, { type: 'splitClips', trackIds: [f.v1], at: sec(2) });
    expect(describeTrack(p2, f.v1)).toBe('A[0..2) A[2..6)');
    expect(describeSources(p2, f.v1)).toBe('A@0 A@2');
  });

  it('does nothing at a clip boundary or in a gap', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }));
    expect(describeTrack(runFrom(f, p1, { type: 'splitClips', trackIds: [f.v1], at: sec(2) }), f.v1)).toBe('A[0..2)');
    expect(describeTrack(runFrom(f, p1, { type: 'splitClips', trackIds: [f.v1], at: sec(5) }), f.v1)).toBe('A[0..2)');
    expect(describeTrack(runFrom(f, p1, { type: 'splitClips', trackIds: [f.v1], at: sec(0) }), f.v1)).toBe('A[0..2)');
  });

  it('splits across several tracks at once', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(6), name: 'V' }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(6), name: 'A', kind: 'audio' }),
    );
    const p2 = runFrom(f, p1, { type: 'splitClips', trackIds: [f.v1, f.a1], at: sec(3) });
    expect(describeTrack(p2, f.v1)).toBe('V[0..3) V[3..6)');
    expect(describeTrack(p2, f.a1)).toBe('A[0..3) A[3..6)');
  });

  it('keeps animation anchored to the same wall-clock time', () => {
    // Opacity ramps 0 -> 1 across a 4 s clip. After splitting at 2 s, the value at
    // any absolute time must be exactly what it was before the split.
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }));
    const [a] = clipsOf(p1, f.v1);
    const ramped: Project = {
      ...p1,
      clips: {
        ...p1.clips,
        [a!]: {
          ...(getClip(p1, a!) as VideoClip),
          opacity: keyframedParam([keyframe(T.TIME_ZERO, 0), keyframe(sec(4), 1)]),
        },
      },
    };

    const p2 = runFrom(f, ramped, { type: 'splitClips', trackIds: [f.v1], at: sec(2) });
    const [left, right] = clipsOf(p2, f.v1);
    const leftClip = getClip(p2, left!) as VideoClip;
    const rightClip = getClip(p2, right!) as VideoClip;

    const opacityAt = (clip: VideoClip, absolute: T.Time): number => {
      const rel = T.sub(absolute, clip.start);
      const param = clip.opacity;
      if (param.kind === 'static') return param.value;
      const kfs = param.keyframes;
      const first = kfs[0]!;
      const last = kfs[kfs.length - 1]!;
      const progress = T.ratio(T.sub(rel, first.at), T.sub(last.at, first.at));
      return first.value + (last.value - first.value) * progress;
    };

    expect(opacityAt(leftClip, sec(1))).toBeCloseTo(0.25, 10);
    expect(opacityAt(rightClip, sec(3))).toBeCloseTo(0.75, 10); // unchanged by the split
  });

  it('gives the right-hand half its own effect instances', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'addEffect',
      owner: { kind: 'clip', clipId: a! },
      effectType: 'blur.gaussian',
      params: { radius: staticParam(8) },
    });
    const p3 = runFrom(f, p2, { type: 'splitClips', trackIds: [f.v1], at: sec(2) });

    const [left, right] = clipsOf(p3, f.v1);
    const leftEffects = getClip(p3, left!).effects;
    const rightEffects = getClip(p3, right!).effects;
    expect(leftEffects).toHaveLength(1);
    expect(rightEffects).toHaveLength(1);
    expect(rightEffects[0]).not.toBe(leftEffects[0]); // cloned, not shared
    expect(p3.effects[rightEffects[0]!]!.effectType).toBe('blur.gaussian');
    expect(Object.keys(p3.effects)).toHaveLength(2);
  });
});

describe('effects', () => {
  it('adds, reorders and removes', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const [a] = clipsOf(p1, f.v1);
    const owner = { kind: 'clip', clipId: a! } as const;

    const p2 = runFrom(
      f,
      p1,
      { type: 'addEffect', owner, effectType: 'color.basic' },
      { type: 'addEffect', owner, effectType: 'blur.gaussian' },
    );
    const [first, second] = getClip(p2, a!).effects;
    expect(p2.effects[first!]!.effectType).toBe('color.basic');

    const p3 = runFrom(f, p2, { type: 'moveEffect', effectId: second!, toIndex: 0 });
    expect(getClip(p3, a!).effects[0]).toBe(second);

    const p4 = runFrom(f, p3, { type: 'removeEffect', effectId: second! });
    expect(getClip(p4, a!).effects).toEqual([first]);
    expect(p4.effects[second!]).toBeUndefined();
  });

  it('sets parameters and the enabled flag', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'addEffect',
      owner: { kind: 'clip', clipId: a! },
      effectType: 'blur.gaussian',
      params: { radius: staticParam(4) },
    });
    const [effectId] = getClip(p2, a!).effects;

    const p3 = runFrom(
      f,
      p2,
      { type: 'setEffectParam', effectId: effectId!, key: 'radius', param: staticParam(12) },
      { type: 'setEffectEnabled', effectId: effectId!, enabled: false },
    );
    expect(p3.effects[effectId!]!.params.radius).toEqual(staticParam(12));
    expect(p3.effects[effectId!]!.enabled).toBe(false);
  });

  it('drops a clip’s effects when the clip goes away', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'addEffect',
      owner: { kind: 'clip', clipId: a! },
      effectType: 'color.basic',
    });
    expect(Object.keys(p2.effects)).toHaveLength(1);
    const p3 = runFrom(f, p2, { type: 'removeClips', clipIds: [a!] });
    expect(Object.keys(p3.effects)).toHaveLength(0);
  });

  it('attaches to tracks too', () => {
    const p = run(f, {
      type: 'addEffect',
      owner: { kind: 'track', trackId: f.a1 },
      effectType: 'audio.compressor',
    });
    expect(getTrack(p, f.a1).effects).toHaveLength(1);
  });
});

describe('assets, markers and view', () => {
  it('refuses to remove an asset that is still in use', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }));
    expect(() => apply(p1, { type: 'removeAsset', assetId: f.assetId }, f.ids)).toThrow(/still used/);
  });

  it('removes an unused asset', () => {
    const p = run(f, { type: 'removeAsset', assetId: f.shortAssetId });
    expect(p.assets[f.shortAssetId]).toBeUndefined();
  });

  it('updates asset status', () => {
    const p = run(f, {
      type: 'setAssetStatus',
      assetId: f.assetId,
      status: { state: 'indexing', progress: 0.4 },
    });
    expect(p.assets[f.assetId]!.status).toEqual({ state: 'indexing', progress: 0.4 });
  });

  it('adds and removes markers', () => {
    const p1 = run(f, { type: 'addMarker', sequenceId: f.seqId, at: sec(3), name: 'Cut here' });
    const [markerId] = p1.sequences[f.seqId]!.markerIds;
    expect(p1.markers[markerId!]!.name).toBe('Cut here');
    const p2 = runFrom(f, p1, { type: 'removeMarker', markerId: markerId! });
    expect(p2.sequences[f.seqId]!.markerIds).toHaveLength(0);
    expect(Object.keys(p2.markers)).toHaveLength(0);
  });

  it('merges view updates', () => {
    const p = run(
      f,
      { type: 'setView', sequenceId: f.seqId, view: { playhead: sec(5) } },
      { type: 'setView', sequenceId: f.seqId, view: { zoom: 250 } },
    );
    expect(p.sequences[f.seqId]!.view.playhead).toEqual(sec(5));
    expect(p.sequences[f.seqId]!.view.zoom).toBe(250);
  });
});

describe('invariants hold after every edit', () => {
  it('survives a long mixed session', () => {
    let p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(6), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(6), duration: sec(4), name: 'B' }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(10), name: 'M', kind: 'audio' }),
      insertCommand(f, { trackId: f.v2, start: sec(2), duration: sec(3), name: 'Over' }),
    );
    p = runFrom(f, p, { type: 'splitClips', trackIds: [f.v1, f.a1], at: sec(3) });

    const v1Clips = clipsOf(p, f.v1);
    p = runFrom(f, p, { type: 'removeClips', clipIds: [v1Clips[1]!], mode: 'ripple' });
    p = runFrom(f, p, {
      type: 'moveClips',
      moves: [{ clipId: clipsOf(p, f.v2)[0]!, toTrackId: f.v2, toStart: sec(0) }],
    });
    p = runFrom(f, p, { type: 'trimClip', clipId: clipsOf(p, f.a1)[0]!, edge: 'out', to: sec(2) });

    expect(validateProject(p)).toEqual([]);
    expect(describeTrack(p, f.v1)).toBe('A[0..3) B[3..7)');
    expect(describeTrack(p, f.v2)).toBe('Over[0..3)');
    expect(describeTrack(p, f.a1)).toBe('M[0..2) M[3..10)');
  });

  it('detects a hand-corrupted document', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2), name: 'B' }),
    );
    const [a] = clipsOf(p1, f.v1);
    const overlapping: Project = {
      ...p1,
      clips: { ...p1.clips, [a!]: { ...getClip(p1, a!), duration: sec(6) } },
    };
    expect(validateProject(overlapping).map((v) => v.message)).toContain(
      '"A" overlaps "B" (or they are out of order)',
    );
    expect(() => assertValidProject(overlapping)).toThrow(/failed validation/);
  });
});
