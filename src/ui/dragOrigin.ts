import * as T from '../model/time';
import type { Clip, ClipId, Project, Time, TrackId } from '../model/types';

/** The immutable placement captured when a clip move begins. */
export interface ClipDragOrigin {
  readonly clipId: ClipId;
  readonly trackId: TrackId;
  readonly start: Time;
  readonly duration: Time;
}

/**
 * Clips as lane-level controls should see them during a move gesture.
 *
 * A move updates the document continuously, which is useful for the drop preview but
 * would otherwise carry fades, cut buttons, and clip gain along with it. Those
 * controls belong to the translucent origin ghost until the drop is committed.
 */
export function clipsForDragOrigin(
  project: Project,
  trackId: TrackId,
  origins: readonly ClipDragOrigin[] | null,
): readonly Clip[] {
  if (!origins) {
    return project.tracks[trackId]?.clipIds.map((id) => project.clips[id]!).filter(Boolean) ?? [];
  }

  const originById = new Map(origins.map((origin) => [origin.clipId, origin]));
  return Object.values(project.clips)
    .map((clip) => {
      const origin = originById.get(clip.id);
      return origin
        ? { ...clip, trackId: origin.trackId, start: origin.start, duration: origin.duration }
        : clip;
    })
    .filter((clip) => clip.trackId === trackId)
    .sort((left, right) => T.cmp(left.start, right.start));
}
