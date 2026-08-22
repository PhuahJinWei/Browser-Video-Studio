/**
 * What the clip inspector says it is editing, and which group opens itself.
 */

import { describe, expect, it } from 'vitest';
import {
  groupStartsOpen,
  primaryGroup,
  subjectLabel,
  type ClipKind,
  type UnitHalves,
} from './inspectorGroups';

const both: UnitHalves = { visual: true, audio: true };
const pictureOnly: UnitHalves = { visual: true, audio: false };
const soundOnly: UnitHalves = { visual: false, audio: true };
const neither: UnitHalves = { visual: false, audio: false };

describe('the group that opens', () => {
  it('opens the words for a title', () => {
    expect(primaryGroup('title', pictureOnly)).toBe('title');
  });

  it('opens the swatch for a colour', () => {
    expect(primaryGroup('solid', pictureOnly)).toBe('colour');
  });

  it('opens the picture controls for footage', () => {
    expect(primaryGroup('video', both)).toBe('video');
    expect(primaryGroup('image', pictureOnly)).toBe('video');
    expect(primaryGroup('nested', pictureOnly)).toBe('video');
  });

  it('opens the sound for a clip that is only sound', () => {
    expect(primaryGroup('audio', soundOnly)).toBe('audio');
  });

  /*
   * The regression this exists to prevent.
   *
   * Clicking the sound half of a linked pair used to open the picture controls,
   * because the choice was made from the unit's visual half rather than from what was
   * pointed at — so the panel answered a question nobody had asked and hid the one
   * they had.
   */
  it('opens the sound when the sound half of a pair is the one clicked', () => {
    expect(primaryGroup('audio', both)).toBe('audio');
  });

  it('opens the picture when the picture half of the same pair is clicked', () => {
    expect(primaryGroup('video', both)).toBe('video');
    expect(primaryGroup('title', both)).toBe('title');
  });

  it('opens nothing when there is nothing to open', () => {
    expect(primaryGroup('video', neither)).toBe(null);
    expect(primaryGroup('audio', neither)).toBe(null);
  });

  /* Defensive: a group that is not rendered must never be the one chosen. */
  it('never names a group the unit does not have', () => {
    const kinds: ClipKind[] = ['video', 'audio', 'title', 'solid', 'image', 'nested'];
    for (const kind of kinds) {
      for (const halves of [both, pictureOnly, soundOnly, neither]) {
        const primary = primaryGroup(kind, halves);
        if (primary === 'audio') expect(halves.audio).toBe(true);
        if (primary && primary !== 'audio') expect(halves.visual).toBe(true);
      }
    }
  });

  it('opens at most one group', () => {
    const kinds: ClipKind[] = ['video', 'audio', 'title', 'solid', 'image', 'nested'];
    for (const kind of kinds) {
      for (const halves of [both, pictureOnly, soundOnly, neither]) {
        const primary = primaryGroup(kind, halves);
        const opened = (['title', 'colour', 'video', 'audio'] as const).filter((group) =>
          groupStartsOpen(group, primary),
        );
        expect(opened.length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('whether a group starts open', () => {
  it('opens the primary one and no other', () => {
    expect(groupStartsOpen('title', 'title')).toBe(true);
    expect(groupStartsOpen('video', 'title')).toBe(false);
    expect(groupStartsOpen('audio', 'title')).toBe(false);
    expect(groupStartsOpen('colour', 'title')).toBe(false);
  });

  it('opens none when there is no primary', () => {
    for (const group of ['title', 'colour', 'video', 'audio'] as const) {
      expect(groupStartsOpen(group, null)).toBe(false);
    }
  });
});

describe('what the panel says it is editing', () => {
  it('names a lone clip by kind', () => {
    expect(subjectLabel('audio', 1, null)).toBe('Audio clip');
    expect(subjectLabel('video', 1, null)).toBe('Video clip');
    expect(subjectLabel('title', 1, null)).toBe('Title');
    expect(subjectLabel('solid', 1, null)).toBe('Colour');
    expect(subjectLabel('image', 1, null)).toBe('Image');
  });

  /*
   * The half that was clicked comes first, then the tie that brought the rest — which
   * is the answer to "why is there a Video section on my audio clip".
   */
  it('names the clicked half first, then the tie', () => {
    expect(subjectLabel('audio', 2, 'linked')).toBe('Audio clip · linked with 1 other');
    expect(subjectLabel('video', 2, 'linked')).toBe('Video clip · linked with 1 other');
  });

  it('counts more than one other in the plural', () => {
    expect(subjectLabel('title', 3, 'grouped')).toBe('Title · grouped with 2 others');
  });

  it('ignores a relation that has nothing on the other end', () => {
    expect(subjectLabel('audio', 1, 'linked')).toBe('Audio clip');
  });

  it('always says something', () => {
    const kinds: ClipKind[] = ['video', 'audio', 'title', 'solid', 'image', 'nested'];
    for (const kind of kinds) {
      for (const size of [1, 2, 5]) {
        for (const relation of [null, 'linked', 'grouped'] as const) {
          expect(subjectLabel(kind, size, relation).length).toBeGreaterThan(0);
        }
      }
    }
  });
});
