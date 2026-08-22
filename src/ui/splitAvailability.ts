/**
 * Whether Split would do anything, and what to say when it would not.
 *
 * Transition already refuses to look pressable when there is no cut to put one on,
 * and explains why in its tooltip. Split did not: on an empty timeline, or with the
 * playhead parked in a gap, it stayed lit, did nothing when pressed, and gave no
 * account of itself. A control that looks live and answers nothing teaches a beginner
 * that the application is broken rather than that they are in the wrong place.
 *
 * The condition mirrors the command exactly rather than approximating it. `splitClips`
 * cuts a clip only where the playhead is strictly inside it — landing on a clip's
 * first or last frame splits nothing, because one of the halves would be empty — and
 * it refuses a locked track outright.
 */

import { clipEnd, getTrack, trackClips } from '../model/selectors';
import * as T from '../model/time';
import type { Project, Time, TrackId } from '../model/types';

/**
 * Whether this track has a clip the playhead falls strictly inside.
 *
 * Half-open at both ends on purpose: `start < at < end`. At exactly `start` the left
 * half would be nothing, and at exactly `end` the right half would be — which is to
 * say the cut is already there.
 */
export function trackSplitsAt(project: Project, trackId: TrackId, at: Time): boolean {
  if (getTrack(project, trackId).locked) return false;
  return trackClips(project, trackId).some(
    (clip) => T.lt(clip.start, at) && T.gt(clipEnd(clip), at),
  );
}

/** Whether any of these tracks would be cut. */
export function canSplitAt(
  project: Project,
  trackIds: readonly TrackId[],
  at: Time,
): boolean {
  return trackIds.some((trackId) => trackSplitsAt(project, trackId, at));
}

/**
 * What the button says.
 *
 * Three different situations, because "nothing to split" would be true of all of them
 * and useful in none: an empty timeline needs a different next step from a playhead
 * parked in a gap, and a locked track is not a mistake at all but a thing the person
 * did on purpose and may have forgotten.
 *
 * Takes the answer rather than the playhead, so the caller can work it out once —
 * against a position that changes sixty times a second — and spend it twice.
 */
export function splitHint(
  project: Project,
  trackIds: readonly TrackId[],
  canSplit: boolean,
  hasClips: boolean,
): string {
  if (canSplit) return 'Split at the playhead (S)';
  if (!hasClips) return 'Nothing on the timeline to split yet';
  const allLocked =
    trackIds.length > 0 && trackIds.every((trackId) => getTrack(project, trackId).locked);
  if (allLocked) return 'Every track here is locked — unlock one to split it';
  return 'Move the playhead over a clip to split it';
}
