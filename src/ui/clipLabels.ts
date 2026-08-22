/**
 * Label colours for timeline clips.
 *
 * A clip's colour in the timeline is a way of finding it again, not part of what it
 * renders — the picture a colour clip produces is its `fill`, and this never touches
 * that. `ClipBase.color` has carried the field all along, commented "label colour",
 * with nothing reading it; this is what reads it.
 *
 * A fixed set rather than a free picker, which is what Premiere, Resolve and Final
 * Cut all settled on. An arbitrary colour is free to come out unreadable against one
 * of the two themes, to fight the accent the selection outline is drawn in, or to
 * land on exactly the fill of a neighbouring colour clip — which is the ambiguity the
 * kind marks were added to end, walked straight back in.
 */

import type { Clip } from '../model/types';

export interface ClipLabel {
  readonly name: string;
  /** Stored on the clip as-is, so a project keeps its colours without a lookup. */
  readonly color: string;
}

/*
 * Eight hues, spaced around the wheel and held at a similar weight so no one of them
 * shouts. Mid-toned on purpose: the white text and marks on a clip have to stay
 * legible, and so does the accent outline that says a clip is selected.
 */
export const CLIP_LABELS: readonly ClipLabel[] = [
  { name: 'Rose', color: '#c2456b' },
  { name: 'Amber', color: '#c07f2a' },
  { name: 'Olive', color: '#7a8f2e' },
  { name: 'Green', color: '#3f9e63' },
  { name: 'Teal', color: '#2f8f9e' },
  { name: 'Blue', color: '#3d6fd4' },
  { name: 'Violet', color: '#7d5cd6' },
  { name: 'Slate', color: '#5f6b7a' },
];

export function clipLabelName(color: string | null): string | null {
  return CLIP_LABELS.find((label) => label.color === color)?.name ?? null;
}

/** The two-stop wash the kind colours use, derived so a label matches their weight. */
export function labelGradient(color: string): string {
  return `linear-gradient(${color}, color-mix(in srgb, ${color} 74%, #000))`;
}

/**
 * What to paint a clip, or nothing when its kind's own stylesheet rule should stand.
 *
 * A label wins over a colour clip's fill deliberately: once a clip is labelled, the
 * label is what you are scanning for, and the kind mark still says it is a colour.
 * The rendered output is untouched either way.
 */
export function clipBackground(clip: Clip): { background: string } | undefined {
  if (clip.color) return { background: labelGradient(clip.color) };
  if (clip.kind === 'solid') return { background: clip.fill };
  return undefined;
}
