/**
 * What dropping into one of the timeline's insert gaps would build.
 *
 * Kept out of the timeline itself because two places need the same answer and must
 * not disagree: the ghosts drawn while the pointer is still down, and the commands
 * run when it comes up. A preview that shows one thing and a drop that does another
 * is worse than no preview at all.
 */

import { clipFitsTrack } from '../model/selectors';
import type { Clip, ClipId, Project, TrackId, TrackKind } from '../model/types';

/** A track a gap drop would create, and which gap stands for it on screen. */
export interface PlannedTrack {
  readonly kind: TrackKind;
  readonly index: number;
  readonly side: 'above' | 'below';
}

export interface GapPlan {
  readonly primary: Clip;
  readonly primaryTrack: PlannedTrack;
  /** Members of the dragged unit that belong on a track of the opposite kind. */
  readonly partners: readonly Clip[];
  readonly partnerTrack: PlannedTrack | null;
}

/** The gap the pointer is in, as the timeline reports it. */
export interface GapTarget {
  readonly where: 'above' | 'below';
  readonly trackKind: TrackKind;
  readonly index: number;
}

function trackKindFor(clip: Clip): TrackKind {
  return clipFitsTrack(clip.kind, 'video') ? 'video' : 'audio';
}

/**
 * A linked pair gets *two* tracks, not one.
 *
 * Moving only the half under the pointer and leaving its sound on whichever lane it
 * happened to be on breaks the pair for the sake of the gesture, and the media bin
 * already makes both tracks when an A/V asset is dropped the same way — this is the
 * timeline half of that behaviour.
 *
 * When the unit does span both kinds it brackets the whole stack — picture above
 * every video lane, sound below every audio one — whichever gap was aimed at. That
 * is what puts one ghost in each gap: the two gaps *are* the two ends, so there is
 * no third place for the other half to go. A clip with no partner of the opposite
 * kind keeps the plain behaviour of the gap it was actually dropped into.
 */
export function planGapInsert(
  project: Project,
  sequence: {
    readonly videoTrackIds: readonly TrackId[];
    readonly audioTrackIds: readonly TrackId[];
  },
  clipId: ClipId,
  unitIds: readonly ClipId[],
  target: GapTarget,
): GapPlan | null {
  const primary = project.clips[clipId];
  if (!primary) return null;

  const primaryKind = trackKindFor(primary);
  const partners = unitIds
    .map((id) => project.clips[id])
    .filter((c): c is Clip => c !== undefined && c.id !== primary.id && trackKindFor(c) !== primaryKind);

  if (partners.length === 0) {
    return {
      primary,
      primaryTrack: { kind: target.trackKind, index: target.index, side: target.where },
      partners,
      partnerTrack: null,
    };
  }

  // Display order reverses the video list, so the top of the video stack is the end
  // of `videoTrackIds`; the bottom of the audio stack is the end of its own.
  const video: PlannedTrack = { kind: 'video', index: sequence.videoTrackIds.length, side: 'above' };
  const audio: PlannedTrack = { kind: 'audio', index: sequence.audioTrackIds.length, side: 'below' };
  return primaryKind === 'video'
    ? { primary, primaryTrack: video, partners, partnerTrack: audio }
    : { primary, primaryTrack: audio, partners, partnerTrack: video };
}
