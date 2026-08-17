import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import { migrateProject, MigrationError, needsMigration } from './migrations';
import { expandSelection, getClip, selectionUnit } from './selectors';
import type { ClipId, Project } from './types';
import { SCHEMA_VERSION } from './types';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

function clipsOf(p: Project, trackId: string): readonly ClipId[] {
  return p.tracks[trackId as never]!.clipIds;
}

/** A linked A/V pair on V1/A1, plus an unrelated clip on V2. */
function linkedPairAndOverlay(fx: Fixture): {
  project: Project;
  v: ClipId;
  a: ClipId;
  over: ClipId;
} {
  const p1 = run(
    fx,
    insertCommand(fx, { trackId: fx.v1, start: sec(0), duration: sec(2), name: 'V' }),
    insertCommand(fx, { trackId: fx.a1, start: sec(0), duration: sec(2), kind: 'audio', name: 'A' }),
    insertCommand(fx, { trackId: fx.v2, start: sec(0), duration: sec(2), name: 'Over' }),
  );
  const v = clipsOf(p1, fx.v1)[0]!;
  const a = clipsOf(p1, fx.a1)[0]!;
  const over = clipsOf(p1, fx.v2)[0]!;
  return { project: runFrom(fx, p1, { type: 'linkClips', clipIds: [v, a] }), v, a, over };
}

describe('groups', () => {
  it('puts clips into one group and dissolves it again', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2), name: 'B' }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(2), kind: 'audio', name: 'M' }),
    );
    const [a, b] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'groupClips', clipIds: [a!, b!] });

    expect(getClip(p2, a!).groupId).not.toBeNull();
    expect(getClip(p2, b!).groupId).toBe(getClip(p2, a!).groupId);
    // The clip left out stays free.
    expect(getClip(p2, clipsOf(p2, f.a1)[0]!).groupId).toBeNull();

    // Ungrouping one member dissolves the whole group.
    const p3 = runFrom(f, p2, { type: 'ungroupClips', clipIds: [a!] });
    expect(getClip(p3, a!).groupId).toBeNull();
    expect(getClip(p3, b!).groupId).toBeNull();
  });

  it('merges rather than nests when grouping into an existing group', () => {
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2), name: 'B' }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(2), kind: 'audio', name: 'M' }),
    );
    const [a, b] = clipsOf(p1, f.v1);
    const m = clipsOf(p1, f.a1)[0]!;

    const p2 = runFrom(f, p1, { type: 'groupClips', clipIds: [a!, b!] });
    // Grouping B with M must pull A in too, rather than leaving a nested group.
    const p3 = runFrom(f, p2, { type: 'groupClips', clipIds: [b!, m] });

    const groupId = getClip(p3, a!).groupId;
    expect(groupId).not.toBeNull();
    expect(getClip(p3, b!).groupId).toBe(groupId);
    expect(getClip(p3, m).groupId).toBe(groupId);
  });

  it('ignores a group of fewer than two clips', () => {
    const p1 = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }));
    const [a] = clipsOf(p1, f.v1);
    const p2 = runFrom(f, p1, { type: 'groupClips', clipIds: [a!] });
    expect(getClip(p2, a!).groupId).toBeNull();
  });

  it('gives each side of a split its own group', () => {
    // Same rule as links: without it the halves stay welded and the cut is useless.
    const p1 = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(6), name: 'V' }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(6), kind: 'audio', name: 'A' }),
    );
    const v = clipsOf(p1, f.v1)[0]!;
    const a = clipsOf(p1, f.a1)[0]!;
    const p2 = runFrom(f, p1, { type: 'groupClips', clipIds: [v, a] });
    const originalGroup = getClip(p2, v).groupId;

    const p3 = runFrom(f, p2, { type: 'splitClips', trackIds: [f.v1, f.a1], at: sec(3) });
    const [leftV, rightV] = clipsOf(p3, f.v1).map((id) => getClip(p3, id));
    const [leftA, rightA] = clipsOf(p3, f.a1).map((id) => getClip(p3, id));

    expect(leftV!.groupId).toBe(originalGroup);
    expect(leftA!.groupId).toBe(originalGroup);
    expect(rightV!.groupId).not.toBe(originalGroup);
    expect(rightV!.groupId).not.toBeNull();
    // The right-hand halves remain grouped with each other.
    expect(rightA!.groupId).toBe(rightV!.groupId);
  });

  it('keeps link and group membership independent', () => {
    // Detaching audio must not dissolve the group, and ungrouping must not break
    // the A/V link.
    const { project, v, a, over } = linkedPairAndOverlay(f);
    const grouped = runFrom(f, project, { type: 'groupClips', clipIds: [v, over] });

    expect(getClip(grouped, v).linkGroupId).toBe(getClip(grouped, a).linkGroupId);
    expect(getClip(grouped, v).groupId).toBe(getClip(grouped, over).groupId);

    const detached = runFrom(f, grouped, { type: 'unlinkClips', clipIds: [v] });
    expect(getClip(detached, v).linkGroupId).toBeNull();
    expect(getClip(detached, v).groupId).toBe(getClip(detached, over).groupId);

    const ungrouped = runFrom(f, grouped, { type: 'ungroupClips', clipIds: [v] });
    expect(getClip(ungrouped, v).groupId).toBeNull();
    expect(getClip(ungrouped, v).linkGroupId).toBe(getClip(ungrouped, a).linkGroupId);
  });
});

describe('selectionUnit', () => {
  it('returns the clip alone when it belongs to nothing', () => {
    const p = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }));
    const [a] = clipsOf(p, f.v1);
    expect(selectionUnit(p, a!)).toEqual([a]);
  });

  it('returns both halves of an A/V link', () => {
    const { project, v, a } = linkedPairAndOverlay(f);
    expect([...selectionUnit(project, v)].sort()).toEqual([v, a].sort());
    expect([...selectionUnit(project, a)].sort()).toEqual([v, a].sort());
  });

  it('crosses from a group into a link and back', () => {
    // Over is grouped with V, and V is linked to A. Selecting Over must reach A,
    // which only works if the closure follows both relations.
    const { project, v, a, over } = linkedPairAndOverlay(f);
    const grouped = runFrom(f, project, { type: 'groupClips', clipIds: [v, over] });

    expect([...selectionUnit(grouped, over)].sort()).toEqual([v, a, over].sort());
    expect([...selectionUnit(grouped, a)].sort()).toEqual([v, a, over].sort());
  });

  it('expands a multi-clip selection without duplicating', () => {
    const { project, v, a } = linkedPairAndOverlay(f);
    expect(expandSelection(project, [v, a])).toHaveLength(2);
  });

  it('returns nothing for a clip that does not exist', () => {
    expect(selectionUnit(f.project, 'cl_nope' as ClipId)).toEqual([]);
  });
});

describe('schema migration', () => {
  /** A v1 document: clips have no `groupId` at all. */
  function asVersion1(project: Project): Record<string, unknown> {
    const clips: Record<string, unknown> = {};
    for (const [id, clip] of Object.entries(project.clips)) {
      const { groupId, ...rest } = clip as unknown as Record<string, unknown>;
      void groupId;
      clips[id] = rest;
    }
    return { ...project, clips, schemaVersion: 1 };
  }

  it('adds groupId when upgrading a v1 project', () => {
    const current = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), name: 'A' }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(2), kind: 'audio', name: 'M' }),
    );
    const old = asVersion1(current);
    expect(needsMigration(old)).toBe(true);
    expect('groupId' in (Object.values(old.clips as object)[0] as object)).toBe(false);

    const migrated = migrateProject(old);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    for (const clip of Object.values(migrated.clips)) {
      expect(clip.groupId).toBeNull();
    }
    // Everything else survives untouched.
    expect(Object.keys(migrated.clips)).toEqual(Object.keys(current.clips));
    expect(migrated.name).toBe(current.name);
  });

  it('widens only audio tracks that still use the legacy 56px default', () => {
    const legacy = {
      ...f.project,
      schemaVersion: 4,
      tracks: {
        ...f.project.tracks,
        [f.a1]: { ...f.project.tracks[f.a1]!, height: 56 },
        [f.v1]: { ...f.project.tracks[f.v1]!, height: 56 },
      },
    };

    const migrated = migrateProject(legacy);
    expect(migrated.tracks[f.a1]!.height).toBe(72);
    expect(migrated.tracks[f.v1]!.height).toBe(56);

    const customized = migrateProject({
      ...legacy,
      tracks: {
        ...legacy.tracks,
        [f.a1]: { ...f.project.tracks[f.a1]!, height: 40 },
      },
    });
    expect(customized.tracks[f.a1]!.height).toBe(40);
  });

  it('leaves a current project alone', () => {
    const current = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }));
    expect(needsMigration(current)).toBe(false);
    expect(migrateProject(current)).toEqual(current);
  });

  it('refuses a document from a newer build', () => {
    const future = { schemaVersion: SCHEMA_VERSION + 1, clips: {} };
    expect(() => migrateProject(future)).toThrow(MigrationError);
    expect(() => migrateProject(future)).toThrow(/newer version/);
  });

  it('refuses a document with no readable version', () => {
    expect(() => migrateProject({ clips: {} })).toThrow(/schemaVersion/);
    expect(() => migrateProject(null)).toThrow(MigrationError);
  });
});
