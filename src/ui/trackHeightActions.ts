/**
 * Setting track heights, from wherever the request comes.
 *
 * The toolbar's slider had these to itself; the resize seam and the pane divider now
 * offer the same things from their own menus, and three copies of "which tracks, and
 * what height" would be three chances to disagree.
 */

import { clampTrackHeight, trackHeightToFit } from './trackHeight';
import type { Command } from '../model/commands';
import type { Project, SequenceId, TrackKind } from '../model/types';

/**
 * Set every track in a sequence to one height, or only those of one kind.
 *
 * Returns nothing for tracks already at that height, so a no-op edit never reaches
 * the undo stack.
 */
export function setTrackHeightCommands(
  project: Project,
  sequenceId: SequenceId,
  height: number,
  kind?: TrackKind,
): readonly Command[] {
  const sequence = project.sequences[sequenceId];
  if (!sequence) return [];

  const trackIds =
    kind === 'video'
      ? sequence.videoTrackIds
      : kind === 'audio'
        ? sequence.audioTrackIds
        : [...sequence.videoTrackIds, ...sequence.audioTrackIds];

  const clamped = clampTrackHeight(height);
  return trackIds
    .map((trackId) => project.tracks[trackId])
    .filter((track) => track !== undefined && track.height !== clamped)
    .map((track) => ({
      type: 'setTrackProps' as const,
      trackId: track!.id,
      props: { height: clamped },
    }));
}

/**
 * The height that would show every track in both stacks at once, or null when
 * nothing can be measured yet.
 *
 * Reads the panes rather than computing from the window: they are split by a divider
 * the user can drag, so how much room each has is a question only the layout can
 * answer.
 */
export function measuredFitHeight(project: Project, sequenceId: SequenceId): number | null {
  const sequence = project.sequences[sequenceId];
  if (!sequence) return null;

  const videoPane = document.querySelector<HTMLElement>('.timeline-pane.video');
  const audioPane = document.querySelector<HTMLElement>('.timeline-pane.audio');
  return trackHeightToFit([
    { height: videoPane?.clientHeight ?? 0, trackCount: sequence.videoTrackIds.length },
    { height: audioPane?.clientHeight ?? 0, trackCount: sequence.audioTrackIds.length },
  ]);
}
