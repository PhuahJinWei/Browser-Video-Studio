/**
 * What the clip inspector says it is editing, and which group opens itself.
 *
 * Two problems with one cause: the panel described the *unit* rather than the clip
 * that was clicked. Selecting the sound half of a linked pair opened the picture
 * controls and collapsed the sound, and nothing on screen said why — the panel just
 * showed a Video section for what the person believed was an audio clip.
 *
 * A linked pair genuinely is one subject, and editing either half should keep the
 * other in step; that part was right. What was missing is that a person still clicked
 * one of the two, and the panel owes them an answer to "which one am I looking at".
 * So the subject is named, and the group that opens is the half they pointed at.
 */

/** The kinds a clip can be. */
export type ClipKind = 'video' | 'audio' | 'title' | 'solid' | 'image' | 'nested';

export type PrimaryGroup = 'title' | 'colour' | 'video' | 'audio' | null;

/** Which halves the selected unit actually has, so no absent group is opened. */
export interface UnitHalves {
  readonly visual: boolean;
  readonly audio: boolean;
}

/**
 * The one group worth opening, chosen by the clip that was clicked.
 *
 * Content before treatment: a title's words and a colour's swatch are what the clip
 * *is*, while opacity and position are things done to it afterwards. Footage has no
 * content panel of its own — the picture is in the file — so its transform is the
 * first thing there is to say about it.
 *
 * Clicking the sound half of a pair opens the sound. That is the whole reason a
 * person clicks the waveform rather than the picture above it.
 */
export function primaryGroup(focused: ClipKind, halves: UnitHalves): PrimaryGroup {
  if (focused === 'audio') {
    if (halves.audio) return 'audio';
    return halves.visual ? 'video' : null;
  }
  if (!halves.visual) return halves.audio ? 'audio' : null;
  if (focused === 'title') return 'title';
  if (focused === 'solid') return 'colour';
  return 'video';
}

/**
 * Whether a given group should start open.
 *
 * Effects are their own rule and stay out of this: a clip carrying effects is showing
 * work already done to it, and hiding that behind a summary makes it look untouched.
 */
export function groupStartsOpen(group: Exclude<PrimaryGroup, null>, primary: PrimaryGroup): boolean {
  return group === primary;
}

const KIND_LABEL: Readonly<Record<ClipKind, string>> = {
  video: 'Video clip',
  audio: 'Audio clip',
  title: 'Title',
  solid: 'Colour',
  image: 'Image',
  nested: 'Nested sequence',
};

/**
 * What the panel is editing, in the words a person would use.
 *
 * Names the clip that was clicked first, then the tie that brought the others along —
 * so the answer to "why is there a Video section on my audio clip" is the second half
 * of the first line, rather than something to be worked out from which sections
 * happen to be present.
 */
export function subjectLabel(
  focused: ClipKind,
  unitSize: number,
  relation: 'linked' | 'grouped' | null,
): string {
  const kind = KIND_LABEL[focused] ?? 'Clip';
  if (relation === null || unitSize <= 1) return kind;
  const others = unitSize - 1;
  return `${kind} · ${relation} with ${others} other${others === 1 ? '' : 's'}`;
}
