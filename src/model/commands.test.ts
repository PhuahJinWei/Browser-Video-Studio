import { beforeEach, describe, expect, it } from 'vitest';
import { apply, applyAll } from './commands';
import { describeSources, describeTrack, insertCommand, makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import { keyframe, keyframedParam, staticParam } from './params';
import { getClip, getTrack, ModelError } from './selectors';
import * as T from './time';
import type { AudioClip, ClipId, Project, TitleClip, VideoClip } from './types';
import { assertValidProject, validateProject } from './validate';
import { DEFAULT_TRACK_HEIGHT } from './factories';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/** Ids are sequential, so the nth clip created in a test is predictable. */
function clipsOf(p: Project, trackId: string): readonly ClipId[] {
  return p.tracks[trackId as never]!.clipIds;
}

describe('purity', () => {
  it('changes the project proxy policy through the command layer', () => {
    const next = apply(f.project, { type: 'setProjectProxyMode', mode: 'always' }, f.ids);
    expect(next.settings.proxyMode).toBe('always');
    expect(f.project.settings.proxyMode).toBe('auto');
    expect(validateProject(next)).toEqual([]);
  });

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

  /*
   * Height is set in bulk by a slider that reads as a view control, so a lane added
   * after that arrives among lanes whose height the person has already chosen.
   */
  it('gives a new track the height of the lanes it joins', () => {
    const shortened = run(
      f,
      { type: 'setTrackProps', trackId: f.v1, props: { height: 55 } },
      { type: 'setTrackProps', trackId: f.v2, props: { height: 55 } },
      { type: 'addTrack', sequenceId: f.seqId, kind: 'video', name: 'V3' },
    );
    const seq = shortened.sequences[f.seqId]!;
    expect(getTrack(shortened, seq.videoTrackIds[2]!).height).toBe(55);
  });

  it('measures each kind against its own lanes', () => {
    const mixed = run(
      f,
      { type: 'setTrackProps', trackId: f.v1, props: { height: 55 } },
      { type: 'setTrackProps', trackId: f.v2, props: { height: 55 } },
      { type: 'setTrackProps', trackId: f.a1, props: { height: 140 } },
      { type: 'addTrack', sequenceId: f.seqId, kind: 'audio', name: 'A2' },
    );
    const seq = mixed.sequences[f.seqId]!;
    expect(getTrack(mixed, seq.audioTrackIds[1]!).height).toBe(140);
  });

  it('still uses the default for a sequence whose lanes were never resized', () => {
    const p = run(f, { type: 'addTrack', sequenceId: f.seqId, kind: 'video', name: 'V3' });
    const seq = p.sequences[f.seqId]!;
    expect(getTrack(p, seq.videoTrackIds[2]!).height).toBe(DEFAULT_TRACK_HEIGHT);
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
  it('refuses by default to drop a clip on top of another', () => {
    // Landing on a clip must not silently resize it — resizing is a trim, and
    // trims are an explicit gesture.
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2), name: 'B' }),
    );
    const [a] = clipsOf(p1, f.v1);
    expect(() =>
      apply(p1, { type: 'moveClips', moves: [{ clipId: a!, toTrackId: f.v1, toStart: sec(5) }] }, f.ids),
    ).toThrow(/would overlap/);
    // The document is untouched by the rejected move.
    expect(describeTrack(p1, f.v1)).toBe('A[0..2) B[4..6)');
  });

  it('allows a move into a clear gap', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(6), duration: sec(2), name: 'B' }),
    );
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'moveClips',
      moves: [{ clipId: a!, toTrackId: f.v1, toStart: sec(3) }],
    });
    expect(describeTrack(p2, f.v1)).toBe('A[3..5) B[6..8)');
  });

  it('still overwrites when asked explicitly', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2), name: 'B' }),
    );
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'moveClips',
      mode: 'overwrite',
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

  it('gives each side of the cut its own link group', () => {
    // A video clip and its own audio are linked so they drag together. After a
    // split, the halves on each side of the cut must be independent, or dragging
    // one half drags the other and the cut is useless.
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(6), name: 'V' }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(6), kind: 'audio', name: 'A' }),
    );
    const link = 'lg_original';
    const linked: Project = {
      ...p1,
      clips: Object.fromEntries(
        Object.entries(p1.clips).map(([id, clip]) => [id, { ...clip, linkGroupId: link }]),
      ) as Project['clips'],
    };

    const p2 = runFrom(f, linked, { type: 'splitClips', trackIds: [f.v1, f.a1], at: sec(3) });
    const [leftV, rightV] = clipsOf(p2, f.v1).map((id) => getClip(p2, id));
    const [leftA, rightA] = clipsOf(p2, f.a1).map((id) => getClip(p2, id));

    // Left halves keep the original group; right halves share a new one.
    expect(leftV!.linkGroupId).toBe(link);
    expect(leftA!.linkGroupId).toBe(link);
    expect(rightV!.linkGroupId).not.toBe(link);
    expect(rightV!.linkGroupId).not.toBeNull();
    // Video and audio on the right of the cut stay linked to each other.
    expect(rightA!.linkGroupId).toBe(rightV!.linkGroupId);
  });

  it('unlinks and relinks clips', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'V' }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(4), kind: 'audio', name: 'A' }),
    );
    const v = clipsOf(p1, f.v1)[0]!;
    const a = clipsOf(p1, f.a1)[0]!;

    const linked = runFrom(f, p1, { type: 'linkClips', clipIds: [v, a] });
    expect(getClip(linked, v).linkGroupId).toBe(getClip(linked, a).linkGroupId);
    expect(getClip(linked, v).linkGroupId).not.toBeNull();

    // Detaching one end detaches everything in that group.
    const detached = runFrom(f, linked, { type: 'unlinkClips', clipIds: [v] });
    expect(getClip(detached, v).linkGroupId).toBeNull();
    expect(getClip(detached, a).linkGroupId).toBeNull();
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

describe('animatable clip properties', () => {
  it('sets opacity and transform channels on a visual clip', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(
      f,
      p1,
      { type: 'setClipParam', clipId: a!, key: 'opacity', param: staticParam(0.5) },
      { type: 'setClipParam', clipId: a!, key: 'transform.x', param: staticParam(120) },
      { type: 'setClipParam', clipId: a!, key: 'transform.rotation', param: staticParam(-15) },
      { type: 'setClipParam', clipId: a!, key: 'crop.left', param: staticParam(0.25) },
    );
    const clip = getClip(p2, a!) as VideoClip;
    expect(clip.opacity).toEqual(staticParam(0.5));
    expect(clip.transform.x).toEqual(staticParam(120));
    expect(clip.transform.rotation).toEqual(staticParam(-15));
    expect(clip.crop.left).toEqual(staticParam(0.25));
    // Untouched channels keep their defaults.
    expect(clip.transform.scaleX).toEqual(staticParam(1));
  });

  it('accepts a keyframed parameter', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const [a] = clipsOf(p1, f.v1);
    const ramp = keyframedParam([keyframe(T.TIME_ZERO, 0), keyframe(sec(4), 1)]);
    const p2 = runFrom(f, p1, { type: 'setClipParam', clipId: a!, key: 'opacity', param: ramp });
    expect((getClip(p2, a!) as VideoClip).opacity.kind).toBe('keyframed');
  });

  it('rejects parameters the clip kind does not have', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'V' }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(2), kind: 'audio', name: 'A' }),
    );
    const [video] = clipsOf(p1, f.v1);
    const [audio] = clipsOf(p1, f.a1);

    expect(() =>
      apply(p1, { type: 'setClipParam', clipId: video!, key: 'gainDb', param: staticParam(-6) }, f.ids),
    ).toThrow(/no parameter/);
    expect(() =>
      apply(p1, { type: 'setClipParam', clipId: audio!, key: 'opacity', param: staticParam(0.5) }, f.ids),
    ).toThrow(/no parameter/);
    expect(() =>
      apply(p1, { type: 'setClipBlendMode', clipId: audio!, blendMode: 'screen' }, f.ids),
    ).toThrow(/no blend mode/);
  });

  it('sets audio gain, pan and fades', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(4), kind: 'audio', name: 'A' }),
    );
    const [a] = clipsOf(p1, f.a1);
    const p2 = runFrom(
      f,
      p1,
      { type: 'setClipParam', clipId: a!, key: 'gainDb', param: staticParam(-6) },
      { type: 'setClipParam', clipId: a!, key: 'pan', param: staticParam(-0.5) },
      { type: 'setClipFade', clipId: a!, edge: 'in', duration: sec(1, 2) },
      { type: 'setClipFade', clipId: a!, edge: 'out', duration: sec(1) },
    );
    const clip = getClip(p2, a!) as AudioClip;
    expect(clip.gainDb).toEqual(staticParam(-6));
    expect(clip.pan).toEqual(staticParam(-0.5));
    expect(clip.fadeIn).toEqual(sec(1, 2));
    expect(clip.fadeOut).toEqual(sec(1));
  });

  it('clamps a fade to the clip length and rejects a negative one', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(2), kind: 'audio', name: 'A' }),
    );
    const [a] = clipsOf(p1, f.a1);
    const p2 = runFrom(f, p1, { type: 'setClipFade', clipId: a!, edge: 'in', duration: sec(30) });
    expect((getClip(p2, a!) as AudioClip).fadeIn).toEqual(sec(2));
    expect(() =>
      apply(p1, { type: 'setClipFade', clipId: a!, edge: 'in', duration: sec(-1) }, f.ids),
    ).toThrow(/negative/);
  });

  it('sets blend mode and speed', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(
      f,
      p1,
      { type: 'setClipBlendMode', clipId: a!, blendMode: 'screen' },
      { type: 'setClipSpeed', clipId: a!, speed: 2 },
    );
    expect((getClip(p2, a!) as VideoClip).blendMode).toBe('screen');
    expect((getClip(p2, a!) as VideoClip).speed).toBe(2);

    for (const bad of [0, Infinity, NaN]) {
      expect(() => apply(p2, { type: 'setClipSpeed', clipId: a!, speed: bad }, f.ids)).toThrow(
        /finite and non-zero/,
      );
    }
  });

  it('sets a positive speed ramp and protects source bounds', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }));
    const [clipId] = clipsOf(p1, f.v1);
    const ramp = keyframedParam([keyframe(T.TIME_ZERO, 1), keyframe(sec(4), 2)]);
    const p2 = runFrom(f, p1, { type: 'setClipSpeedRamp', clipId: clipId!, param: ramp });
    expect((getClip(p2, clipId!) as VideoClip).speedRamp).toEqual(ramp);

    expect(() => apply(p1, {
      type: 'setClipSpeedRamp',
      clipId: clipId!,
      param: staticParam(-1),
    }, f.ids)).toThrow(/greater than zero/);
    expect(() => apply(p1, {
      type: 'setClipSpeedRamp',
      clipId: clipId!,
      param: staticParam(4),
    }, f.ids)).toThrow(/end of the source/);
  });
  it('edits title copy and typography without replacing the clip', () => {
    const p1 = run(f, {
      type: 'insertClip',
      trackId: f.v1,
      mode: 'overwrite',
      clip: { kind: 'title', start: sec(0), duration: sec(3), text: 'Before' },
    });
    const [clipId] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, {
      type: 'setTitleProps',
      clipId: clipId!,
      text: 'After',
      style: { fontSizePx: 96, fontWeight: 700, align: 'left', color: '#ffcc00' },
    });
    const title = getClip(p2, clipId!) as TitleClip;
    expect(title.text).toBe('After');
    expect(title.style).toMatchObject({ fontSizePx: 96, fontWeight: 700, align: 'left', color: '#ffcc00' });
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

  it('replaces an asset in place so clips keep their source reference', () => {
    const withClip = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }));
    const original = withClip.assets[f.assetId]!;
    const replacement = {
      ...original,
      source: {
        fileName: 'relinked.mp4',
        byteLength: 123,
        mimeType: 'video/mp4',
        opfsPath: null,
        hasFileHandle: false,
        contentHash: null,
      },
      status: { state: 'ready' as const },
    };
    const p = apply(
      withClip,
      { type: 'replaceAsset', assetId: f.assetId, asset: replacement },
      f.ids,
    );
    expect(p.assets[f.assetId]!.source?.fileName).toBe('relinked.mp4');
    expect(Object.values(p.clips).some((clip) => 'assetId' in clip && clip.assetId === f.assetId)).toBe(true);
  });

  it('refuses a replacement whose id does not match its slot', () => {
    const original = f.project.assets[f.assetId]!;
    expect(() =>
      apply(
        f.project,
        { type: 'replaceAsset', assetId: f.assetId, asset: { ...original, id: f.shortAssetId } },
        f.ids,
      ),
    ).toThrow(/cannot change an asset id/);
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
