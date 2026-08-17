import { describe, expect, it } from 'vitest';
import { createProject } from '../model/factories';
import * as T from '../model/time';
import type { ClipId, Project, ProjectId, SequenceId, TrackId } from '../model/types';
import { clipsForDragOrigin } from './dragOrigin';

function withMovedClips(): {
  project: Project;
  video1: TrackId;
  video2: TrackId;
  moved: ClipId;
  stationary: ClipId;
} {
  const sequenceId = 'sequence' as SequenceId;
  const video1 = 'track-video-1' as TrackId;
  const base = createProject({
    id: 'project' as ProjectId,
    sequenceId,
    name: 'Drag controls',
    videoTrackIds: [video1],
  });
  const video2 = 'track-video-2' as TrackId;
  const moved = 'clip-moved' as ClipId;
  const stationary = 'clip-stationary' as ClipId;

  return {
    video1,
    video2,
    moved,
    stationary,
    project: {
      ...base,
      tracks: {
        ...base.tracks,
        [video1]: { ...base.tracks[video1]!, clipIds: [stationary] },
        [video2]: {
          id: video2,
          kind: 'video',
          name: 'Video 2',
          clipIds: [moved],
          transitionIds: [],
          height: 72,
          locked: false,
          muted: false,
          visible: true,
        },
      },
      clips: {
        ...base.clips,
        [moved]: {
          id: moved,
          kind: 'solid',
          trackId: video2,
          name: 'Moved',
          start: T.fromSeconds(8),
          duration: T.fromSeconds(2),
          sourceIn: T.TIME_ZERO,
          speed: 1,
          opacity: { kind: 'static', value: 1 },
          blendMode: 'normal',
          fill: '#123456',
        },
        [stationary]: {
          id: stationary,
          kind: 'solid',
          trackId: video1,
          name: 'Stationary',
          start: T.fromSeconds(4),
          duration: T.fromSeconds(2),
          sourceIn: T.TIME_ZERO,
          speed: 1,
          opacity: { kind: 'static', value: 1 },
          blendMode: 'normal',
          fill: '#654321',
        },
      },
    },
  };
}

describe('clipsForDragOrigin', () => {
  it('anchors a moved clip to its original track and geometry', () => {
    const { project, video1, video2, moved, stationary } = withMovedClips();
    const origins = [
      {
        clipId: moved,
        trackId: video1,
        start: T.fromSeconds(1),
        duration: T.fromSeconds(2),
      },
    ];

    const source = clipsForDragOrigin(project, video1, origins);
    expect(source.map((clip) => clip.id)).toEqual([moved, stationary]);
    expect(T.toSeconds(source[0]!.start)).toBe(1);
    expect(clipsForDragOrigin(project, video2, origins)).toEqual([]);
  });

  it('uses live document geometry when no move is active', () => {
    const { project, video1, video2, moved, stationary } = withMovedClips();

    expect(clipsForDragOrigin(project, video1, null).map((clip) => clip.id)).toEqual([stationary]);
    expect(clipsForDragOrigin(project, video2, null).map((clip) => clip.id)).toEqual([moved]);
  });
});
