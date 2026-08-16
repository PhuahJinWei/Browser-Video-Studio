/**
 * Fill-colour clips.
 *
 * A solid is generated rather than decoded, so the interesting cases are the ones
 * where the rest of the model assumes a source exists: trimming, splitting, and the
 * per-kind parameter guards.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import {
  clipTrimHandles,
  getClip,
  isMediaClip,
  isSyntheticClip,
  isVisualClip,
  ModelError,
  renderListAt,
} from './selectors';
import * as T from './time';
import type { ClipId, Project, SolidClip } from './types';
import { assertValidProject } from './validate';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

function addSolid(fill = '#1f6feb', start = sec(0), duration = sec(4)): Project {
  return run(f, {
    type: 'insertClip',
    trackId: f.v1,
    mode: 'overwrite',
    clip: { kind: 'solid', start, duration, fill },
  });
}

function onlyClip(p: Project): SolidClip {
  const id = p.tracks[f.v1 as never]!.clipIds[0] as ClipId;
  return getClip(p, id) as SolidClip;
}

describe('creation', () => {
  it('inserts a fill clip on a video track', () => {
    const p = addSolid();
    const clip = onlyClip(p);
    expect(clip.kind).toBe('solid');
    expect(clip.fill).toBe('#1f6feb');
    expect(clip.blendMode).toBe('normal');
    assertValidProject(p);
  });

  it('is visual but not media', () => {
    const clip = onlyClip(addSolid());
    expect(isVisualClip(clip)).toBe(true);
    expect(isMediaClip(clip)).toBe(false);
    expect(isSyntheticClip(clip)).toBe(true);
  });

  it('is rejected on an audio track', () => {
    expect(() =>
      run(f, {
        type: 'insertClip',
        trackId: f.a1,
        mode: 'overwrite',
        clip: { kind: 'solid', start: sec(0), duration: sec(4), fill: '#fff' },
      }),
    ).toThrow(ModelError);
  });
});

describe('trimming', () => {
  it('stretches without limit, having no source to run out of', () => {
    const p = addSolid();
    const clip = onlyClip(p);
    expect(clipTrimHandles(p, clip)).toEqual({ headroom: null, tailroom: null });

    // Far beyond any source length a decoded clip would have.
    const stretched = runFrom(f, p, {
      type: 'trimClip',
      clipId: clip.id,
      edge: 'out',
      to: sec(600),
    });
    expect(T.toSeconds(onlyClip(stretched).duration)).toBe(600);
    assertValidProject(stretched);
  });

  it('keeps the fill when trimmed from the head', () => {
    const p = addSolid('#ff0000');
    const trimmed = runFrom(f, p, {
      type: 'trimClip',
      clipId: onlyClip(p).id,
      edge: 'in',
      to: sec(1),
    });
    const clip = onlyClip(trimmed);
    expect(clip.fill).toBe('#ff0000');
    expect(T.toSeconds(clip.start)).toBe(1);
    expect(T.toSeconds(clip.duration)).toBe(3);
  });
});

describe('splitting', () => {
  it('produces two independent halves of the same colour', () => {
    const p = addSolid('#00ff88');
    const split = runFrom(f, p, {
      type: 'splitClips',
      trackIds: [f.v1],
      at: sec(3, 2),
    });
    const ids = split.tracks[f.v1 as never]!.clipIds;
    expect(ids).toHaveLength(2);

    const [head, tail] = ids.map((id) => getClip(split, id) as SolidClip);
    expect(head!.fill).toBe('#00ff88');
    expect(tail!.fill).toBe('#00ff88');
    expect(T.toSeconds(head!.duration)).toBe(1.5);
    expect(T.toSeconds(tail!.start)).toBe(1.5);
    // Halves of a cut must not weld back together when one is dragged.
    expect(head!.linkGroupId).toBeNull();
    expect(tail!.linkGroupId).toBeNull();
    assertValidProject(split);
  });
});

describe('parameters', () => {
  it('recolours via setSolidFill', () => {
    const p = addSolid('#111111');
    const recoloured = runFrom(f, p, {
      type: 'setSolidFill',
      clipId: onlyClip(p).id,
      fill: 'rebeccapurple',
    });
    expect(onlyClip(recoloured).fill).toBe('rebeccapurple');
  });

  it('refuses an empty colour', () => {
    const p = addSolid();
    expect(() =>
      runFrom(f, p, { type: 'setSolidFill', clipId: onlyClip(p).id, fill: '  ' }),
    ).toThrow(ModelError);
  });

  it('accepts a blend mode — a fill over footage is a tint', () => {
    const p = addSolid();
    const blended = runFrom(f, p, {
      type: 'setClipBlendMode',
      clipId: onlyClip(p).id,
      blendMode: 'multiply',
    });
    expect(onlyClip(blended).blendMode).toBe('multiply');
  });

  it('refuses a crop — it already fills the frame', () => {
    const p = addSolid();
    expect(() =>
      runFrom(f, p, {
        type: 'setClipParam',
        clipId: onlyClip(p).id,
        key: 'crop.left',
        param: { kind: 'static', value: 0.2 },
      }),
    ).toThrow(ModelError);
  });
});

describe('render list', () => {
  it('reports the fill with no source time and no crop', () => {
    const p = addSolid('#1f6feb');
    const layers = renderListAt(p, f.seqId, sec(2));
    expect(layers).toHaveLength(1);

    const layer = layers[0]!;
    expect(layer.clip.kind).toBe('solid');
    expect(layer.sourceTime).toBeNull();
    expect(layer.crop).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(layer.blendMode).toBe('normal');
    expect(layer.opacity).toBe(1);
  });

  it('drops out once the clip ends', () => {
    const p = addSolid('#1f6feb', sec(0), sec(4));
    expect(renderListAt(p, f.seqId, sec(9, 2))).toHaveLength(0);
  });
});
