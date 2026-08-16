/**
 * Media-bin folders, and knowing what an asset is still being used by.
 *
 * Folders are paths stored on each asset rather than entities of their own, so the
 * invariants worth pinning down are about paths agreeing with each other: two
 * spellings of one folder must not become two folders, and a rename has to carry
 * everything filed beneath it.
 */

import { describe, expect, it } from 'vitest';
import { apply } from './commands';
import { normaliseFolder } from './commands/handlers';
import { insertCommand, makeFixture, run, sec, type Fixture } from './fixtures';
import { assetFolders, assetsInFolderTree, childFolders, clipsUsingAssets } from './selectors';
import type { AssetId, Project } from './types';
import { validateProject } from './validate';

/** File an asset, going through the command so normalisation is exercised. */
function file(f: Fixture, project: Project, assetId: AssetId, folder: string): Project {
  return apply(project, { type: 'setAssetFolder', assetId, folder }, f.ids);
}

describe('folder paths', () => {
  it('normalises stray separators to one spelling', () => {
    expect(normaliseFolder('/B-roll//Day 1/')).toBe('B-roll/Day 1');
    expect(normaliseFolder('B-roll/Day 1')).toBe('B-roll/Day 1');
    expect(normaliseFolder('  B-roll / Day 1 ')).toBe('B-roll/Day 1');
    expect(normaliseFolder('///')).toBe('');
    expect(normaliseFolder('')).toBe('');
  });

  it('stores the normalised form, so one folder cannot become two', () => {
    const f = makeFixture();
    let project = file(f, f.project, f.assetId, '/B-roll//Day 1/');
    project = file(f, project, f.shortAssetId, 'B-roll/Day 1');

    expect(project.assets[f.assetId]!.folder).toBe('B-roll/Day 1');
    expect(assetFolders(project)).toEqual(['B-roll', 'B-roll/Day 1']);
  });

  it('rejects an unnormalised path written straight into the document', () => {
    const f = makeFixture();
    const asset = f.project.assets[f.assetId]!;
    const corrupt: Project = {
      ...f.project,
      assets: { ...f.project.assets, [f.assetId]: { ...asset, folder: '/B-roll/' } },
    };
    expect(validateProject(corrupt).map((v) => v.path)).toContain(`assets.${f.assetId}.folder`);
  });

  it('implies the ancestors of a nested path, so intermediate folders are reachable', () => {
    const f = makeFixture();
    // Nothing sits directly in 'B-roll' — only in the folder beneath it.
    const project = file(f, f.project, f.assetId, 'B-roll/Day 1');

    expect(assetFolders(project)).toEqual(['B-roll', 'B-roll/Day 1']);
    expect(childFolders(project, '')).toEqual(['B-roll']);
    expect(childFolders(project, 'B-roll')).toEqual(['Day 1']);
  });

  it('lists a folder made but not yet filled alongside the real ones', () => {
    const f = makeFixture();
    // Empty folders cannot be stored, so the panel passes them in separately.
    expect(childFolders(f.project, '', ['Archive'])).toEqual(['Archive']);
  });

  it('counts a folder by everything beneath it, not just its own contents', () => {
    const f = makeFixture();
    let project = file(f, f.project, f.assetId, 'B-roll/Day 1');
    project = file(f, project, f.shortAssetId, 'B-roll');

    expect(assetsInFolderTree(project, 'B-roll')).toHaveLength(2);
    expect(assetsInFolderTree(project, 'B-roll/Day 1')).toHaveLength(1);
    // The root is not a prefix of everything by accident.
    expect(assetsInFolderTree(project, '')).toHaveLength(2);
  });

  it('does not treat a name that merely starts the same as a child', () => {
    const f = makeFixture();
    let project = file(f, f.project, f.assetId, 'B-roll');
    project = file(f, project, f.shortAssetId, 'B-roll-2');

    expect(childFolders(project, '')).toEqual(['B-roll', 'B-roll-2']);
    expect(assetsInFolderTree(project, 'B-roll')).toHaveLength(1);
  });
});

describe('clipsUsingAssets', () => {
  it('finds every clip cut from an asset, across tracks', () => {
    const f = makeFixture();
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }),
      insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(2) }),
      insertCommand(f, { trackId: f.a1, start: sec(0), duration: sec(2), kind: 'audio' }),
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(1), assetId: f.shortAssetId }),
    );

    const usage = clipsUsingAssets(project, [f.assetId, f.shortAssetId]);
    expect(usage.get(f.assetId)).toHaveLength(3);
    expect(usage.get(f.shortAssetId)).toHaveLength(1);
  });

  it('reports an entry for an unused asset rather than omitting it', () => {
    const f = makeFixture();
    // A caller partitioning a selection needs a zero, not a missing key.
    const usage = clipsUsingAssets(f.project, [f.assetId]);
    expect(usage.get(f.assetId)).toEqual([]);
  });

  it('is what stands between a multi-delete and one refusal discarding the batch', () => {
    const f = makeFixture();
    const project = run(f, insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2) }));

    // `removeAsset` throws for an asset still in use, and `applyAll` discards the
    // whole batch when any command throws — so the used one has to be found first.
    expect(() =>
      apply(project, { type: 'removeAsset', assetId: f.assetId }, f.ids),
    ).toThrow(/still used/);

    const usage = clipsUsingAssets(project, [f.assetId, f.shortAssetId]);
    const safe = [f.assetId, f.shortAssetId].filter((id) => usage.get(id)!.length === 0);
    expect(safe).toEqual([f.shortAssetId]);

    const after = apply(project, { type: 'removeAsset', assetId: safe[0]! }, f.ids);
    expect(after.assets[f.shortAssetId]).toBeUndefined();
    expect(after.assets[f.assetId]).toBeDefined();
  });
});
