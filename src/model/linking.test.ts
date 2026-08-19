/**
 * What may be linked, and what linking leaves behind.
 *
 * A link is a picture and its own sound edited as one — linked members share an
 * absolute trim edge, and a split re-pairs the halves. Both are right for two
 * coincident halves of a take and wrong for two unrelated clips, so the rule has to
 * be enforced rather than assumed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, sec, type Fixture } from './fixtures';
import { linkability, ModelError } from './selectors';
import { apply } from './commands';
import type { Clip, ClipId, Project } from './types';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

/** One video clip on V1 and one audio clip on A1, unlinked. */
function pair(): { project: Project; video: Clip; audio: Clip } {
  const project = run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }),
    insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(4), kind: 'audio' }),
  );
  const clips = Object.values(project.clips);
  return {
    project,
    video: clips.find((c) => c.kind !== 'audio')!,
    audio: clips.find((c) => c.kind === 'audio')!,
  };
}

function link(project: Project, clipIds: readonly ClipId[]): Project {
  return apply(project, { type: 'linkClips', clipIds }, f.ids);
}

describe('deciding whether a selection can be linked', () => {
  it('accepts one video clip and one audio clip', () => {
    const { project, video, audio } = pair();
    expect(linkability(project, [video.id, audio.id])).toEqual({ ok: true, reason: null });
  });

  it('refuses a pair that is already linked, rather than re-linking it', () => {
    // The old menu offered this, and taking it made a fresh group id that changed
    // nothing while still costing an undo step.
    const { project, video, audio } = pair();
    const linked = link(project, [video.id, audio.id]);

    expect(linkability(linked, [video.id, audio.id])).toMatchObject({ ok: false, reason: 'already linked' });
  });

  it('refuses two clips of the same kind, which is what grouping is for', () => {
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }),
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(2) }),
    );
    const both = Object.values(project.clips).map((c) => c.id);

    expect(linkability(project, both)).toMatchObject({ ok: false });
  });

  it('refuses fewer than two, and more than two', () => {
    const { project, video, audio } = pair();
    expect(linkability(project, [video.id]).ok).toBe(false);
    expect(linkability(project, [video.id, audio.id, video.id]).ok).toBe(false);
  });

  it('refuses a locked clip, which cannot be edited as one with anything', () => {
    const { project, video, audio } = pair();
    const locked = apply(project, { type: 'setClipProps', clipId: video.id, props: { locked: true } }, f.ids);

    expect(linkability(locked, [video.id, audio.id])).toMatchObject({ ok: false, reason: 'a clip is locked' });
  });

  it('allows sound recorded separately, since that is what linking is most for', () => {
    // Different sources on purpose: dual-system audio is synced and then linked.
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), assetId: f.shortAssetId }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(2), kind: 'audio' }),
    );
    const clips = Object.values(project.clips);
    const ids = [clips.find((c) => c.kind !== 'audio')!.id, clips.find((c) => c.kind === 'audio')!.id];

    expect(linkability(project, ids).ok).toBe(true);
  });
});

describe('linking clips', () => {
  it('refuses at the model too, not only in the menu', () => {
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }),
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(2) }),
    );
    const both = Object.values(project.clips).map((c) => c.id);

    expect(() => link(project, both)).toThrow(ModelError);
  });

  it('puts both halves in the same group', () => {
    const { project, video, audio } = pair();
    const linked = link(project, [video.id, audio.id]);

    expect(linked.clips[video.id]!.linkGroupId).not.toBeNull();
    expect(linked.clips[audio.id]!.linkGroupId).toBe(linked.clips[video.id]!.linkGroupId);
  });

  it('releases a partner left alone when one half is re-linked elsewhere', () => {
    // Video linked to A, then linked to B instead: A used to keep the old group id
    // and go on claiming a link it was the only member of.
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(2), kind: 'audio' }),
      insertCommand(f, { trackId: f.a1, start: sec(4), duration: sec(2), kind: 'audio' }),
    );
    const clips = Object.values(project.clips);
    const video = clips.find((c) => c.kind !== 'audio')!;
    const [first, second] = clips.filter((c) => c.kind === 'audio');

    const once = link(project, [video.id, first!.id]);
    const twice = link(once, [video.id, second!.id]);

    expect(twice.clips[first!.id]!.linkGroupId).toBeNull();
    expect(twice.clips[second!.id]!.linkGroupId).toBe(twice.clips[video.id]!.linkGroupId);
  });
});
