/**
 * Label colours: what a clip is painted in the timeline, and what that must not touch.
 */

import { describe, expect, it } from 'vitest';
import type { Clip } from '../model/types';
import { CLIP_LABELS, clipBackground, clipLabelName, labelGradient } from './clipLabels';

/** Enough of a clip for the painter; the rest is irrelevant to it. */
function clip(partial: Partial<Clip> & Pick<Clip, 'kind'>): Clip {
  return { color: null, ...partial } as Clip;
}

describe('the palette', () => {
  it('is a fixed set, so a label can never be an arbitrary colour', () => {
    expect(CLIP_LABELS.length).toBe(8);
    for (const label of CLIP_LABELS) {
      expect(label.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has no two labels the same, by name or by colour', () => {
    expect(new Set(CLIP_LABELS.map((l) => l.name)).size).toBe(CLIP_LABELS.length);
    expect(new Set(CLIP_LABELS.map((l) => l.color)).size).toBe(CLIP_LABELS.length);
  });

  it('names a colour it knows, and says nothing about one it does not', () => {
    expect(clipLabelName(CLIP_LABELS[0]!.color)).toBe(CLIP_LABELS[0]!.name);
    expect(clipLabelName('#123456')).toBeNull();
    expect(clipLabelName(null)).toBeNull();
  });
});

describe('what a clip is painted', () => {
  it('leaves an unlabelled media clip to its kind rule', () => {
    expect(clipBackground(clip({ kind: 'video' }))).toBeUndefined();
    expect(clipBackground(clip({ kind: 'audio' }))).toBeUndefined();
    expect(clipBackground(clip({ kind: 'title' }))).toBeUndefined();
  });

  it('paints an unlabelled colour clip its own fill', () => {
    expect(clipBackground(clip({ kind: 'solid', fill: '#1f6feb' }))).toEqual({
      background: '#1f6feb',
    });
  });

  it('lets a label win over the kind rule', () => {
    const painted = clipBackground(clip({ kind: 'title', color: '#7d5cd6' }));
    expect(painted).toEqual({ background: labelGradient('#7d5cd6') });
  });

  it('lets a label win over a colour clip’s fill as well', () => {
    // Once labelled, the label is what you are scanning for — and the kind mark on
    // the clip still says it is a colour.
    const painted = clipBackground(clip({ kind: 'solid', fill: '#1f6feb', color: '#c2456b' }));
    expect(painted).toEqual({ background: labelGradient('#c2456b') });
  });

  it('never reports the fill a colour clip renders as its label', () => {
    // The guarantee that matters: labelling is a timeline affordance, and the
    // picture the clip produces is untouched by it.
    const subject = clip({ kind: 'solid', fill: '#1f6feb', color: '#c2456b' });
    expect((subject as { fill: string }).fill).toBe('#1f6feb');
    expect(clipBackground(subject)!.background).not.toContain('#1f6feb');
  });
});
