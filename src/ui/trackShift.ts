/**
 * Where the rest of a dragged unit goes when the clip under the pointer changes
 * track.
 *
 * A linked pair that comes apart the moment you move the picture down a lane is not
 * linked in the way the word promises, so the sound follows by the same step through
 * its own stack. The step is counted in each kind's own track list rather than in
 * display rows, which is what keeps V2/A2 together as they move to V1/A1: both lists
 * run outward from the pair of lanes that meet in the middle.
 */

import type { Project, TrackId } from '../model/types';

export interface TrackLists {
  readonly videoTrackIds: readonly TrackId[];
  readonly audioTrackIds: readonly TrackId[];
}

function listFor(sequence: TrackLists, trackId: TrackId): readonly TrackId[] {
  return sequence.videoTrackIds.includes(trackId) ? sequence.videoTrackIds : sequence.audioTrackIds;
}

/**
 * `member`'s track after the dragged clip moved `from` → `to`.
 *
 * Falls back to leaving the member where it is when the step would run off the end
 * of its stack or onto a locked track — a two-video/one-audio project should still
 * let the picture change lanes, just without the sound having anywhere to follow to.
 */
export function shiftedTrack(
  project: Project,
  sequence: TrackLists,
  from: TrackId,
  to: TrackId,
  member: TrackId,
): TrackId {
  if (from === to) return member;

  const dragged = listFor(sequence, from);
  const step = dragged.indexOf(to) - dragged.indexOf(from);
  if (step === 0) return member;

  const own = listFor(sequence, member);
  const at = own.indexOf(member);
  if (at < 0) return member;

  const wanted = own[at + step];
  if (!wanted) return member;
  return project.tracks[wanted]?.locked ? member : wanted;
}
