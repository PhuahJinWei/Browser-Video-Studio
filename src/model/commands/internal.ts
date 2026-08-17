/**
 * Shared machinery for command handlers: a mutable draft of the document, plus the
 * timeline surgery primitives (split, clear a range, ripple) that several commands
 * need to share so they cannot disagree about the rules.
 */

import type { IdSource } from '../ids';
import { clipEnd, clipRange, isMediaClip, ModelError } from '../selectors';
import * as T from '../time';
import type {
  AnimatableCrop,
  AnimatableTransform2D,
  Asset,
  AssetId,
  Clip,
  ClipId,
  EffectInstance,
  EffectInstanceId,
  Marker,
  MarkerId,
  Param,
  ParamMap,
  ParamValue,
  Project,
  Sequence,
  SequenceId,
  Time,
  TimeRange,
  Track,
  TrackId,
  Transition,
  TransitionId,
} from '../types';

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export interface Draft {
  /**
   * The project's own name. Not an entity map, but renaming is an edit like any
   * other — it belongs on the undo stack rather than being written behind the
   * document's back.
   */
  name: string;
  assets: Record<AssetId, Asset>;
  sequences: Record<SequenceId, Sequence>;
  tracks: Record<TrackId, Track>;
  clips: Record<ClipId, Clip>;
  effects: Record<EffectInstanceId, EffectInstance>;
  transitions: Record<TransitionId, Transition>;
  markers: Record<MarkerId, Marker>;
}

/** Shallow-copy the entity maps so handlers can mutate freely. */
export function newDraft(p: Project): Draft {
  return {
    name: p.name,
    assets: { ...p.assets },
    sequences: { ...p.sequences },
    tracks: { ...p.tracks },
    clips: { ...p.clips },
    effects: { ...p.effects },
    transitions: { ...p.transitions },
    markers: { ...p.markers },
  };
}

/**
 * Return the original map when the draft copy ended up identical.
 *
 * `newDraft` copies every map up front, so without this a `setView` — which fires on
 * every playhead tick during playback — would hand back a fresh `clips` object and
 * invalidate any memoised selector keyed on its identity.
 */
function reuseIfUnchanged<V>(
  original: Readonly<Record<string, V>>,
  next: Record<string, V>,
): Readonly<Record<string, V>> {
  const nextKeys = Object.keys(next);
  if (nextKeys.length !== Object.keys(original).length) return next;
  for (const key of nextKeys) {
    if (original[key] !== next[key]) return next;
  }
  return original;
}

/**
 * Fold a draft back into a project. `modifiedAt` is deliberately untouched: commands
 * are pure, so the persistence layer stamps the clock.
 */
export function commitDraft(p: Project, d: Draft): Project {
  return {
    ...p,
    name: d.name,
    assets: reuseIfUnchanged(p.assets, d.assets),
    sequences: reuseIfUnchanged(p.sequences, d.sequences),
    tracks: reuseIfUnchanged(p.tracks, d.tracks),
    clips: reuseIfUnchanged(p.clips, d.clips),
    effects: reuseIfUnchanged(p.effects, d.effects),
    transitions: reuseIfUnchanged(p.transitions, d.transitions),
    markers: reuseIfUnchanged(p.markers, d.markers),
  };
}

// ---------------------------------------------------------------------------
// Draft lookups
// ---------------------------------------------------------------------------

export function draftClip(d: Draft, id: ClipId): Clip {
  const clip = d.clips[id];
  if (!clip) throw new ModelError(`No clip with id "${id}"`);
  return clip;
}

export function draftTrack(d: Draft, id: TrackId): Track {
  const track = d.tracks[id];
  if (!track) throw new ModelError(`No track with id "${id}"`);
  return track;
}

export function draftSequence(d: Draft, id: SequenceId): Sequence {
  const seq = d.sequences[id];
  if (!seq) throw new ModelError(`No sequence with id "${id}"`);
  return seq;
}

export function draftEffect(d: Draft, id: EffectInstanceId): EffectInstance {
  const effect = d.effects[id];
  if (!effect) throw new ModelError(`No effect with id "${id}"`);
  return effect;
}

/** The sequence a track belongs to, or null when it is orphaned. */
export function sequenceOfTrack(d: Draft, trackId: TrackId): Sequence | null {
  for (const seq of Object.values(d.sequences)) {
    if (seq.videoTrackIds.includes(trackId) || seq.audioTrackIds.includes(trackId)) return seq;
  }
  return null;
}

/** The clip or track that owns an effect instance, or null. */
export function ownerOfEffect(
  d: Draft,
  effectId: EffectInstanceId,
): { kind: 'clip'; clip: Clip } | { kind: 'track'; track: Track } | null {
  for (const clip of Object.values(d.clips)) {
    if (clip.effects.includes(effectId)) return { kind: 'clip', clip };
  }
  for (const track of Object.values(d.tracks)) {
    if (track.effects.includes(effectId)) return { kind: 'track', track };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Track / clip bookkeeping
// ---------------------------------------------------------------------------

/** Re-sort a track's clip list by start time. Cheap, and keeps the invariant honest. */
export function sortTrack(d: Draft, trackId: TrackId): void {
  const track = draftTrack(d, trackId);
  const sorted = [...track.clipIds].sort((a, b) => T.cmp(draftClip(d, a).start, draftClip(d, b).start));
  d.tracks[trackId] = { ...track, clipIds: sorted };
}

export function putClip(d: Draft, clip: Clip): void {
  d.clips[clip.id] = clip;
  const track = draftTrack(d, clip.trackId);
  if (!track.clipIds.includes(clip.id)) {
    d.tracks[clip.trackId] = { ...track, clipIds: [...track.clipIds, clip.id] };
  }
  sortTrack(d, clip.trackId);
}

/** Remove a clip along with everything that references it. */
export function deleteClip(d: Draft, clipId: ClipId): void {
  const clip = d.clips[clipId];
  if (!clip) return;

  for (const effectId of clip.effects) delete d.effects[effectId];

  for (const transition of Object.values(d.transitions)) {
    if (transition.fromClipId === clipId || transition.toClipId === clipId) {
      deleteTransition(d, transition.id);
    }
  }

  const track = d.tracks[clip.trackId];
  if (track) {
    d.tracks[clip.trackId] = { ...track, clipIds: track.clipIds.filter((id) => id !== clipId) };
  }
  delete d.clips[clipId];
}

export function deleteTransition(d: Draft, transitionId: TransitionId): void {
  const transition = d.transitions[transitionId];
  if (!transition) return;
  delete d.transitions[transitionId];
  for (const seq of Object.values(d.sequences)) {
    if (seq.transitionIds.includes(transitionId)) {
      d.sequences[seq.id] = {
        ...seq,
        transitionIds: seq.transitionIds.filter((id) => id !== transitionId),
      };
    }
  }
}

/**
 * Drop transitions that no longer describe anything: a missing clip, or two
 * clips that have stopped being adjacent.
 *
 * A fade against black has only one clip, so there is no adjacency to lose — it
 * survives until that clip does.
 */
export function pruneBrokenTransitions(d: Draft): void {
  for (const transition of Object.values(d.transitions)) {
    const from = transition.fromClipId === null ? null : d.clips[transition.fromClipId];
    const to = transition.toClipId === null ? null : d.clips[transition.toClipId];

    const lostAClip =
      (transition.fromClipId !== null && !from) || (transition.toClipId !== null && !to);
    const separated = from !== undefined && to !== undefined && from && to && !T.eq(clipEnd(from), to.start);

    if (lostAClip || separated) deleteTransition(d, transition.id);
  }
}

// ---------------------------------------------------------------------------
// Keyframe-aware clip surgery
// ---------------------------------------------------------------------------

function shiftParam<V>(param: Param<V>, by: Time): Param<V> {
  if (param.kind === 'static') return param;
  return {
    kind: 'keyframed',
    keyframes: param.keyframes.map((kf) => ({ ...kf, at: T.add(kf.at, by) })),
  };
}

function shiftParamMap(params: ParamMap, by: Time): ParamMap {
  const out: Record<string, Param<ParamValue>> = {};
  for (const [key, param] of Object.entries(params)) out[key] = shiftParam(param, by);
  return out;
}

function shiftTransform(transform: AnimatableTransform2D, by: Time): AnimatableTransform2D {
  return {
    x: shiftParam(transform.x, by),
    y: shiftParam(transform.y, by),
    scaleX: shiftParam(transform.scaleX, by),
    scaleY: shiftParam(transform.scaleY, by),
    rotation: shiftParam(transform.rotation, by),
    anchorX: shiftParam(transform.anchorX, by),
    anchorY: shiftParam(transform.anchorY, by),
  };
}

function shiftCrop(crop: AnimatableCrop, by: Time): AnimatableCrop {
  return {
    left: shiftParam(crop.left, by),
    top: shiftParam(crop.top, by),
    right: shiftParam(crop.right, by),
    bottom: shiftParam(crop.bottom, by),
  };
}

/**
 * Shift a clip's animation by `by`, in clip-relative time.
 *
 * Keyframes are stored relative to the clip start, so any edit that moves the start
 * must compensate or the animation slides against the picture. `by` is negative when
 * the start moves later.
 */
export function shiftClipAnimation(clip: Clip, by: Time): Clip {
  if (T.isZero(by)) return clip;
  switch (clip.kind) {
    case 'audio':
      return {
        ...clip,
        gainDb: shiftParam(clip.gainDb, by),
        pan: shiftParam(clip.pan, by),
      };
    case 'title':
    case 'solid':
      return {
        ...clip,
        transform: shiftTransform(clip.transform, by),
        opacity: shiftParam(clip.opacity, by),
      };
    default:
      return {
        ...clip,
        transform: shiftTransform(clip.transform, by),
        opacity: shiftParam(clip.opacity, by),
        crop: shiftCrop(clip.crop, by),
      };
  }
}

/** Duplicate a clip's effect instances under fresh ids, shifting their keyframes. */
function cloneEffects(
  d: Draft,
  effectIds: readonly EffectInstanceId[],
  by: Time,
  ids: IdSource,
): readonly EffectInstanceId[] {
  return effectIds.map((sourceId) => {
    const source = draftEffect(d, sourceId);
    const id = ids.effect();
    d.effects[id] = { ...source, id, params: shiftParamMap(source.params, by) };
    return id;
  });
}

/**
 * Move a clip's in-point later by `delta` of timeline time, keeping the picture
 * still: the source in-point advances by delta × speed and the animation slides back.
 */
export function trimClipIn(clip: Clip, delta: Time): Clip {
  const shifted = shiftClipAnimation(clip, T.neg(delta));
  const base = {
    ...shifted,
    start: T.add(clip.start, delta),
    duration: T.sub(clip.duration, delta),
  };
  if (!isMediaClip(clip)) return base as Clip;
  const sourceDelta = clip.speed === 1 ? delta : T.scale(delta, clip.speed);
  return { ...base, sourceIn: T.add(clip.sourceIn, sourceDelta) } as Clip;
}

/**
 * Tracks the new link group each original group maps to during one split command.
 *
 * A link group ties a video clip to *its own* audio so they move together. When a
 * clip is cut, the right-hand halves must form their own group: without this they
 * keep the original id and the two halves stay welded, so dragging one drags the
 * other. Sharing one map across a whole command keeps the video and audio halves of
 * the same cut linked to each other.
 */
export type LinkRemap = Map<string, string>;

/** Same idea for user groups, kept apart so the two memberships stay independent. */
export interface MembershipRemap {
  readonly links: LinkRemap;
  readonly groups: LinkRemap;
}

export function newMembershipRemap(): MembershipRemap {
  return { links: new Map(), groups: new Map() };
}

function remapLinkGroup(
  linkGroupId: string | null,
  ids: IdSource,
  remap: LinkRemap | undefined,
): string | null {
  if (!linkGroupId) return null;
  if (!remap) return `lg_${ids.clip()}`;
  const existing = remap.get(linkGroupId);
  if (existing) return existing;
  const created = `lg_${ids.clip()}`;
  remap.set(linkGroupId, created);
  return created;
}

/** Split a clip at an absolute timeline time; returns [left, right]. */
export function splitClipAt(
  d: Draft,
  clip: Clip,
  at: Time,
  ids: IdSource,
  linkRemap?: MembershipRemap,
): [Clip, Clip] {
  const delta = T.sub(at, clip.start);
  const left: Clip = { ...clip, duration: delta };

  const rightId = ids.clip();
  const rightBase = trimClipIn(clip, delta);
  const right: Clip = {
    ...rightBase,
    id: rightId,
    effects: cloneEffects(d, clip.effects, T.neg(delta), ids),
    // Both memberships split the same way: the right-hand halves form their own
    // link and their own group, so the two sides of a cut are independent.
    linkGroupId: remapLinkGroup(clip.linkGroupId, ids, linkRemap?.links),
    groupId: remapLinkGroup(clip.groupId, ids, linkRemap?.groups),
  };
  return [left, right];
}

// ---------------------------------------------------------------------------
// Range operations
// ---------------------------------------------------------------------------

/**
 * Make `range` empty on a track, in overwrite fashion: clips inside it are deleted,
 * clips overlapping an edge are trimmed, and a clip that spans the whole range is
 * split in two.
 */
export function clearRangeOnTrack(
  d: Draft,
  trackId: TrackId,
  range: TimeRange,
  ids: IdSource,
  exclude: ReadonlySet<ClipId> = new Set(),
  linkRemap?: MembershipRemap,
): void {
  if (T.isZero(range.duration)) return;
  const rangeStart = range.start;
  const rangeStop = T.rangeEnd(range);

  for (const clipId of [...draftTrack(d, trackId).clipIds]) {
    if (exclude.has(clipId)) continue;
    const clip = d.clips[clipId];
    if (!clip) continue;
    if (!T.rangesOverlap(clipRange(clip), range)) continue;

    const start = clip.start;
    const stop = clipEnd(clip);
    const coveredAtStart = T.lte(rangeStart, start);
    const coveredAtStop = T.gte(rangeStop, stop);

    if (coveredAtStart && coveredAtStop) {
      deleteClip(d, clipId);
    } else if (!coveredAtStart && !coveredAtStop) {
      // The range punches a hole in the middle: keep both ends.
      const [left, right] = splitClipAt(d, clip, rangeStart, ids, linkRemap);
      const tail = trimClipIn(right, T.sub(rangeStop, right.start));
      d.clips[left.id] = left;
      putClip(d, tail);
    } else if (coveredAtStart) {
      putClip(d, trimClipIn(clip, T.sub(rangeStop, start)));
    } else {
      d.clips[clipId] = { ...clip, duration: T.sub(rangeStart, start) };
    }
  }

  sortTrack(d, trackId);
}

/** Shift every clip that starts at or after `from` by `delta`. */
export function rippleTrack(d: Draft, trackId: TrackId, from: Time, delta: Time): void {
  if (T.isZero(delta)) return;
  for (const clipId of draftTrack(d, trackId).clipIds) {
    const clip = draftClip(d, clipId);
    if (T.gte(clip.start, from)) {
      d.clips[clipId] = { ...clip, start: T.add(clip.start, delta) };
    }
  }
  sortTrack(d, trackId);
}

/** Reject edits that would produce a zero-length or negative clip. */
export function assertPositiveDuration(duration: Time, what: string): void {
  if (!T.isPositive(duration)) {
    throw new ModelError(`${what} would have a non-positive duration (${T.debugTime(duration)})`);
  }
}
