/**
 * Selecting in one panel drops the selection in the other.
 *
 * Delete means "the selected thing", and which handler receives the key is decided
 * by focus — which nothing on screen shows. So two live selections is not an
 * untidiness, it is a keypress away from removing media *and* every clip cut from
 * it while the user is looking at the clip they meant to delete.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, sec, type Fixture } from '../model/fixtures';
import { initHistory } from '../model/history';
import * as T from '../model/time';
import type { AssetId, ClipId } from '../model/types';
import { useStudio } from './store';

let f: Fixture;
let clipA: ClipId;
let clipB: ClipId;
let assetA: AssetId;
let assetB: AssetId;

beforeEach(() => {
  f = makeFixture();
  const project = run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
    insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(4), name: 'B' }),
  );
  [clipA, clipB] = project.tracks[f.v1]!.clipIds as [ClipId, ClipId];
  assetA = f.assetId;
  assetB = f.shortAssetId;

  useStudio.setState({
    history: initHistory(project),
    sequenceId: f.seqId,
    selection: [],
    selectionAnchor: null,
    selectedAssetIds: [],
    assetSelectionAnchor: null,
    selectedTrackId: null,
    selectedTransitionId: null,
  });
});

/** Media picked in the library, and left there. */
function mediaSelected(): void {
  useStudio.setState({ selectedAssetIds: [assetA], assetSelectionAnchor: assetA });
}

function state() {
  return useStudio.getState();
}

describe('picking something on the timeline', () => {
  it('drops the library selection when a clip is clicked', () => {
    mediaSelected();
    state().select([clipA]);

    expect(state().selection).toEqual([clipA]);
    expect(state().selectedAssetIds).toEqual([]);
  });

  it('drops it for an exact selection too', () => {
    mediaSelected();
    state().selectExact([clipA]);

    expect(state().selectedAssetIds).toEqual([]);
  });

  it('drops it when a clip is added to the selection with ctrl', () => {
    mediaSelected();
    state().toggleSelect(clipA);

    expect(state().selection).toContain(clipA);
    expect(state().selectedAssetIds).toEqual([]);
  });

  it('drops it when a range is shift-clicked', () => {
    useStudio.setState({ selection: [clipA], selectionAnchor: clipA });
    mediaSelected();
    state().selectRangeTo(clipB);

    expect(state().selection).toContain(clipB);
    expect(state().selectedAssetIds).toEqual([]);
  });

  it('drops it when clips are swept with a marquee', () => {
    mediaSelected();
    state().selectWithin([f.v1], T.rangeFromBounds(sec(0), sec(8)), false);

    expect(state().selection.length).toBeGreaterThan(0);
    expect(state().selectedAssetIds).toEqual([]);
  });
});

describe('picking something in the library', () => {
  it('drops the timeline selection', () => {
    state().select([clipA]);
    state().selectAssets([assetA]);

    expect(state().selectedAssetIds).toEqual([assetA]);
    expect(state().selection).toEqual([]);
  });

  it('drops it when media is added to the selection with ctrl', () => {
    state().select([clipA]);
    state().toggleSelectAsset(assetB);

    expect(state().selectedAssetIds).toContain(assetB);
    expect(state().selection).toEqual([]);
  });

  it('drops it when a range of media is shift-clicked', () => {
    state().select([clipA]);
    useStudio.setState({ assetSelectionAnchor: assetA });
    state().selectAssetRangeTo(assetB, [assetA, assetB]);

    expect(state().selectedAssetIds.length).toBeGreaterThan(0);
    expect(state().selection).toEqual([]);
  });
});

describe('the anchors a later shift-click measures from', () => {
  it('go with the selection they belonged to, both ways', () => {
    useStudio.setState({ selection: [clipA], selectionAnchor: clipA });
    state().selectAssets([assetA]);
    expect(state().selectionAnchor).toBeNull();

    state().select([clipB]);
    expect(state().assetSelectionAnchor).toBeNull();
  });
});

describe('a chosen destination track', () => {
  /*
   * The one pairing that is meant to be held at once: `editSourceToTimeline` sends
   * the source monitor's media to the selected track, so picking media must not
   * throw away the track that says where it is going.
   */
  it('survives picking media, because that pair is the gesture', () => {
    state().selectTrack(f.v1);
    state().selectAssets([assetA]);

    expect(state().selectedTrackId).toBe(f.v1);
    expect(state().selectedAssetIds).toEqual([assetA]);
  });

  it('and survives opening that media in the source monitor', () => {
    state().selectTrack(f.v1);
    state().previewAsset(assetA);

    expect(state().selectedTrackId).toBe(f.v1);
    expect(state().selection).toEqual([]);
  });
});

describe('placing media on the timeline', () => {
  /*
   * The gesture ends with a clip, so the clip is what it leaves selected. Leaving
   * the library item lit meant the thing just placed was not the thing selected —
   * and the next Delete was aimed at the media rather than at the clip.
   */
  it('selects the clip it just made, and lets go of the media', () => {
    state().selectAssets([assetA]);
    state().dropAssetOnTrack(assetA, f.v1, sec(20));

    expect(state().selectedAssetIds).toEqual([]);
    expect(state().selection.length).toBeGreaterThan(0);
  });

  it('selects the picture and its sound together for a clip that carries both', () => {
    // The fixture's asset has video and audio, so placing it makes a linked pair.
    state().dropAssetOnTrack(assetA, f.v1, sec(20));

    const project = state().project();
    const selected = state().selection.map((id) => project.clips[id]!);
    expect(selected.length).toBe(2);
    expect(new Set(selected.map((c) => c.kind))).toEqual(new Set(['video', 'audio']));
    // One unit, so a later move or delete takes the pair.
    expect(new Set(selected.map((c) => c.linkGroupId)).size).toBe(1);
  });

  it('selects what the library add-to-timeline action places too', async () => {
    state().selectAssets([assetB]);
    await state().addAssetToTimeline(assetB);

    expect(state().selectedAssetIds).toEqual([]);
    expect(state().selection.length).toBeGreaterThan(0);
  });
});

describe('generating a clip from nothing', () => {
  it('selects the title it just added', () => {
    state().selectAssets([assetA]);
    state().addTitle('Hello');

    const project = state().project();
    const selected = state().selection.map((id) => project.clips[id]!);
    expect(selected.map((c) => c.kind)).toEqual(['title']);
    expect(state().selectedAssetIds).toEqual([]);
  });

  it('selects the colour it just added', () => {
    state().addSolid('#1f6feb');

    const project = state().project();
    const selected = state().selection.map((id) => project.clips[id]!);
    expect(selected.map((c) => c.kind)).toEqual(['solid']);
  });

  it('selects it on the new track too, when the one below was busy', () => {
    // The plan lands on the topmost video track when it is free, and makes one
    // above when it is not — two different command lists, so the id has to survive
    // both. Fill the top track under the play head to take the second branch.
    state().run(
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(4), name: 'top' }),
      'busy top track',
    );
    state().setPlayhead(sec(1));
    const tracksBefore = state().project().sequences[f.seqId]!.videoTrackIds.length;

    state().addTitle('Over the top');

    const project = state().project();
    expect(project.sequences[f.seqId]!.videoTrackIds.length).toBe(tracksBefore + 1);
    const selected = state().selection.map((id) => project.clips[id]!);
    expect(selected.length).toBe(1);
    expect(selected[0]!.kind).toBe('title');
    // The id named by the plan is a clip that really landed, on the track just made.
    expect(project.tracks[selected[0]!.trackId]!.clipIds).toContain(selected[0]!.id);
  });
});
