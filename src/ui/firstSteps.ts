/**
 * The first three moves, for someone who has never opened a video editor.
 *
 * The application already said "import media" in three places — the library's empty
 * card, the preview, and the status bar — in three different wordings, and not one of
 * them said what to do afterwards. Three ways of phrasing the same first step is not
 * three times the help; it is one step repeated, and a person who has done it is left
 * exactly where they were.
 *
 * What a newcomer is missing is not the name of the first action but the shape of the
 * whole job: media comes in, it goes on the timeline, the timeline becomes a file.
 * Three lines, with the one they are on marked, is enough to see that shape — and it
 * is why the list shows all three from the start rather than revealing them in turn.
 * A step that only appears once you no longer need it teaches nothing.
 *
 * It is not dismissible on purpose. Progress dismisses it: put a clip on the timeline
 * and the preview has a picture to show instead, which is the same moment the list
 * stops being worth its space.
 */

export type FirstStepKey = 'import' | 'arrange' | 'export';

/** Done and behind you, the one to do now, or still ahead. */
export type FirstStepState = 'done' | 'now' | 'later';

export interface FirstStep {
  readonly key: FirstStepKey;
  readonly title: string;
  /** How to do it, naming the actual control rather than describing it. */
  readonly detail: string;
}

export const FIRST_STEPS: readonly FirstStep[] = [
  {
    key: 'import',
    title: 'Bring in your media',
    detail: 'Drop a video, image or sound file anywhere in the window — or press Ctrl+I.',
  },
  {
    key: 'arrange',
    title: 'Put it on the timeline',
    detail: 'Drag it down from the Library, or select it and choose Add to timeline.',
  },
  {
    key: 'export',
    title: 'Save it as a video file',
    detail: 'Press Ctrl+E when you like what you see. Nothing leaves your computer.',
  },
];

export interface StudioProgress {
  /** Anything at all in the library. */
  readonly hasMedia: boolean;
  /** Anything at all on the timeline. */
  readonly hasClips: boolean;
}

/**
 * Each step paired with where the person stands on it.
 *
 * The current step is the first one not yet done, so removing every clip puts the
 * mark back on "Put it on the timeline" rather than stranding it further down. Export
 * is never marked done here: this list is gone by the time anyone could do it, and a
 * tick nobody can see is not worth the state it would take to track.
 */
export function firstStepStates(
  progress: StudioProgress,
): readonly { readonly step: FirstStep; readonly state: FirstStepState }[] {
  const done: Record<FirstStepKey, boolean> = {
    import: progress.hasMedia,
    arrange: progress.hasClips,
    export: false,
  };
  const current = FIRST_STEPS.find((step) => !done[step.key]);
  return FIRST_STEPS.map((step) => ({
    step,
    state: done[step.key] ? 'done' : step.key === current?.key ? 'now' : 'later',
  }));
}
