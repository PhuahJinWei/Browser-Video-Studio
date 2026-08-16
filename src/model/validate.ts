/**
 * Document invariant checking.
 *
 * These are the rules from `types.ts` made executable. Run after every command in dev
 * builds and after deserialising a project file; a violation means a command has a bug
 * or the file is corrupt, and both are better caught loudly than rendered wrongly.
 */

import {
  clipEnd,
  clipFitsTrack,
  isMediaClip,
  transitionSpan,
} from './selectors';
import * as T from './time';
import { isTime } from './time';
import type {
  Project,
  SequenceId,
  TimeRange,
  TrackId,
} from './types';
import { SCHEMA_VERSION } from './types';

export interface Violation {
  readonly path: string;
  readonly message: string;
}

function checkTime(value: unknown, path: string, out: Violation[]): void {
  if (!isTime(value)) {
    out.push({ path, message: `Not a normalised Time: ${JSON.stringify(value)}` });
  }
}

/** Every invariant, checked. Returns an empty array for a valid document. */
export function validateProject(p: Project): readonly Violation[] {
  const out: Violation[] = [];

  if (p.schemaVersion !== SCHEMA_VERSION) {
    out.push({
      path: 'schemaVersion',
      message: `Expected ${SCHEMA_VERSION}, found ${p.schemaVersion} — needs migration`,
    });
  }

  if (!p.sequences[p.activeSequenceId]) {
    out.push({ path: 'activeSequenceId', message: `No sequence "${p.activeSequenceId}"` });
  }

  const effectOwners = new Map<string, string>();
  const clipTrackFromList = new Map<string, string>();

  // -- sequences ------------------------------------------------------------
  for (const seq of Object.values(p.sequences)) {
    const at = `sequences.${seq.id}`;
    if (seq.frameRate.num <= 0 || seq.frameRate.den <= 0) {
      out.push({ path: `${at}.frameRate`, message: 'Frame rate must be positive' });
    }
    if (!Number.isInteger(seq.sampleRate) || seq.sampleRate <= 0) {
      out.push({ path: `${at}.sampleRate`, message: 'Sample rate must be a positive integer' });
    }
    if (seq.size.width <= 0 || seq.size.height <= 0) {
      out.push({ path: `${at}.size`, message: 'Sequence size must be positive' });
    }
    checkTime(seq.view.playhead, `${at}.view.playhead`, out);

    for (const trackId of [...seq.videoTrackIds, ...seq.audioTrackIds]) {
      if (!p.tracks[trackId]) {
        out.push({ path: `${at}.trackIds`, message: `Dangling track reference "${trackId}"` });
      }
    }
    const seen = new Set<string>();
    for (const trackId of [...seq.videoTrackIds, ...seq.audioTrackIds]) {
      if (seen.has(trackId)) {
        out.push({ path: `${at}.trackIds`, message: `Track "${trackId}" listed twice` });
      }
      seen.add(trackId);
    }
    for (const markerId of seq.markerIds) {
      if (!p.markers[markerId]) {
        out.push({ path: `${at}.markerIds`, message: `Dangling marker "${markerId}"` });
      }
    }
    for (const transitionId of seq.transitionIds) {
      if (!p.transitions[transitionId]) {
        out.push({ path: `${at}.transitionIds`, message: `Dangling transition "${transitionId}"` });
      }
    }
  }

  // -- tracks and their clip lists -----------------------------------------
  for (const track of Object.values(p.tracks)) {
    const at = `tracks.${track.id}`;
    let previousEnd: ReturnType<typeof clipEnd> | null = null;
    let previousName = '';

    for (const clipId of track.clipIds) {
      const clip = p.clips[clipId];
      if (!clip) {
        out.push({ path: `${at}.clipIds`, message: `Dangling clip reference "${clipId}"` });
        continue;
      }
      if (clipTrackFromList.has(clipId)) {
        out.push({
          path: `${at}.clipIds`,
          message: `Clip "${clipId}" also listed on track "${clipTrackFromList.get(clipId)}"`,
        });
      }
      clipTrackFromList.set(clipId, track.id);

      if (clip.trackId !== track.id) {
        out.push({
          path: `clips.${clipId}.trackId`,
          message: `Says "${clip.trackId}" but is listed on "${track.id}"`,
        });
      }
      if (!clipFitsTrack(clip.kind, track.kind)) {
        out.push({
          path: `clips.${clipId}`,
          message: `A "${clip.kind}" clip cannot live on a ${track.kind} track`,
        });
      }
      if (previousEnd && T.gt(previousEnd, clip.start)) {
        out.push({
          path: `${at}.clipIds`,
          message: `"${previousName}" overlaps "${clip.name}" (or they are out of order)`,
        });
      }
      previousEnd = clipEnd(clip);
      previousName = clip.name;
    }

    for (const effectId of track.effects) {
      if (!p.effects[effectId]) {
        out.push({ path: `${at}.effects`, message: `Dangling effect "${effectId}"` });
      } else if (effectOwners.has(effectId)) {
        out.push({
          path: `${at}.effects`,
          message: `Effect "${effectId}" is also owned by ${effectOwners.get(effectId)}`,
        });
      }
      effectOwners.set(effectId, at);
    }
  }

  // -- clips ---------------------------------------------------------------
  for (const clip of Object.values(p.clips)) {
    const at = `clips.${clip.id}`;
    checkTime(clip.start, `${at}.start`, out);
    checkTime(clip.duration, `${at}.duration`, out);

    if (!T.isPositive(clip.duration)) {
      out.push({ path: `${at}.duration`, message: 'Duration must be greater than zero' });
    }
    if (T.isNegative(clip.start)) {
      out.push({ path: `${at}.start`, message: 'A clip cannot start before zero' });
    }
    if (!clipTrackFromList.has(clip.id)) {
      out.push({ path: at, message: `Not listed on any track (orphaned)` });
    }
    if (!p.tracks[clip.trackId]) {
      out.push({ path: `${at}.trackId`, message: `No track "${clip.trackId}"` });
    }
    if (isMediaClip(clip)) {
      checkTime(clip.sourceIn, `${at}.sourceIn`, out);
      if (!p.assets[clip.assetId]) {
        out.push({ path: `${at}.assetId`, message: `No asset "${clip.assetId}"` });
      }
      if (clip.speed === 0 || !Number.isFinite(clip.speed)) {
        out.push({ path: `${at}.speed`, message: `Speed must be finite and non-zero` });
      }
    }
    for (const effectId of clip.effects) {
      if (!p.effects[effectId]) {
        out.push({ path: `${at}.effects`, message: `Dangling effect "${effectId}"` });
      } else if (effectOwners.has(effectId)) {
        out.push({
          path: `${at}.effects`,
          message: `Effect "${effectId}" is also owned by ${effectOwners.get(effectId)}`,
        });
      }
      effectOwners.set(effectId, at);
    }
  }

  // -- effects, transitions, markers ---------------------------------------
  for (const effect of Object.values(p.effects)) {
    if (!effectOwners.has(effect.id)) {
      out.push({ path: `effects.${effect.id}`, message: 'Not referenced by any clip or track' });
    }
    for (const [key, param] of Object.entries(effect.params)) {
      if (param.kind === 'keyframed') {
        if (param.keyframes.length === 0) {
          out.push({
            path: `effects.${effect.id}.params.${key}`,
            message: 'Keyframed parameter has no keyframes',
          });
        }
        for (let i = 1; i < param.keyframes.length; i++) {
          if (T.gt(param.keyframes[i - 1]!.at, param.keyframes[i]!.at)) {
            out.push({
              path: `effects.${effect.id}.params.${key}`,
              message: 'Keyframes are not sorted by time',
            });
            break;
          }
        }
      }
    }
  }

  for (const transition of Object.values(p.transitions)) {
    const at = `transitions.${transition.id}`;
    const from = transition.fromClipId === null ? null : p.clips[transition.fromClipId];
    const to = transition.toClipId === null ? null : p.clips[transition.toClipId];

    if (transition.fromClipId === null && transition.toClipId === null) {
      out.push({ path: at, message: 'A transition needs a clip on at least one side' });
      continue;
    }
    if ((transition.fromClipId !== null && !from) || (transition.toClipId !== null && !to)) {
      out.push({ path: at, message: 'References a clip that does not exist' });
      continue;
    }
    if ((from && from.trackId !== transition.trackId) || (to && to.trackId !== transition.trackId)) {
      out.push({ path: at, message: 'Clips are not both on the transition’s track' });
    }
    // Adjacency only means anything when there are two clips to be adjacent.
    if (from && to && !T.eq(clipEnd(from), to.start)) {
      out.push({ path: at, message: 'Clips are not adjacent' });
    }
    if (!T.isPositive(transition.duration)) {
      out.push({ path: `${at}.duration`, message: 'Duration must be greater than zero' });
    }
  }

  // Two transitions over the same frames would leave the renderer picking one
  // arbitrarily, and the clip on the far side of the loser would never draw.
  const byTrack = new Map<TrackId, { id: string; range: TimeRange }[]>();
  for (const transition of Object.values(p.transitions)) {
    const span = transitionSpan(p, transition);
    if (!span) continue;
    const list = byTrack.get(transition.trackId) ?? [];
    list.push({ id: transition.id, range: span });
    byTrack.set(transition.trackId, list);
  }
  for (const spans of byTrack.values()) {
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        if (!T.rangesOverlap(spans[i]!.range, spans[j]!.range)) continue;
        out.push({
          path: `transitions.${spans[i]!.id}`,
          message: `Overlaps transition ${spans[j]!.id}`,
        });
      }
    }
  }

  for (const marker of Object.values(p.markers)) {
    checkTime(marker.at, `markers.${marker.id}.at`, out);
  }

  // -- nesting must stay acyclic -------------------------------------------
  for (const seq of Object.values(p.sequences)) {
    if (findNestingCycle(p, seq.id, new Set())) {
      out.push({ path: `sequences.${seq.id}`, message: 'Nested sequences form a cycle' });
    }
  }

  // -- assets ---------------------------------------------------------------
  for (const asset of Object.values(p.assets)) {
    const at = `assets.${asset.id}`;
    // Folders are paths, and the whole bin groups by string equality — an
    // unnormalised one silently becomes a second folder with the same name.
    if (typeof asset.folder !== 'string') {
      out.push({ path: `${at}.folder`, message: 'Folder must be a string' });
    } else if (asset.folder !== normalisedFolder(asset.folder)) {
      out.push({
        path: `${at}.folder`,
        message: `Folder path is not normalised: "${asset.folder}"`,
      });
    }
  }

  return out;
}

/** Local copy of the folder normaliser, so validation does not depend on the commands layer. */
function normalisedFolder(folder: string): string {
  return folder
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
}

function findNestingCycle(p: Project, sequenceId: SequenceId, visiting: Set<string>): boolean {
  if (visiting.has(sequenceId)) return true;
  visiting.add(sequenceId);

  const seq = p.sequences[sequenceId];
  if (seq) {
    for (const trackId of seq.videoTrackIds) {
      for (const clipId of p.tracks[trackId]?.clipIds ?? []) {
        const clip = p.clips[clipId];
        if (!clip || clip.kind !== 'nested') continue;
        const nestedId = p.assets[clip.assetId]?.nestedSequenceId;
        if (nestedId && findNestingCycle(p, nestedId, visiting)) return true;
      }
    }
  }

  visiting.delete(sequenceId);
  return false;
}

/** Throw if the document is invalid. Intended for dev builds and tests. */
export function assertValidProject(p: Project): void {
  const violations = validateProject(p);
  if (violations.length > 0) {
    const detail = violations.map((v) => `  ${v.path}: ${v.message}`).join('\n');
    throw new Error(`Project failed validation (${violations.length}):\n${detail}`);
  }
}
