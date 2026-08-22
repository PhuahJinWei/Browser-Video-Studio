/**
 * Clips the project makes for itself — a title, a colour — as things you can browse
 * and drag, rather than buttons that drop something at the play head.
 *
 * These are templates, not library items. A generator has no source, no duration of
 * its own and nothing to relink, so it is deliberately not an `Asset`: every drop
 * builds a fresh, independent clip that owns its text and its colour outright, and
 * editing one never reaches another. That is the shape Resolve and Final Cut settled
 * on, and it is the one this model already implies — `TitleClip` and `SolidClip`
 * carry their content inline, with no id pointing anywhere else.
 */

import type { NewClipSpec } from '../model/commands';
import * as T from '../model/time';
import type { Time } from '../model/types';

/** Carried by the drag, and kept apart from the media bin's own type. */
export const GENERATOR_DRAG_TYPE = 'application/x-bvs-generator';

export type GeneratorId = 'title' | 'solid';

export interface Generator {
  readonly id: GeneratorId;
  readonly label: string;
  /** One line under the name, saying what dropping it will get you. */
  readonly hint: string;
  /** How long the clip arrives, before anyone trims it. */
  readonly duration: Time;
  /** Everything a generated clip needs beyond where it goes. */
  spec(start: Time, duration: Time): NewClipSpec;
}

/** The length a generated clip arrives at, matching what the toolbar always used. */
const DEFAULT_SECONDS = 3;

export const GENERATORS: readonly Generator[] = [
  {
    id: 'title',
    label: 'Title',
    hint: 'Text over the picture',
    duration: T.time(DEFAULT_SECONDS),
    spec: (start, duration) => ({ kind: 'title', start, duration, text: 'Title', name: 'Title' }),
  },
  {
    id: 'solid',
    label: 'Colour',
    hint: 'A solid background',
    duration: T.time(DEFAULT_SECONDS),
    spec: (start, duration) => ({ kind: 'solid', start, duration, fill: '#1f6feb', name: 'Colour' }),
  },
];

export function generatorById(id: string): Generator | null {
  return GENERATORS.find((generator) => generator.id === id) ?? null;
}
