/**
 * Generators: templates that mint a clip, not library items that own one.
 *
 * The property that matters is independence. A bin item means one source and many
 * uses; a generator means the opposite, and the model relies on it — `TitleClip`
 * carries its text inline, so two drops must be two clips with nothing shared.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture, sec, type Fixture } from '../model/fixtures';
import { initHistory } from '../model/history';
import { GENERATORS, generatorById } from './generators';
import { useStudio } from './store';

let f: Fixture;

beforeEach(() => {
  f = makeFixture();
  useStudio.setState({
    history: initHistory(f.project),
    sequenceId: f.seqId,
    selection: [],
    selectionAnchor: null,
    selectedAssetIds: [],
    assetSelectionAnchor: null,
    selectedTrackId: null,
    selectedTransitionId: null,
    error: null,
  });
});

function state() {
  return useStudio.getState();
}

describe('the registry', () => {
  it('offers a title and a colour, each findable by id', () => {
    expect(GENERATORS.map((g) => g.id)).toEqual(['title', 'solid']);
    for (const generator of GENERATORS) {
      expect(generatorById(generator.id)).toBe(generator);
    }
  });

  it('does not answer for something it has never heard of', () => {
    expect(generatorById('sparkles')).toBeNull();
  });

  it('builds a clip at the position and length it is asked for', () => {
    const spec = generatorById('solid')!.spec(sec(5), sec(2));
    expect(spec.kind).toBe('solid');
    expect(spec.start).toEqual(sec(5));
    expect(spec.duration).toEqual(sec(2));
  });
});

describe('dropping one on a track', () => {
  it('lands it where it was pointed, and selects it', () => {
    state().dropGeneratorOnTrack('title', f.v1, sec(4));

    const project = state().project();
    const clips = Object.values(project.clips);
    expect(clips.length).toBe(1);
    expect(clips[0]!.kind).toBe('title');
    expect(clips[0]!.start).toEqual(sec(4));
    expect(state().selection).toEqual([clips[0]!.id]);
  });

  it('falls back to the play head when dropped without a position', () => {
    state().setPlayhead(sec(6));
    state().dropGeneratorOnTrack('solid', f.v1);

    expect(Object.values(state().project().clips)[0]!.start).toEqual(sec(6));
  });
});

describe('two drops from the same entry', () => {
  it('are two clips, and editing one leaves the other alone', () => {
    state().dropGeneratorOnTrack('title', f.v1, sec(0));
    state().dropGeneratorOnTrack('title', f.v1, sec(10));

    const [first, second] = Object.values(state().project().clips).sort(
      (a, b) => a.start.num / a.start.den - b.start.num / b.start.den,
    );
    expect(first!.id).not.toBe(second!.id);

    state().run({ type: 'setTitleProps', clipId: first!.id, text: 'Only this one' }, 'edit');

    const after = state().project().clips;
    expect((after[first!.id] as { text: string }).text).toBe('Only this one');
    expect((after[second!.id] as { text: string }).text).toBe('Title');
  });
});

describe('a generator aimed at the wrong kind of track', () => {
  it('is refused, with a reason rather than in silence', () => {
    state().dropGeneratorOnTrack('title', f.a1, sec(0));

    expect(Object.keys(state().project().clips)).toEqual([]);
    expect(state().error).toMatch(/video track/i);
  });

  it('is refused for a generator that does not exist, without an error line', () => {
    state().dropGeneratorOnTrack('sparkles' as never, f.v1, sec(0));

    expect(Object.keys(state().project().clips)).toEqual([]);
    expect(state().error).toBeNull();
  });
});

describe('the toolbar control, whose click and drag are the same thing', () => {
  it('puts one in at the play head when clicked', () => {
    state().setPlayhead(sec(2));
    state().addGeneratorAtPlayhead('title');

    const clips = Object.values(state().project().clips);
    expect(clips.length).toBe(1);
    expect(clips[0]!.start).toEqual(sec(2));
    expect(state().selection).toEqual([clips[0]!.id]);
  });

  it('uses the generator’s own default rather than asking for one', () => {
    state().addGeneratorAtPlayhead('title');

    const clip = Object.values(state().project().clips)[0]!;
    expect((clip as { text: string }).text).toBe('Title');
  });

  it('makes a track above when the one below is busy at the play head', () => {
    state().addGeneratorAtPlayhead('solid');
    const before = state().project().sequences[f.seqId]!.videoTrackIds.length;

    // Same play head, so the colour just placed is in the way.
    state().addGeneratorAtPlayhead('title');

    const project = state().project();
    expect(project.sequences[f.seqId]!.videoTrackIds.length).toBe(before + 1);
    const selected = state().selection.map((id) => project.clips[id]!);
    expect(selected.map((c) => c.kind)).toEqual(['title']);
  });

  it('ignores a generator it has never heard of', () => {
    state().addGeneratorAtPlayhead('sparkles' as never);
    expect(Object.keys(state().project().clips)).toEqual([]);
  });
});
