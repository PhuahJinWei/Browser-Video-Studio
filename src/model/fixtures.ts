/**
 * Shared test fixtures. Not a test file — `vite.config.ts` only collects `*.test.ts`.
 *
 * Everything here uses `sequentialIdSource`, so ids are stable (`cl_1`, `tr_2`, …) and
 * failures point at a specific entity instead of a random uuid.
 */

import { apply, type Command } from './commands';
import { createAsset, createProject } from './factories';
import { sequentialIdSource, type IdSource } from './ids';
import * as T from './time';
import type { AssetId, Project, SequenceId, Time, TrackId } from './types';
import { assertValidProject } from './validate';

export interface Fixture {
  project: Project;
  readonly ids: IdSource;
  readonly seqId: SequenceId;
  /** Bottom video track. */
  readonly v1: TrackId;
  /** Upper video track. */
  readonly v2: TrackId;
  readonly a1: TrackId;
  /** 10 s of video + audio. */
  readonly assetId: AssetId;
  /** 3 s, video only. */
  readonly shortAssetId: AssetId;
}

/** Seconds as an exact Time. Accepts fractions like `sec(1, 2)` for a half second. */
export function sec(num: number, den = 1): Time {
  return T.time(num, den);
}

/** A project with V1/V2/A1 at 25 fps and two ready assets. Nothing on the timeline. */
export function makeFixture(): Fixture {
  const ids = sequentialIdSource();
  const seqId = ids.sequence();
  const v1 = ids.track();
  const v2 = ids.track();
  const a1 = ids.track();
  const assetId = ids.asset();
  const shortAssetId = ids.asset();

  let project = createProject({
    id: ids.project(),
    sequenceId: seqId,
    frameRate: T.FPS_25,
    videoTrackIds: [v1, v2],
    audioTrackIds: [a1],
  });

  project = apply(
    project,
    {
      type: 'addAsset',
      asset: createAsset({
        id: assetId,
        name: 'beach.mp4',
        kind: 'video',
        videoDuration: sec(10),
        audioDuration: sec(10),
      }),
    },
    ids,
  );
  project = apply(
    project,
    {
      type: 'addAsset',
      asset: createAsset({
        id: shortAssetId,
        name: 'sting.mp4',
        kind: 'video',
        videoDuration: sec(3),
      }),
    },
    ids,
  );

  return { project, ids, seqId, v1, v2, a1, assetId, shortAssetId };
}

export interface InsertOptions {
  readonly trackId: TrackId;
  readonly start: Time;
  readonly duration: Time;
  readonly assetId?: AssetId;
  readonly sourceIn?: Time;
  readonly speed?: number;
  readonly name?: string;
  readonly kind?: 'video' | 'audio';
  readonly mode?: 'overwrite' | 'insert';
}

/** Build an `insertClip` command from terse options. */
export function insertCommand(f: Fixture, opts: InsertOptions): Command {
  return {
    type: 'insertClip',
    trackId: opts.trackId,
    mode: opts.mode ?? 'overwrite',
    clip: {
      kind: opts.kind ?? 'video',
      assetId: opts.assetId ?? f.assetId,
      start: opts.start,
      duration: opts.duration,
      ...(opts.sourceIn !== undefined ? { sourceIn: opts.sourceIn } : {}),
      ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    },
  };
}

/**
 * Apply commands in sequence starting from the fixture's project, validating the
 * document after each one. Every invariant violation therefore fails the test that
 * caused it, rather than some later assertion.
 */
export function run(f: Fixture, ...commands: readonly Command[]): Project {
  let project = f.project;
  for (const command of commands) {
    project = apply(project, command, f.ids);
    assertValidProject(project);
  }
  return project;
}

/** Same as `run`, but continuing from an existing project. */
export function runFrom(f: Fixture, project: Project, ...commands: readonly Command[]): Project {
  let next = project;
  for (const command of commands) {
    next = apply(next, command, f.ids);
    assertValidProject(next);
  }
  return next;
}

/** Compact timeline dump for assertions: `"A[0..2) B[2..5)"`. */
export function describeTrack(project: Project, trackId: TrackId): string {
  const track = project.tracks[trackId];
  if (!track) return '<missing track>';
  return track.clipIds
    .map((id) => {
      const clip = project.clips[id]!;
      const start = T.toSeconds(clip.start);
      const end = T.toSeconds(T.add(clip.start, clip.duration));
      return `${clip.name}[${start}..${end})`;
    })
    .join(' ');
}

/** Source in-points per clip on a track, for checking that edits keep the picture still. */
export function describeSources(project: Project, trackId: TrackId): string {
  const track = project.tracks[trackId];
  if (!track) return '<missing track>';
  return track.clipIds
    .map((id) => {
      const clip = project.clips[id]!;
      const sourceIn = 'sourceIn' in clip ? T.toSeconds(clip.sourceIn) : 0;
      return `${clip.name}@${sourceIn}`;
    })
    .join(' ');
}
