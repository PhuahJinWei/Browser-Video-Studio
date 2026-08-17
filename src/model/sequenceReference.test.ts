import { describe, expect, it } from 'vitest';
import { apply } from './commands';
import { createAsset } from './factories';
import { insertCommand, makeFixture, run, sec } from './fixtures';
import {
  encoderSafeSequenceSize,
  matchableVideoAssets,
  preferredSequenceReference,
  sequenceMatchesReference,
  settingsForReference,
} from './sequenceFormat';
import * as T from './time';

describe('sequence format references', () => {
  it('excludes stills even though they carry a synthetic video stream', () => {
    const f = makeFixture();
    const stillId = f.ids.asset();
    const project = apply(
      f.project,
      {
        type: 'addAsset',
        asset: createAsset({
          id: stillId,
          name: 'poster.png',
          kind: 'image',
          videoDuration: sec(5),
          size: { width: 4000, height: 3000 },
        }),
      },
      f.ids,
    );

    const candidates = matchableVideoAssets(project, f.seqId);
    expect(candidates.map((asset) => asset.id)).not.toContain(stillId);
    expect(candidates.every((asset) => asset.kind === 'video')).toBe(true);
  });

  it('prefers an explicit library/source selection over the timeline fallback', () => {
    const f = makeFixture();
    const project = run(
      f,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(2), assetId: f.assetId }),
    );

    expect(preferredSequenceReference(project, f.seqId, [f.shortAssetId])?.id).toBe(
      f.shortAssetId,
    );
  });

  it('falls back to the earliest real video used on the timeline', () => {
    const f = makeFixture();
    const project = run(
      f,
      insertCommand(f, {
        trackId: f.v1,
        start: sec(5),
        duration: sec(2),
        assetId: f.assetId,
      }),
      insertCommand(f, {
        trackId: f.v2,
        start: sec(1),
        duration: sec(2),
        assetId: f.shortAssetId,
      }),
    );

    expect(preferredSequenceReference(project, f.seqId, [])?.id).toBe(f.shortAssetId);
  });

  it('normalises imported dimensions for encoder-safe sequence output', () => {
    expect(encoderSafeSequenceSize({ width: 853, height: 479 })).toEqual({
      width: 854,
      height: 480,
    });
    expect(encoderSafeSequenceSize({ width: 1, height: 0 })).toEqual({ width: 2, height: 2 });
  });

  it('matches both resolution and frame rate, not resolution alone', () => {
    const f = makeFixture();
    const sequence = f.project.sequences[f.seqId]!;
    const asset = f.project.assets[f.assetId]!;
    expect(sequenceMatchesReference(sequence, asset)).toBe(true);

    const changedRate = { ...sequence, frameRate: T.FPS_60 };
    expect(sequenceMatchesReference(changedRate, asset)).toBe(false);
    expect(settingsForReference(changedRate, asset).frameRate).toEqual(T.FPS_25);
  });

  it('keeps the sequence rate when a VFR source has no fixed rate', () => {
    const f = makeFixture();
    const source = f.project.assets[f.assetId]!;
    const vfr = { ...source, video: { ...source.video!, frameRate: null } };
    const sequence = { ...f.project.sequences[f.seqId]!, frameRate: T.FPS_59_94 };

    expect(settingsForReference(sequence, vfr).frameRate).toEqual(T.FPS_59_94);
  });
});
