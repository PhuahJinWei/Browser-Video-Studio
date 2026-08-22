/**
 * Saved title and colour presets.
 *
 * A generator is a template that always makes the same thing; a preset is one you
 * made — the styled lower-third you want ten times. Saving one captures a clip's
 * look, and dragging it in mints a fresh, independent clip, exactly as the built-in
 * generators do. Editing the preset afterwards does not reach back into clips
 * already placed from it, which is what Resolve's media-pool titles and Premiere's
 * motion-graphics templates both do.
 *
 * Kept beside the layout in local storage rather than in the document. A preset is
 * part of a person's kit, not of one project's content: it should still be there in
 * the next project, and it has no business on the undo stack or in a saved file.
 */

import { create } from 'zustand';
import * as T from '../model/time';
import type { Command, NewClipSpec } from '../model/commands';
import type { ClipId, SolidClip, Time, TitleClip, TrackId } from '../model/types';

/** Carried by the drag, and kept apart from the media bin's and the generators'. */
export const PRESET_DRAG_TYPE = 'application/x-bvs-preset';

const STORAGE_KEY = 'bvs.presets.v1';

export interface TitlePreset {
  readonly id: string;
  readonly name: string;
  readonly kind: 'title';
  readonly seconds: number;
  readonly text: string;
  readonly style: TitleClip['style'];
}

export interface SolidPreset {
  readonly id: string;
  readonly name: string;
  readonly kind: 'solid';
  readonly seconds: number;
  readonly fill: string;
}

export type ClipPreset = TitlePreset | SolidPreset;

/** What a preset is worth to the timeline while it is being dragged. */
export function presetDuration(preset: ClipPreset): Time {
  return T.fromSeconds(preset.seconds, 1000);
}

/**
 * The clip a preset makes, before anyone decides which track it goes on.
 *
 * Split from the commands below so both routes in can share it: a drop knows its
 * track, while adding at the play head has to be told one by `planGenerated`.
 */
export function presetClipSpec(preset: ClipPreset, start: Time, clipId?: ClipId): NewClipSpec {
  const duration = presetDuration(preset);
  const named = { start, duration, name: preset.name, ...(clipId ? { clipId } : {}) };
  return preset.kind === 'solid'
    ? { kind: 'solid', fill: preset.fill, ...named }
    : { kind: 'title', text: preset.text, ...named };
}

/**
 * The look that `insertClip` has no room to carry.
 *
 * A title's style has to be applied to the clip once it exists. Kept in the same
 * batch as the insert, so it is one undo step and never half-applied.
 */
export function presetStyleCommands(preset: ClipPreset, clipId: ClipId): readonly Command[] {
  return preset.kind === 'title'
    ? [{ type: 'setTitleProps', clipId, style: preset.style }]
    : [];
}

/** Everything it takes to put a preset on a track you have already chosen. */
export function presetCommands(
  preset: ClipPreset,
  trackId: TrackId,
  start: Time,
  clipId: ClipId,
): readonly Command[] {
  return [
    { type: 'insertClip', trackId, mode: 'overwrite', clip: presetClipSpec(preset, start, clipId) },
    ...presetStyleCommands(preset, clipId),
  ];
}

/** Capture a clip's look. Returns null for a clip that has no look to capture. */
export function presetFromClip(
  clip: TitleClip | SolidClip,
  name: string,
  id: string,
): ClipPreset {
  const seconds = T.toSeconds(clip.duration);
  return clip.kind === 'title'
    ? { id, name, kind: 'title', seconds, text: clip.text, style: clip.style }
    : { id, name, kind: 'solid', seconds, fill: clip.fill };
}

interface PresetState {
  readonly presets: readonly ClipPreset[];
  save: (preset: ClipPreset) => void;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
}

/** Read what was stored, ignoring anything that does not look like a preset. */
function load(): readonly ClipPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ClipPreset => {
      if (typeof entry !== 'object' || entry === null) return false;
      const candidate = entry as Partial<ClipPreset>;
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.seconds === 'number' &&
        (candidate.kind === 'title' || candidate.kind === 'solid')
      );
    });
  } catch {
    // A corrupt or unreadable store is not worth failing the app over.
    return [];
  }
}

function persist(presets: readonly ClipPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Full or blocked storage: the presets still work for this session.
  }
}

export const usePresets = create<PresetState>((set, get) => ({
  presets: load(),

  save: (preset) => {
    // Newest first: the one just saved is the one being looked for.
    const presets = [preset, ...get().presets.filter((entry) => entry.id !== preset.id)];
    set({ presets });
    persist(presets);
  },

  remove: (id) => {
    const presets = get().presets.filter((entry) => entry.id !== id);
    set({ presets });
    persist(presets);
  },

  rename: (id, name) => {
    const presets = get().presets.map((entry) => (entry.id === id ? { ...entry, name } : entry));
    set({ presets });
    persist(presets);
  },
}));
