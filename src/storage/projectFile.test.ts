/**
 * Project files.
 *
 * These are the only copies of someone's work that leave the browser, so the
 * round-trip has to be exact and every way of failing has to fail loudly. A file
 * that opens *almost* right is worse than one that refuses to open.
 */

import { describe, expect, it } from 'vitest';
import { apply } from '../model/commands';
import { insertCommand, makeFixture, sec } from '../model/fixtures';
import type { AssetId, Project } from '../model/types';
import {
  PROJECT_FILE_EXTENSION,
  projectFileName,
  projectFileSize,
  readProjectFile,
  writeProjectFile,
} from './projectFile';

function withClip(): Project {
  const f = makeFixture();
  return apply(
    f.project,
    insertCommand(f, { trackId: f.v1, start: sec(1), duration: sec(4) }),
    f.ids,
  );
}

function mediaFor(project: Project, bytesPerAsset = 64): Map<AssetId, File> {
  const media = new Map<AssetId, File>();
  let seed = 1;
  for (const assetId of Object.keys(project.assets) as AssetId[]) {
    const bytes = new Uint8Array(bytesPerAsset).map((_, i) => (i * seed) % 251);
    media.set(assetId, new File([bytes], `${assetId}.bin`, { type: 'video/mp4' }));
    seed++;
  }
  return media;
}

describe('project files', () => {
  it('round-trips the document exactly', async () => {
    const project = withClip();
    const read = await readProjectFile(writeProjectFile(project, new Map()));

    expect(read.project).toEqual(project);
  });

  it('round-trips media byte for byte', async () => {
    const project = withClip();
    const media = mediaFor(project);
    const read = await readProjectFile(writeProjectFile(project, media));

    expect(read.media.size).toBe(media.size);
    for (const [assetId, original] of media) {
      const restored = read.media.get(assetId);
      expect(restored).toBeDefined();
      expect(restored!.name).toBe(original.name);
      expect(restored!.type).toBe(original.type);
      expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(
        new Uint8Array(await original.arrayBuffer()),
      );
    }
    expect(read.missingAssetIds).toEqual([]);
  });

  it('keeps payloads apart when they differ in size', async () => {
    // Offsets are walked from the manifest, so unequal lengths are the case that
    // catches an off-by-one that equal ones would hide.
    const project = withClip();
    const ids = Object.keys(project.assets) as AssetId[];
    const media = new Map<AssetId, File>();
    media.set(ids[0]!, new File([new Uint8Array([1, 2, 3])], 'a.bin', { type: 'video/mp4' }));
    media.set(ids[1]!, new File([new Uint8Array([9, 9, 9, 9, 9, 9, 9])], 'b.bin', { type: 'audio/mp4' }));

    const read = await readProjectFile(writeProjectFile(project, media));
    expect(new Uint8Array(await read.media.get(ids[0]!)!.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(new Uint8Array(await read.media.get(ids[1]!)!.arrayBuffer())).toEqual(
      new Uint8Array([9, 9, 9, 9, 9, 9, 9]),
    );
  });

  it('reports assets it carried no bytes for', async () => {
    const project = withClip();
    const ids = Object.keys(project.assets) as AssetId[];
    const partial = new Map<AssetId, File>([
      [ids[0]!, new File([new Uint8Array([7])], 'a.bin', { type: 'video/mp4' })],
    ]);

    const read = await readProjectFile(writeProjectFile(project, partial));
    // The clips survive; the source is simply flagged as needing re-importing.
    expect(read.project.clips).toEqual(project.clips);
    expect(read.missingAssetIds).toEqual(ids.slice(1));
  });

  it('rejects a file that is not one of ours', async () => {
    const notOurs = new Blob([new TextEncoder().encode('PK and then some zip')]);
    await expect(readProjectFile(notOurs)).rejects.toThrow(/not a project file/i);
  });

  it('rejects a file too short to hold a header', async () => {
    await expect(readProjectFile(new Blob([new Uint8Array(4)]))).rejects.toThrow(/too small/i);
  });

  it('rejects a truncated file rather than opening half of it', async () => {
    const project = withClip();
    const whole = writeProjectFile(project, mediaFor(project, 4096));
    const cut = whole.slice(0, whole.size - 2048);

    await expect(readProjectFile(cut)).rejects.toThrow(/incomplete/i);
  });

  it('rejects a damaged manifest', async () => {
    const project = withClip();
    const whole = new Uint8Array(await writeProjectFile(project, new Map()).arrayBuffer());
    // Corrupt a byte inside the manifest, past the 12-byte header.
    whole[40] = 0x00;

    await expect(readProjectFile(new Blob([whole]))).rejects.toThrow(/damaged|invalid/i);
  });

  it('refuses a format from a newer build', async () => {
    const project = withClip();
    const whole = new Uint8Array(await writeProjectFile(project, new Map()).arrayBuffer());
    whole[7] = 99;

    await expect(readProjectFile(new Blob([whole]))).rejects.toThrow(/newer version/i);
  });

  it('rejects a document that does not satisfy the model', async () => {
    const project = withClip();
    // A clip pointing at a track that is not there — the shape of damage that would
    // otherwise crash a render rather than fail an open.
    const broken = { ...project, tracks: {} };
    const bytes = new Uint8Array(await writeProjectFile(broken as Project, new Map()).arrayBuffer());

    await expect(readProjectFile(new Blob([bytes]))).rejects.toThrow(/invalid/i);
  });

  it('names the download after the project, safely', () => {
    expect(projectFileName('Holiday cut')).toBe(`Holiday cut${PROJECT_FILE_EXTENSION}`);
    // Characters Windows rejects, and a trailing dot it silently strips.
    expect(projectFileName('a/b:c*d.')).toBe(`a-b-c-d${PROJECT_FILE_EXTENSION}`);
    expect(projectFileName('   ')).toBe(`project${PROJECT_FILE_EXTENSION}`);
  });

  it('estimates the size before writing anything', () => {
    const project = withClip();
    const media = mediaFor(project, 1000);
    const estimate = projectFileSize(project, media);
    const actual = writeProjectFile(project, media).size;

    // Used to warn before handing over a large download, so it must not undershoot
    // by enough to matter. JSON escaping is the only slack.
    expect(estimate).toBeGreaterThanOrEqual(actual * 0.9);
    expect(estimate).toBeLessThanOrEqual(actual * 1.2);
  });
});
