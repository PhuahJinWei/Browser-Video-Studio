/**
 * Command handlers. Each takes a mutable `Draft` and applies one command's effect,
 * maintaining the track invariants (sorted, non-overlapping, kind-compatible).
 */

import { createAudioClip, createEffect, createMarker, createSolidClip, createTitleClip, createTrack, createVideoClip } from '../factories';
import type { IdSource } from '../ids';
import {
  clipEnd,
  clipFitsTrack,
  clipRange,
  isMediaClip,
  isSyntheticClip,
  ModelError,
} from '../selectors';
import * as T from '../time';
import type { Clip, ClipId, Time, Track, TrackId } from '../types';
import {
  assertPositiveDuration,
  clearRangeOnTrack,
  commitDraft,
  deleteClip,
  draftClip,
  draftEffect,
  draftSequence,
  draftTrack,
  type Draft,
  type MembershipRemap,
  newMembershipRemap,
  ownerOfEffect,
  pruneBrokenTransitions,
  putClip,
  rippleTrack,
  sequenceOfTrack,
  shiftClipAnimation,
  sortTrack,
  splitClipAt,
  trimClipIn,
} from './internal';
import type { Command, NewClipSpec } from './types';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function sourceDuration(d: Draft, clip: Clip): Time | null {
  if (!isMediaClip(clip)) return null;
  const asset = d.assets[clip.assetId];
  if (!asset) return null;
  if (clip.kind === 'audio') return asset.audio?.duration ?? null;
  if (clip.kind === 'image') return null; // stills stretch freely
  return asset.video?.duration ?? asset.audio?.duration ?? null;
}

/** Timeline-space room available at each edge before the source runs out. */
function trimRoom(d: Draft, clip: Clip): { head: Time | null; tail: Time | null } {
  const total = sourceDuration(d, clip);
  if (!isMediaClip(clip) || total === null) return { head: null, tail: null };
  const speed = Math.abs(clip.speed) || 1;
  const used = T.abs(clip.speed === 1 ? clip.duration : T.scale(clip.duration, clip.speed));
  const toTimeline = (source: Time): Time => T.scale(T.max(source, T.TIME_ZERO), 1 / speed);
  return {
    head: toTimeline(clip.sourceIn),
    tail: toTimeline(T.sub(total, T.add(clip.sourceIn, used))),
  };
}

function buildClip(spec: NewClipSpec, trackId: TrackId, ids: IdSource): Clip {
  const id = spec.clipId ?? ids.clip();
  assertPositiveDuration(spec.duration, 'New clip');
  if (T.isNegative(spec.start)) {
    throw new ModelError(`A clip cannot start before zero (${T.debugTime(spec.start)})`);
  }

  if (spec.kind === 'solid') {
    return createSolidClip({
      id,
      trackId,
      start: spec.start,
      duration: spec.duration,
      fill: spec.fill,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
    });
  }

  if (spec.kind === 'title') {
    return createTitleClip({
      id,
      trackId,
      start: spec.start,
      duration: spec.duration,
      text: spec.text,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
    });
  }

  const common = {
    id,
    trackId,
    assetId: spec.assetId,
    start: spec.start,
    duration: spec.duration,
    ...(spec.sourceIn !== undefined ? { sourceIn: spec.sourceIn } : {}),
    ...(spec.speed !== undefined ? { speed: spec.speed } : {}),
    ...(spec.name !== undefined ? { name: spec.name } : {}),
    ...(spec.streamIndex !== undefined ? { streamIndex: spec.streamIndex } : {}),
    ...(spec.linkGroupId !== undefined ? { linkGroupId: spec.linkGroupId } : {}),
  };

  return spec.kind === 'audio'
    ? createAudioClip(common)
    : createVideoClip({ ...common, kind: spec.kind });
}

function assertClipFits(clip: Clip, track: Track): void {
  if (!clipFitsTrack(clip.kind, track.kind)) {
    throw new ModelError(`A "${clip.kind}" clip cannot go on a ${track.kind} track ("${track.name}")`);
  }
}

function assertUnlocked(track: Track): void {
  if (track.locked) throw new ModelError(`Track "${track.name}" is locked`);
}

/**
 * Split whatever clip straddles `at` on a track, so the point becomes an edit point.
 *
 * `linkRemap` is shared across every track in one command so a video clip and its
 * linked audio produce right-hand halves that stay linked to each other — but not to
 * the halves on the left of the cut.
 */
function splitAcross(
  d: Draft,
  trackId: TrackId,
  at: Time,
  ids: IdSource,
  linkRemap: MembershipRemap,
): void {
  for (const clipId of [...draftTrack(d, trackId).clipIds]) {
    const clip = draftClip(d, clipId);
    if (T.lt(clip.start, at) && T.gt(clipEnd(clip), at)) {
      const [left, right] = splitClipAt(d, clip, at, ids, linkRemap);
      d.clips[left.id] = left;
      putClip(d, right);
    }
  }
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

function handleAddTrack(d: Draft, cmd: Extract<Command, { type: 'addTrack' }>, ids: IdSource): void {
  const seq = draftSequence(d, cmd.sequenceId);
  const id = cmd.trackId ?? ids.track();
  if (d.tracks[id]) throw new ModelError(`Track "${id}" already exists`);

  const list = cmd.kind === 'video' ? seq.videoTrackIds : seq.audioTrackIds;
  const name = cmd.name ?? `${cmd.kind === 'video' ? 'V' : 'A'}${list.length + 1}`;
  d.tracks[id] = createTrack({ id, kind: cmd.kind, name });

  const index = cmd.index ?? list.length;
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, list.length)), 0, id);

  d.sequences[seq.id] =
    cmd.kind === 'video' ? { ...seq, videoTrackIds: next } : { ...seq, audioTrackIds: next };
}

function handleRemoveTrack(d: Draft, cmd: Extract<Command, { type: 'removeTrack' }>): void {
  const track = draftTrack(d, cmd.trackId);
  for (const clipId of [...track.clipIds]) deleteClip(d, clipId);
  for (const effectId of track.effects) delete d.effects[effectId];

  const seq = sequenceOfTrack(d, cmd.trackId);
  if (seq) {
    d.sequences[seq.id] = {
      ...seq,
      videoTrackIds: seq.videoTrackIds.filter((id) => id !== cmd.trackId),
      audioTrackIds: seq.audioTrackIds.filter((id) => id !== cmd.trackId),
    };
  }
  delete d.tracks[cmd.trackId];
}

function handleSetTrackProps(d: Draft, cmd: Extract<Command, { type: 'setTrackProps' }>): void {
  d.tracks[cmd.trackId] = { ...draftTrack(d, cmd.trackId), ...cmd.props };
}

function handleSetTrackParam(d: Draft, cmd: Extract<Command, { type: 'setTrackParam' }>): void {
  const track = draftTrack(d, cmd.trackId);
  d.tracks[cmd.trackId] = { ...track, [cmd.key]: cmd.param };
}

function handleMoveTrack(d: Draft, cmd: Extract<Command, { type: 'moveTrack' }>): void {
  const track = draftTrack(d, cmd.trackId);
  const seq = sequenceOfTrack(d, cmd.trackId);
  if (!seq) throw new ModelError(`Track "${cmd.trackId}" is not in any sequence`);

  const key = track.kind === 'video' ? 'videoTrackIds' : 'audioTrackIds';
  const list = [...seq[key]];
  const from = list.indexOf(cmd.trackId);
  if (from < 0) return;
  list.splice(from, 1);
  list.splice(Math.max(0, Math.min(cmd.toIndex, list.length)), 0, cmd.trackId);
  d.sequences[seq.id] = { ...seq, [key]: list };
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

function handleInsertClip(d: Draft, cmd: Extract<Command, { type: 'insertClip' }>, ids: IdSource): void {
  const track = draftTrack(d, cmd.trackId);
  assertUnlocked(track);

  const clip = buildClip(cmd.clip, cmd.trackId, ids);
  assertClipFits(clip, track);
  if (d.clips[clip.id]) throw new ModelError(`Clip "${clip.id}" already exists`);

  const linkRemap = newMembershipRemap();
  if ((cmd.mode ?? 'overwrite') === 'insert') {
    splitAcross(d, cmd.trackId, clip.start, ids, linkRemap);
    rippleTrack(d, cmd.trackId, clip.start, clip.duration);
  } else {
    clearRangeOnTrack(d, cmd.trackId, clipRange(clip), ids, new Set(), linkRemap);
  }

  putClip(d, clip);
  pruneBrokenTransitions(d);
}

function handleRemoveClips(d: Draft, cmd: Extract<Command, { type: 'removeClips' }>): void {
  const mode = cmd.mode ?? 'lift';

  // Group by track first: ripple offsets are per-track.
  const byTrack = new Map<TrackId, Clip[]>();
  for (const clipId of cmd.clipIds) {
    const clip = d.clips[clipId];
    if (!clip) continue;
    assertUnlocked(draftTrack(d, clip.trackId));
    const list = byTrack.get(clip.trackId) ?? [];
    list.push(clip);
    byTrack.set(clip.trackId, list);
  }

  for (const [trackId, removed] of byTrack) {
    const survivors = draftTrack(d, trackId)
      .clipIds.map((id) => draftClip(d, id))
      .filter((c) => !removed.some((r) => r.id === c.id));

    for (const clip of removed) deleteClip(d, clip.id);

    if (mode === 'ripple') {
      // Each survivor slides left by the total length removed before it.
      for (const clip of survivors) {
        const shift = removed
          .filter((r) => T.lt(r.start, clip.start))
          .reduce<Time>((acc, r) => T.add(acc, r.duration), T.TIME_ZERO);
        if (!T.isZero(shift)) {
          d.clips[clip.id] = { ...draftClip(d, clip.id), start: T.sub(clip.start, shift) };
        }
      }
      sortTrack(d, trackId);
    }
  }
  pruneBrokenTransitions(d);
}

function handleMoveClips(d: Draft, cmd: Extract<Command, { type: 'moveClips' }>, ids: IdSource): void {
  const moving = cmd.moves.map((move) => {
    const clip = draftClip(d, move.clipId);
    const target = draftTrack(d, move.toTrackId);
    assertUnlocked(draftTrack(d, clip.trackId));
    assertUnlocked(target);
    assertClipFits(clip, target);
    if (clip.locked) throw new ModelError(`Clip "${clip.name}" is locked`);
    return { move, clip };
  });

  // Detach everything first so clips being moved never overwrite each other.
  for (const { clip } of moving) {
    const track = draftTrack(d, clip.trackId);
    d.tracks[clip.trackId] = { ...track, clipIds: track.clipIds.filter((id) => id !== clip.id) };
  }

  const movedIds = new Set<ClipId>(moving.map(({ clip }) => clip.id));
  const linkRemap = newMembershipRemap();
  const overwrite = (cmd.mode ?? 'block') === 'overwrite';

  for (const { move, clip } of moving) {
    // A drag can overshoot the start of the timeline; clamp rather than reject.
    const start = T.max(move.toStart, T.TIME_ZERO);
    const placed: Clip = { ...clip, trackId: move.toTrackId, start };
    if (overwrite) {
      clearRangeOnTrack(d, move.toTrackId, clipRange(placed), ids, movedIds, linkRemap);
    }
    d.clips[placed.id] = placed;
    putClip(d, placed);
  }

  // In 'block' mode nothing was cleared, so any landing on an existing clip shows
  // up here. In 'overwrite' mode this still catches moved clips hitting each other,
  // since those are excluded from clearing.
  for (const trackId of new Set(moving.map(({ move }) => move.toTrackId))) {
    const clips = draftTrack(d, trackId).clipIds.map((id) => draftClip(d, id));
    for (let i = 1; i < clips.length; i++) {
      if (T.gt(clipEnd(clips[i - 1]!), clips[i]!.start)) {
        throw new ModelError(
          `"${clips[i - 1]!.name}" and "${clips[i]!.name}" would overlap. Move it somewhere clear, or trim it first.`,
        );
      }
    }
  }
  pruneBrokenTransitions(d);
}

function handleTrimClip(d: Draft, cmd: Extract<Command, { type: 'trimClip' }>): void {
  const clip = draftClip(d, cmd.clipId);
  assertUnlocked(draftTrack(d, clip.trackId));
  if (clip.locked) throw new ModelError(`Clip "${clip.name}" is locked`);

  const room = trimRoom(d, clip);
  const oldEnd = clipEnd(clip);

  if (cmd.edge === 'in') {
    let delta = T.sub(cmd.to, clip.start); // positive = trim later
    if (room.head && T.lt(delta, T.neg(room.head))) delta = T.neg(room.head);
    // Extending the head can never push the clip before zero.
    if (!cmd.ripple && T.lt(T.add(clip.start, delta), T.TIME_ZERO)) delta = T.neg(clip.start);
    const duration = T.sub(clip.duration, delta);
    assertPositiveDuration(duration, `Trimming "${clip.name}"`);

    const trimmed = trimClipIn(clip, delta);
    if (cmd.ripple) {
      // Ripple keeps the clip where it is and pulls the rest of the track with it.
      d.clips[clip.id] = { ...trimmed, start: clip.start };
      rippleTrack(d, clip.trackId, oldEnd, T.neg(delta));
    } else {
      d.clips[clip.id] = trimmed;
    }
  } else {
    let duration = T.sub(cmd.to, clip.start);
    if (room.tail) {
      const maxDuration = T.add(clip.duration, room.tail);
      if (T.gt(duration, maxDuration)) duration = maxDuration;
    }
    assertPositiveDuration(duration, `Trimming "${clip.name}"`);
    const delta = T.sub(duration, clip.duration);
    d.clips[clip.id] = { ...clip, duration };
    if (cmd.ripple) rippleTrack(d, clip.trackId, oldEnd, delta);
  }

  sortTrack(d, clip.trackId);
  pruneBrokenTransitions(d);
}

function handleSlipClip(d: Draft, cmd: Extract<Command, { type: 'slipClip' }>): void {
  const clip = draftClip(d, cmd.clipId);
  if (!isMediaClip(clip)) throw new ModelError(`"${clip.name}" has no source to slip`);
  assertUnlocked(draftTrack(d, clip.trackId));

  const room = trimRoom(d, clip);
  let by = cmd.by;
  if (room.head && T.lt(by, T.neg(room.head))) by = T.neg(room.head);
  if (room.tail && T.gt(by, room.tail)) by = room.tail;

  const sourceDelta = clip.speed === 1 ? by : T.scale(by, clip.speed);
  d.clips[clip.id] = { ...clip, sourceIn: T.add(clip.sourceIn, sourceDelta) };
}

function handleSplitClips(d: Draft, cmd: Extract<Command, { type: 'splitClips' }>, ids: IdSource): void {
  const linkRemap = newMembershipRemap();
  for (const trackId of cmd.trackIds) {
    assertUnlocked(draftTrack(d, trackId));
    splitAcross(d, trackId, cmd.at, ids, linkRemap);
  }
}

function handleSetClipProps(d: Draft, cmd: Extract<Command, { type: 'setClipProps' }>): void {
  d.clips[cmd.clipId] = { ...draftClip(d, cmd.clipId), ...cmd.props } as Clip;
}

function handleSetClipParam(d: Draft, cmd: Extract<Command, { type: 'setClipParam' }>): void {
  const clip = draftClip(d, cmd.clipId);
  const [group, channel] = cmd.key.split('.') as [string, string | undefined];

  const reject = (): never => {
    throw new ModelError(`"${clip.name}" (${clip.kind}) has no parameter "${cmd.key}"`);
  };

  if (group === 'opacity') {
    if (clip.kind === 'audio') reject();
    d.clips[clip.id] = { ...clip, opacity: cmd.param } as Clip;
    return;
  }
  if (group === 'gainDb' || group === 'pan') {
    if (clip.kind !== 'audio') reject();
    d.clips[clip.id] = { ...clip, [group]: cmd.param } as Clip;
    return;
  }
  if (group === 'transform' && channel) {
    if (clip.kind === 'audio') reject();
    const visual = clip as Extract<Clip, { transform: unknown }>;
    d.clips[clip.id] = {
      ...visual,
      transform: { ...visual.transform, [channel]: cmd.param },
    } as Clip;
    return;
  }
  if (group === 'crop' && channel) {
    if (clip.kind === 'audio' || isSyntheticClip(clip)) reject();
    const video = clip as Extract<Clip, { crop: unknown }>;
    d.clips[clip.id] = { ...video, crop: { ...video.crop, [channel]: cmd.param } } as Clip;
    return;
  }
  reject();
}

function handleSetSolidFill(d: Draft, cmd: Extract<Command, { type: 'setSolidFill' }>): void {
  const clip = draftClip(d, cmd.clipId);
  if (clip.kind !== 'solid') throw new ModelError(`"${clip.name}" is not a fill clip`);
  if (!cmd.fill.trim()) throw new ModelError('A fill needs a colour');
  d.clips[clip.id] = { ...clip, fill: cmd.fill };
}

function handleSetClipFade(d: Draft, cmd: Extract<Command, { type: 'setClipFade' }>): void {
  const clip = draftClip(d, cmd.clipId);
  if (clip.kind !== 'audio') throw new ModelError(`"${clip.name}" is not an audio clip`);
  if (T.isNegative(cmd.duration)) throw new ModelError('A fade cannot be negative');
  // A fade longer than the clip would invert the ramp.
  const duration = T.min(cmd.duration, clip.duration);
  d.clips[clip.id] = { ...clip, [cmd.edge === 'in' ? 'fadeIn' : 'fadeOut']: duration };
}

function handleSetClipBlendMode(d: Draft, cmd: Extract<Command, { type: 'setClipBlendMode' }>): void {
  const clip = draftClip(d, cmd.clipId);
  if (clip.kind === 'audio' || clip.kind === 'title') {
    throw new ModelError(`"${clip.name}" has no blend mode`);
  }

  d.clips[clip.id] = { ...clip, blendMode: cmd.blendMode };
}

/** Detach audio from video: every clip sharing a group with the given ones goes solo. */
function handleUnlinkClips(d: Draft, cmd: Extract<Command, { type: 'unlinkClips' }>): void {
  const groups = new Set<string>();
  for (const clipId of cmd.clipIds) {
    const clip = d.clips[clipId];
    if (clip?.linkGroupId) groups.add(clip.linkGroupId);
  }
  if (groups.size === 0) return;

  for (const clip of Object.values(d.clips)) {
    if (clip.linkGroupId && groups.has(clip.linkGroupId)) {
      d.clips[clip.id] = { ...clip, linkGroupId: null };
    }
  }
}

/**
 * Put clips into one group.
 *
 * Grouping something already grouped merges the groups, so selecting any member
 * still reaches everything the user expects — groups stay flat rather than nesting.
 */
function handleGroupClips(d: Draft, cmd: Extract<Command, { type: 'groupClips' }>, ids: IdSource): void {
  if (cmd.clipIds.length < 2) return;

  const existing = new Set<string>();
  for (const clipId of cmd.clipIds) {
    const clip = draftClip(d, clipId);
    if (clip.groupId) existing.add(clip.groupId);
  }

  const groupId = `gr_${ids.clip()}`;
  const members = new Set<ClipId>(cmd.clipIds);
  for (const clip of Object.values(d.clips)) {
    if (clip.groupId && existing.has(clip.groupId)) members.add(clip.id);
  }
  for (const clipId of members) {
    d.clips[clipId] = { ...draftClip(d, clipId), groupId };
  }
}

/** Dissolve whole groups, not just the clips passed in. */
function handleUngroupClips(d: Draft, cmd: Extract<Command, { type: 'ungroupClips' }>): void {
  const groups = new Set<string>();
  for (const clipId of cmd.clipIds) {
    const clip = d.clips[clipId];
    if (clip?.groupId) groups.add(clip.groupId);
  }
  if (groups.size === 0) return;

  for (const clip of Object.values(d.clips)) {
    if (clip.groupId && groups.has(clip.groupId)) {
      d.clips[clip.id] = { ...clip, groupId: null };
    }
  }
}

function handleLinkClips(d: Draft, cmd: Extract<Command, { type: 'linkClips' }>, ids: IdSource): void {
  if (cmd.clipIds.length < 2) return;
  const groupId = `lg_${ids.clip()}`;
  for (const clipId of cmd.clipIds) {
    const clip = draftClip(d, clipId);
    d.clips[clipId] = { ...clip, linkGroupId: groupId };
  }
}

function handleSetClipSpeed(d: Draft, cmd: Extract<Command, { type: 'setClipSpeed' }>): void {
  const clip = draftClip(d, cmd.clipId);
  if (!isMediaClip(clip)) throw new ModelError(`"${clip.name}" has no source to retime`);
  if (!Number.isFinite(cmd.speed) || cmd.speed === 0) {
    throw new ModelError(`Speed must be finite and non-zero, got ${cmd.speed}`);
  }
  d.clips[clip.id] = { ...clip, speed: cmd.speed };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

function handleAddEffect(d: Draft, cmd: Extract<Command, { type: 'addEffect' }>, ids: IdSource): void {
  const id = cmd.effectId ?? ids.effect();
  if (d.effects[id]) throw new ModelError(`Effect "${id}" already exists`);
  d.effects[id] = createEffect(id, cmd.effectType, cmd.params ?? {});

  if (cmd.owner.kind === 'clip') {
    const clip = draftClip(d, cmd.owner.clipId);
    const list = [...clip.effects];
    list.splice(cmd.index ?? list.length, 0, id);
    d.clips[clip.id] = { ...clip, effects: list };
  } else {
    const track = draftTrack(d, cmd.owner.trackId);
    const list = [...track.effects];
    list.splice(cmd.index ?? list.length, 0, id);
    d.tracks[track.id] = { ...track, effects: list };
  }
}

function handleRemoveEffect(d: Draft, cmd: Extract<Command, { type: 'removeEffect' }>): void {
  const owner = ownerOfEffect(d, cmd.effectId);
  if (owner?.kind === 'clip') {
    d.clips[owner.clip.id] = {
      ...owner.clip,
      effects: owner.clip.effects.filter((id) => id !== cmd.effectId),
    };
  } else if (owner?.kind === 'track') {
    d.tracks[owner.track.id] = {
      ...owner.track,
      effects: owner.track.effects.filter((id) => id !== cmd.effectId),
    };
  }
  delete d.effects[cmd.effectId];
}

function handleMoveEffect(d: Draft, cmd: Extract<Command, { type: 'moveEffect' }>): void {
  const owner = ownerOfEffect(d, cmd.effectId);
  if (!owner) throw new ModelError(`Effect "${cmd.effectId}" has no owner`);

  const current = owner.kind === 'clip' ? owner.clip.effects : owner.track.effects;
  const list = [...current];
  const from = list.indexOf(cmd.effectId);
  if (from < 0) return;
  list.splice(from, 1);
  list.splice(Math.max(0, Math.min(cmd.toIndex, list.length)), 0, cmd.effectId);

  if (owner.kind === 'clip') d.clips[owner.clip.id] = { ...owner.clip, effects: list };
  else d.tracks[owner.track.id] = { ...owner.track, effects: list };
}

function handleSetEffectParam(d: Draft, cmd: Extract<Command, { type: 'setEffectParam' }>): void {
  const effect = draftEffect(d, cmd.effectId);
  d.effects[cmd.effectId] = {
    ...effect,
    params: { ...effect.params, [cmd.key]: cmd.param },
  };
}

function handleSetEffectEnabled(d: Draft, cmd: Extract<Command, { type: 'setEffectEnabled' }>): void {
  d.effects[cmd.effectId] = { ...draftEffect(d, cmd.effectId), enabled: cmd.enabled };
}

// ---------------------------------------------------------------------------
// Assets, markers, view
// ---------------------------------------------------------------------------

function handleAddAsset(d: Draft, cmd: Extract<Command, { type: 'addAsset' }>): void {
  if (d.assets[cmd.asset.id]) throw new ModelError(`Asset "${cmd.asset.id}" already exists`);
  d.assets[cmd.asset.id] = cmd.asset;
}

function handleRemoveAsset(d: Draft, cmd: Extract<Command, { type: 'removeAsset' }>): void {
  const users = Object.values(d.clips).filter((c) => isMediaClip(c) && c.assetId === cmd.assetId);
  if (users.length > 0) {
    throw new ModelError(
      `Asset "${cmd.assetId}" is still used by ${users.length} clip(s); remove them first`,
    );
  }
  delete d.assets[cmd.assetId];
}

function handleSetAssetStatus(d: Draft, cmd: Extract<Command, { type: 'setAssetStatus' }>): void {
  const asset = d.assets[cmd.assetId];
  if (!asset) throw new ModelError(`No asset with id "${cmd.assetId}"`);
  d.assets[cmd.assetId] = { ...asset, status: cmd.status };
}

function handleAddMarker(d: Draft, cmd: Extract<Command, { type: 'addMarker' }>, ids: IdSource): void {
  const seq = draftSequence(d, cmd.sequenceId);
  const id = cmd.markerId ?? ids.marker();
  d.markers[id] = createMarker({ id, at: cmd.at, ...(cmd.name !== undefined ? { name: cmd.name } : {}) });
  d.sequences[seq.id] = { ...seq, markerIds: [...seq.markerIds, id] };
}

function handleRemoveMarker(d: Draft, cmd: Extract<Command, { type: 'removeMarker' }>): void {
  delete d.markers[cmd.markerId];
  for (const seq of Object.values(d.sequences)) {
    if (seq.markerIds.includes(cmd.markerId)) {
      d.sequences[seq.id] = { ...seq, markerIds: seq.markerIds.filter((id) => id !== cmd.markerId) };
    }
  }
}

function handleSetView(d: Draft, cmd: Extract<Command, { type: 'setView' }>): void {
  const seq = draftSequence(d, cmd.sequenceId);
  d.sequences[seq.id] = { ...seq, view: { ...seq.view, ...cmd.view } };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function runCommand(d: Draft, command: Command, ids: IdSource): void {
  switch (command.type) {
    case 'addTrack':
      return handleAddTrack(d, command, ids);
    case 'removeTrack':
      return handleRemoveTrack(d, command);
    case 'setTrackProps':
      return handleSetTrackProps(d, command);
    case 'setTrackParam':
      return handleSetTrackParam(d, command);
    case 'moveTrack':
      return handleMoveTrack(d, command);
    case 'insertClip':
      return handleInsertClip(d, command, ids);
    case 'removeClips':
      return handleRemoveClips(d, command);
    case 'moveClips':
      return handleMoveClips(d, command, ids);
    case 'trimClip':
      return handleTrimClip(d, command);
    case 'slipClip':
      return handleSlipClip(d, command);
    case 'splitClips':
      return handleSplitClips(d, command, ids);
    case 'setClipProps':
      return handleSetClipProps(d, command);
    case 'setClipParam':
      return handleSetClipParam(d, command);
    case 'setClipFade':
      return handleSetClipFade(d, command);
    case 'setClipBlendMode':
      return handleSetClipBlendMode(d, command);
    case 'setSolidFill':
      return handleSetSolidFill(d, command);
    case 'setClipSpeed':
      return handleSetClipSpeed(d, command);
    case 'unlinkClips':
      return handleUnlinkClips(d, command);
    case 'linkClips':
      return handleLinkClips(d, command, ids);
    case 'groupClips':
      return handleGroupClips(d, command, ids);
    case 'ungroupClips':
      return handleUngroupClips(d, command);
    case 'addEffect':
      return handleAddEffect(d, command, ids);
    case 'removeEffect':
      return handleRemoveEffect(d, command);
    case 'moveEffect':
      return handleMoveEffect(d, command);
    case 'setEffectParam':
      return handleSetEffectParam(d, command);
    case 'setEffectEnabled':
      return handleSetEffectEnabled(d, command);
    case 'addAsset':
      return handleAddAsset(d, command);
    case 'removeAsset':
      return handleRemoveAsset(d, command);
    case 'setAssetStatus':
      return handleSetAssetStatus(d, command);
    case 'addMarker':
      return handleAddMarker(d, command, ids);
    case 'removeMarker':
      return handleRemoveMarker(d, command);
    case 'setView':
      return handleSetView(d, command);
  }
}

export { commitDraft, shiftClipAnimation };
