/**
 * What dropping into one of the timeline's insert gaps would build.
 *
 * Kept out of the timeline itself because two places need the same answer and must
 * not disagree: the ghosts drawn while the pointer is still down, and the commands
 * run when it comes up. A preview that shows one thing and a drop that does another
 * is worse than no preview at all.
 *
 * The rule is the one a cross-track drag already follows (see `trackShift.ts`): the
 * clip under the pointer moves some number of steps through its own stack, and every
 * other member of the selection takes the *same* step through its own — so the
 * selection keeps its shape. A gap drop is that gesture carried one step further,
 * past the end of the stack, and the only thing new about it is that a step landing
 * off the end needs a track made for it. Members that land inside the stack go to
 * the track that is already there, exactly as they would have a row lower down.
 *
 * Before this the grabbed clip went to a new track and the rest of its kind stayed
 * put, which broke a multi-track selection the moment it was lifted past the top —
 * the one gesture a cross-track drag had been careful to keep together.
 */

import { clipFitsTrack } from '../model/selectors';
import type { Clip, ClipId, Project, TrackId, TrackKind } from '../model/types';

/** A track a gap drop would create, and which gap stands for it on screen. */
export interface PlannedTrack {
  readonly kind: TrackKind;
  readonly index: number;
  readonly side: 'above' | 'below';
}

/** Where one member of the unit ends up. */
export type GapDestination =
  | { readonly track: TrackId }
  /** Index into `GapPlan.newTracks`. */
  | { readonly newTrack: number };

export interface GapMove {
  readonly clip: Clip;
  readonly to: GapDestination;
}

export interface GapPlan {
  readonly primary: Clip;
  /** Tracks to make, in the order `newTrack` indices refer to them. */
  readonly newTracks: readonly PlannedTrack[];
  /** Every member of the unit, including the primary. */
  readonly moves: readonly GapMove[];
}

/** The gap the pointer is in, as the timeline reports it. */
export interface GapTarget {
  readonly where: 'above' | 'below';
  readonly trackKind: TrackKind;
  readonly index: number;
}

/**
 * Where each member was when the drag began.
 *
 * The plan has to be measured from there rather than from the live document: the
 * drag moves members through the document on every pointer event, and a member
 * that has already been stepped to its destination would otherwise be stepped
 * again the next time the plan was asked for.
 */
export interface MemberOrigin {
  readonly clipId: ClipId;
  readonly trackId: TrackId;
}

function trackKindFor(clip: Clip): TrackKind {
  return clipFitsTrack(clip.kind, 'video') ? 'video' : 'audio';
}

export function planGapInsert(
  project: Project,
  sequence: {
    readonly videoTrackIds: readonly TrackId[];
    readonly audioTrackIds: readonly TrackId[];
  },
  clipId: ClipId,
  origins: readonly MemberOrigin[],
  target: GapTarget,
): GapPlan | null {
  const primary = project.clips[clipId];
  if (!primary) return null;
  const primaryOrigin = origins.find((o) => o.clipId === clipId)?.trackId ?? primary.trackId;

  const lists: Record<TrackKind, readonly TrackId[]> = {
    video: sequence.videoTrackIds,
    audio: sequence.audioTrackIds,
  };

  // The step is the primary's, counted in its own stack. The gap sits past the end
  // of that stack, so this is at least one; the guard is for a target index that
  // somehow is not, where stepping by nothing would plan no new track at all.
  const primaryKind = trackKindFor(primary);
  const from = lists[primaryKind].indexOf(primaryOrigin);
  const step = Math.max(1, target.index - (from < 0 ? lists[primaryKind].length - 1 : from));

  // First pass: where each member wants to be, as an index into its own stack.
  // Anything past the end is collected per kind so the tracks can be laid out in
  // one go below.
  interface Wanted {
    readonly clip: Clip;
    readonly kind: TrackKind;
    readonly index: number;
  }
  const wanted: Wanted[] = [];
  const stays: GapMove[] = [];
  for (const origin of origins) {
    const clip = project.clips[origin.clipId];
    if (!clip) continue;
    const kind = trackKindFor(clip);
    const at = lists[kind].indexOf(origin.trackId);
    if (at < 0) {
      stays.push({ clip, to: { track: clip.trackId } });
      continue;
    }
    wanted.push({ clip, kind, index: at + step });
  }

  /*
   * Off-the-end landings are compacted, not laid out literally.
   *
   * Taken literally, a selection on V1 and V2 lifted two rows past the top would
   * ask for V4 and V5 with nothing on V3 — a step through a track that does not
   * exist yet has no meaning, so the distinct rows that fall past the end become
   * consecutive new tracks in the same order. The shape survives (two rows stay
   * two rows, one above the other) without leaving an empty lane between them.
   */
  const newTracks: PlannedTrack[] = [];
  const newTrackFor = new Map<string, number>();
  for (const kind of ['video', 'audio'] as const) {
    const length = lists[kind].length;
    const offEnd = [...new Set(wanted.filter((w) => w.kind === kind && w.index >= length).map((w) => w.index))]
      .sort((a, b) => a - b);
    offEnd.forEach((index, j) => {
      newTrackFor.set(`${kind}:${index}`, newTracks.length);
      newTracks.push({ kind, index: length + j, side: kind === 'video' ? 'above' : 'below' });
    });
  }

  const moves: GapMove[] = [...stays];
  for (const w of wanted) {
    const list = lists[w.kind];
    if (w.index < list.length) {
      const trackId = list[w.index]!;
      // The same fallback a cross-track drag uses: a step onto a locked track is a
      // step not taken, and the member stays where it is rather than the whole
      // gesture being refused for it.
      moves.push({ clip: w.clip, to: { track: project.tracks[trackId]?.locked ? w.clip.trackId : trackId } });
    } else {
      moves.push({ clip: w.clip, to: { newTrack: newTrackFor.get(`${w.kind}:${w.index}`)! } });
    }
  }

  return { primary, newTracks, moves };
}

/** The member's destination, or null when it is not in the plan. */
export function gapDestination(plan: GapPlan, clipId: ClipId): GapDestination | null {
  return plan.moves.find((m) => m.clip.id === clipId)?.to ?? null;
}
