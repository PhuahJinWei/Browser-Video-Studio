import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import { keyframe, keyframedParam, staticParam } from './params';
import {
  audibleTrackIds,
  audioSegments,
  clipAt,
  clipEnd,
  clipSourceTimeAt,
  clipsInRange,
  clipTrimHandles,
  findSnap,
  gapAt,
  getClip,
  isAudioClip,
  isMediaClip,
  isVisualClip,
  ModelError,
  renderListAt,
  sequenceDuration,
  snapPoints,
  trackClips,
  trackDuration,
  visibleTrackIds,
} from './selectors';
import * as T from './time';
import type { AudioClip, ClipId, Project, VideoClip } from './types';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

function clipIds(p: Project, trackId: string): readonly ClipId[] {
  return p.tracks[trackId as never]!.clipIds;
}

/** V1: A[0..4) B[6..10). A1: M[0..10). V2: empty. */
function laidOut(): Project {
  return run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
    insertCommand(f, { trackId: f.v1, start: sec(6), duration: sec(4), name: 'B' }),
    insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(10), name: 'M', kind: 'audio' }),
  );
}

describe('entity lookup', () => {
  it('throws a helpful error for a missing id', () => {
    expect(() => getClip(f.project, 'cl_nope' as ClipId)).toThrow(ModelError);
    expect(() => getClip(f.project, 'cl_nope' as ClipId)).toThrow('No clip with id "cl_nope"');
  });
});

describe('clip kinds', () => {
  it('classifies clips', () => {
    const p = laidOut();
    const video = getClip(p, clipIds(p, f.v1)[0]!);
    const audio = getClip(p, clipIds(p, f.a1)[0]!);
    expect(isMediaClip(video)).toBe(true);
    expect(isVisualClip(video)).toBe(true);
    expect(isAudioClip(video)).toBe(false);
    expect(isVisualClip(audio)).toBe(false);
    expect(isAudioClip(audio)).toBe(true);
  });
});

describe('track queries', () => {
  it('returns clips in timeline order', () => {
    const p = laidOut();
    expect(trackClips(p, f.v1).map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('finds the clip at an instant, half-open', () => {
    const p = laidOut();
    expect(clipAt(p, f.v1, sec(0))?.name).toBe('A');
    expect(clipAt(p, f.v1, sec(3))?.name).toBe('A');
    expect(clipAt(p, f.v1, sec(4))).toBeNull(); // end is exclusive
    expect(clipAt(p, f.v1, sec(5))).toBeNull(); // in the gap
    expect(clipAt(p, f.v1, sec(6))?.name).toBe('B');
    expect(clipAt(p, f.v1, sec(10))).toBeNull();
  });

  it('finds clips overlapping a range', () => {
    const p = laidOut();
    const inRange = (start: number, dur: number) =>
      clipsInRange(p, f.v1, T.range(sec(start), sec(dur))).map((c) => c.name);
    expect(inRange(0, 12)).toEqual(['A', 'B']);
    expect(inRange(4, 2)).toEqual([]); // exactly the gap
    expect(inRange(3, 4)).toEqual(['A', 'B']);
    expect(inRange(0, 4)).toEqual(['A']); // touching B's start does not count
  });

  it('describes gaps', () => {
    const p = laidOut();
    expect(gapAt(p, f.v1, sec(5))).toEqual(T.range(sec(4), sec(2)));
    expect(gapAt(p, f.v1, sec(1))).toBeNull(); // inside a clip
    expect(gapAt(p, f.v1, sec(20))).toBeNull(); // past the end is not a gap
  });

  it('measures durations', () => {
    const p = laidOut();
    expect(trackDuration(p, f.v1)).toEqual(sec(10));
    expect(trackDuration(p, f.v2)).toEqual(T.TIME_ZERO);
    expect(sequenceDuration(p, f.seqId)).toEqual(sec(10));
    expect(sequenceDuration(f.project, f.seqId)).toEqual(T.TIME_ZERO);
  });
});

describe('clip source mapping', () => {
  it('maps timeline time to source time at normal speed', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(4), sourceIn: sec(1), name: 'A' }),
    );
    const clip = getClip(p, clipIds(p, f.v1)[0]!) as VideoClip;
    expect(clipSourceTimeAt(clip, sec(2))).toEqual(sec(1));
    expect(clipSourceTimeAt(clip, sec(4))).toEqual(sec(3));
    expect(clipEnd(clip)).toEqual(sec(6));
  });

  it('accounts for speed', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), speed: 2, name: 'Fast' }),
    );
    const clip = getClip(p, clipIds(p, f.v1)[0]!) as VideoClip;
    // Two seconds of timeline consume four seconds of source.
    expect(clipSourceTimeAt(clip, sec(1))).toEqual(sec(2));
    expect(clipSourceTimeAt(clip, sec(2))).toEqual(sec(4));
  });

  it('integrates a variable-speed ramp into source time', () => {
    const inserted = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'Ramp' }),
    );
    const clipId = clipIds(inserted, f.v1)[0]!;
    const p = runFrom(f, inserted, {
      type: 'setClipSpeedRamp',
      clipId,
      param: keyframedParam([keyframe(T.TIME_ZERO, 1), keyframe(sec(2), 3)]),
    });
    const clip = getClip(p, clipId) as VideoClip;
    expect(T.toSeconds(clipSourceTimeAt(clip, sec(1)))).toBeCloseTo(1.5, 5);
    expect(T.toSeconds(clipSourceTimeAt(clip, sec(2)))).toBeCloseTo(4, 5);
  });

  it('reports trim handles against the asset duration', () => {
    // The asset is 10 s; this clip uses 4 s starting 1 s in.
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), sourceIn: sec(1), name: 'A' }),
    );
    const clip = getClip(p, clipIds(p, f.v1)[0]!);
    expect(clipTrimHandles(p, clip)).toEqual({ headroom: sec(1), tailroom: sec(5) });
  });

  it('reports unbounded handles for a still image', () => {
    const p = laidOut();
    const clip = getClip(p, clipIds(p, f.v1)[0]!);
    const asStill = { ...clip, kind: 'image' as const } as VideoClip;
    expect(clipTrimHandles(p, asStill)).toEqual({ headroom: null, tailroom: null });
  });
});

describe('renderListAt', () => {
  it('returns layers bottom to top', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'Under' }),
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(4), name: 'Over' }),
    );
    expect(renderListAt(p, f.seqId, sec(1)).map((l) => l.clip.name)).toEqual(['Under', 'Over']);
  });

  it('skips hidden tracks and disabled clips', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'Under' }),
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(4), name: 'Over' }),
    );
    const hidden = runFrom(f, p1, { type: 'setTrackProps', trackId: f.v2, props: { hidden: true } });
    expect(renderListAt(hidden, f.seqId, sec(1)).map((l) => l.clip.name)).toEqual(['Under']);
    expect(visibleTrackIds(hidden, f.seqId)).toEqual([f.v1]);

    const disabled = runFrom(f, p1, {
      type: 'setClipProps',
      clipId: clipIds(p1, f.v1)[0]!,
      props: { enabled: false },
    });
    expect(renderListAt(disabled, f.seqId, sec(1)).map((l) => l.clip.name)).toEqual(['Over']);
  });

  it('does not scan audio tracks', () => {
    // V1 has A[0..4) and A1 has M[0..10); only the video clip may appear.
    const p = laidOut();
    expect(renderListAt(p, f.seqId, sec(1)).map((l) => l.clip.name)).toEqual(['A']);
  });

  it('evaluates animation at clip-relative time', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(4), name: 'A' }));
    const id = clipIds(p1, f.v1)[0]!;
    const animated: Project = {
      ...p1,
      clips: {
        ...p1.clips,
        [id]: {
          ...(getClip(p1, id) as VideoClip),
          opacity: keyframedParam([keyframe(T.TIME_ZERO, 0), keyframe(sec(4), 1)]),
        },
      },
    };
    // Absolute 3 s is 1 s into the clip, i.e. a quarter of the way along the ramp.
    expect(renderListAt(animated, f.seqId, sec(3))[0]!.opacity).toBeCloseTo(0.25, 10);
    expect(renderListAt(animated, f.seqId, sec(2))[0]!.opacity).toBe(0);
  });

  it('carries the source time to decode', () => {
    const p = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(2), duration: sec(4), sourceIn: sec(3), name: 'A' }),
    );
    expect(renderListAt(p, f.seqId, sec(4))[0]!.sourceTime).toEqual(sec(5));
  });

  it('excludes disabled effects but keeps enabled ones, clip then track', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }));
    const clipId = clipIds(p1, f.v1)[0]!;
    const p2 = runFrom(
      f,
      p1,
      { type: 'addEffect', owner: { kind: 'clip', clipId }, effectType: 'color.basic' },
      { type: 'addEffect', owner: { kind: 'clip', clipId }, effectType: 'blur.gaussian' },
      { type: 'addEffect', owner: { kind: 'track', trackId: f.v1 }, effectType: 'color.lut' },
    );
    const disabledId = getClip(p2, clipId).effects[1]!;
    const p3 = runFrom(f, p2, { type: 'setEffectEnabled', effectId: disabledId, enabled: false });

    const layer = renderListAt(p3, f.seqId, sec(1))[0]!;
    expect(layer.effects.map((e) => e.effectType)).toEqual(['color.basic']);
    expect(layer.trackEffects.map((e) => e.effectType)).toEqual(['color.lut']);
  });

  it('is empty in a gap', () => {
    const p = laidOut();
    expect(renderListAt(p, f.seqId, sec(5))).toEqual([]);
  });
});

describe('audioSegments', () => {
  it('clips segments to the requested range', () => {
    const p = laidOut();
    const segments = audioSegments(p, f.seqId, T.range(sec(2), sec(3)));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.timelineRange).toEqual(T.range(sec(2), sec(3)));
    expect(segments[0]!.sourceStart).toEqual(sec(2));
  });

  it('maps the source start through sourceIn and speed', () => {
    const p = run(
      f,
      insertCommand(f, {
        trackId: f.a1,
        start: sec(0),
        duration: sec(4),
        sourceIn: sec(1),
        speed: 2,
        kind: 'audio',
        name: 'M',
      }),
    );
    const segments = audioSegments(p, f.seqId, T.range(sec(1), sec(1)));
    expect(segments[0]!.sourceStart).toEqual(sec(3)); // 1 + 1×2
    expect(segments[0]!.speed).toBe(2);
  });

  it('honours mute', () => {
    const p1 = laidOut();
    expect(audioSegments(p1, f.seqId, T.range(sec(0), sec(10)))).toHaveLength(1);
    const muted = runFrom(f, p1, { type: 'setTrackProps', trackId: f.a1, props: { muted: true } });
    expect(audioSegments(muted, f.seqId, T.range(sec(0), sec(10)))).toEqual([]);
  });

  it('honours solo across tracks', () => {
    const p1 = run(
      f,
      { type: 'addTrack', sequenceId: f.seqId, kind: 'audio', name: 'A2' },
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(4), kind: 'audio', name: 'M1' }),
    );
    const a2 = p1.sequences[f.seqId]!.audioTrackIds[1]!;
    const p2 = runFrom(
      f,
      p1,
      insertCommand(f, { trackId: a2, start: sec(0), duration: sec(4), kind: 'audio', name: 'M2' }),
    );
    expect(audibleTrackIds(p2, f.seqId).size).toBe(2);

    const soloed = runFrom(f, p2, { type: 'setTrackProps', trackId: a2, props: { solo: true } });
    expect([...audibleTrackIds(soloed, f.seqId)]).toEqual([a2]);
    expect(audioSegments(soloed, f.seqId, T.range(sec(0), sec(4))).map((s) => s.clip.name)).toEqual(['M2']);
  });

  it('skips disabled clips', () => {
    const p1 = laidOut();
    const disabled = runFrom(f, p1, {
      type: 'setClipProps',
      clipId: clipIds(p1, f.a1)[0]!,
      props: { enabled: false },
    });
    expect(audioSegments(disabled, f.seqId, T.range(sec(0), sec(10)))).toEqual([]);
  });

  it('leaves gain and pan as parameters for the mixer to evaluate per block', () => {
    const p1 = laidOut();
    const id = clipIds(p1, f.a1)[0]!;
    const faded: Project = {
      ...p1,
      clips: {
        ...p1.clips,
        [id]: {
          ...(getClip(p1, id) as AudioClip),
          gainDb: keyframedParam([keyframe(T.TIME_ZERO, -60), keyframe(sec(2), 0)]),
        },
      },
    };
    const segment = audioSegments(faded, f.seqId, T.range(sec(0), sec(4)))[0]!;
    expect(segment.clip.gainDb.kind).toBe('keyframed');
    expect(segment.clip.pan).toEqual(staticParam(0));
  });
});

describe('snapping', () => {
  it('collects sorted, de-duplicated candidates', () => {
    const p1 = laidOut();
    const p2 = runFrom(
      f,
      p1,
      { type: 'addMarker', sequenceId: f.seqId, at: sec(5) },
      { type: 'setView', sequenceId: f.seqId, view: { playhead: sec(4) } },
    );
    // Clip edges 0,4,6,10 (V1 and A1 share 0 and 10), marker 5, playhead 4.
    expect(snapPoints(p2, f.seqId).map(T.toSeconds)).toEqual([0, 4, 5, 6, 10]);
  });

  it('excludes the clips being dragged', () => {
    const p = laidOut();
    const dragging = new Set([clipIds(p, f.v1)[1]!]); // B[6..10)
    // A1's M[0..10) still contributes 0 and 10.
    expect(snapPoints(p, f.seqId, { excludeClipIds: dragging }).map(T.toSeconds)).toEqual([0, 4, 10]);
  });

  it('can be narrowed to clip edges only', () => {
    const p = runFrom(f, laidOut(), { type: 'addMarker', sequenceId: f.seqId, at: sec(5) });
    const points = snapPoints(p, f.seqId, {
      includeMarkers: false,
      includePlayhead: false,
      includeInOut: false,
    });
    expect(points.map(T.toSeconds)).toEqual([0, 4, 6, 10]);
  });

  it('finds the nearest candidate within tolerance', () => {
    const candidates = [sec(0), sec(4), sec(6)];
    expect(findSnap(candidates, sec(41, 10), sec(1, 2))).toEqual(sec(4));
    expect(findSnap(candidates, sec(5), sec(1, 2))).toBeNull(); // equidistant but out of range
    expect(findSnap(candidates, sec(5), sec(1))).toEqual(sec(4)); // ties go to the first found
    expect(findSnap([], sec(1), sec(1))).toBeNull();
  });
});
