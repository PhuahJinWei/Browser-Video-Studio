/**
 * Selectors — the read side of the document.
 *
 * Pure queries over a `Project`. The two that matter most are `renderListAt`
 * (the compositor's input) and `audioSegments` (the mixer's input); everything else
 * exists to serve the timeline UI.
 *
 * Memoisation is deliberately absent for now: these are cheap over an immutable
 * document, and adding a cache before profiling would just hide the real costs.
 */

import { evalCrop, evalNumber, evalTransform } from './params';
import * as T from './time';
import type {
  Asset,
  AssetId,
  AudioClip,
  BlendMode,
  Clip,
  ClipId,
  Crop,
  EffectInstance,
  Marker,
  Project,
  Sequence,
  SequenceId,
  SolidClip,
  Time,
  TimeRange,
  TitleClip,
  Track,
  TrackId,
  Transform2D,
  Transition,
  VideoClip,
} from './types';

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

// ---------------------------------------------------------------------------
// Entity lookup
// ---------------------------------------------------------------------------

function require_<V>(value: V | undefined, kind: string, id: string): V {
  if (value === undefined) throw new ModelError(`No ${kind} with id "${id}"`);
  return value;
}

export function getSequence(p: Project, id: SequenceId): Sequence {
  return require_(p.sequences[id], 'sequence', id);
}
export function getTrack(p: Project, id: TrackId): Track {
  return require_(p.tracks[id], 'track', id);
}
export function getClip(p: Project, id: ClipId): Clip {
  return require_(p.clips[id], 'clip', id);
}
export function getAsset(p: Project, id: AssetId): Asset {
  return require_(p.assets[id], 'asset', id);
}
export function getEffect(p: Project, id: string): EffectInstance {
  return require_(p.effects[id as never], 'effect', id);
}
export function getActiveSequence(p: Project): Sequence {
  return getSequence(p, p.activeSequenceId);
}
export function findClip(p: Project, id: ClipId): Clip | undefined {
  return p.clips[id];
}

// ---------------------------------------------------------------------------
// Clip kinds
// ---------------------------------------------------------------------------

/**
 * Clips the engine generates from parameters rather than decoding from a source.
 * They have no asset, no source time and no trim limits.
 */
export function isSyntheticClip(clip: Clip): clip is TitleClip | SolidClip {
  return clip.kind === 'title' || clip.kind === 'solid';
}

/** Clips backed by an asset (have assetId / sourceIn / speed). */
export function isMediaClip(clip: Clip): clip is VideoClip | AudioClip {
  return !isSyntheticClip(clip);
}

/** Clips that contribute pixels. */
export function isVisualClip(clip: Clip): clip is VideoClip | TitleClip | SolidClip {
  return clip.kind !== 'audio';
}

export function isAudioClip(clip: Clip): clip is AudioClip {
  return clip.kind === 'audio';
}

/** True when a clip kind may live on a track of this kind. */
export function clipFitsTrack(clipKind: Clip['kind'], trackKind: Track['kind']): boolean {
  return trackKind === 'audio' ? clipKind === 'audio' : clipKind !== 'audio';
}

// ---------------------------------------------------------------------------
// Selection units
// ---------------------------------------------------------------------------

/**
 * Every clip that behaves as one with `clipId`.
 *
 * A clip can belong to an A/V link *and* to a user group, and the two can overlap
 * (grouping a title with a linked pair), so this is the transitive closure over both
 * relations rather than a lookup of either. Selection, dragging, trimming, deleting
 * and the inspector all go through it, which is what stops them disagreeing about
 * what "this clip" means — the bug where deleting a video left its audio behind.
 *
 * Returns `[clipId]` for a clip that is on its own.
 */
export function selectionUnit(p: Project, clipId: ClipId): readonly ClipId[] {
  const first = p.clips[clipId];
  if (!first) return [];
  if (!first.linkGroupId && !first.groupId) return [clipId];

  const unit = new Set<ClipId>([clipId]);
  const seenLinks = new Set<string>();
  const seenGroups = new Set<string>();
  const queue: Clip[] = [first];

  while (queue.length > 0) {
    const clip = queue.pop()!;
    for (const [id, seen] of [
      [clip.linkGroupId, seenLinks],
      [clip.groupId, seenGroups],
    ] as const) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      for (const candidate of Object.values(p.clips)) {
        const matches = seen === seenLinks ? candidate.linkGroupId === id : candidate.groupId === id;
        if (matches && !unit.has(candidate.id)) {
          unit.add(candidate.id);
          queue.push(candidate);
        }
      }
    }
  }
  return [...unit];
}

/** Expand a selection so every member brings its whole unit along. */
export function expandSelection(p: Project, clipIds: readonly ClipId[]): readonly ClipId[] {
  const expanded = new Set<ClipId>();
  for (const clipId of clipIds) {
    for (const id of selectionUnit(p, clipId)) expanded.add(id);
  }
  return [...expanded];
}

/** True when the clip is in a user group (as opposed to only an A/V link). */
export function isGrouped(clip: Clip): boolean {
  return clip.groupId !== null && clip.groupId !== undefined;
}

// ---------------------------------------------------------------------------
// Clip geometry
// ---------------------------------------------------------------------------

export function clipRange(clip: Clip): TimeRange {
  return { start: clip.start, duration: clip.duration };
}

export function clipEnd(clip: Clip): Time {
  return T.add(clip.start, clip.duration);
}

/** Time relative to the clip's own start — the domain of its keyframes. */
export function clipRelativeTime(clip: Clip, at: Time): Time {
  return T.sub(at, clip.start);
}

/**
 * Source time corresponding to a timeline time.
 *   source = sourceIn + (t - start) * speed
 * Negative speed plays the source backwards from `sourceIn`.
 */
export function clipSourceTimeAt(clip: VideoClip | AudioClip, at: Time): Time {
  const elapsed = clipRelativeTime(clip, at);
  return T.add(clip.sourceIn, clip.speed === 1 ? elapsed : T.scale(elapsed, clip.speed));
}

/** Length of source material a clip consumes: duration × |speed|. */
export function clipSourceSpan(clip: VideoClip | AudioClip): Time {
  return T.abs(clip.speed === 1 ? clip.duration : T.scale(clip.duration, clip.speed));
}

/**
 * Just the part of a project the source maths needs. Command drafts satisfy it
 * too, so handlers can ask about handles mid-edit without rebuilding a Project.
 */
export interface AssetLookup {
  readonly assets: Readonly<Record<AssetId, Asset>>;
}

/** Duration of the asset stream a clip draws on, or null when unknown. */
export function clipSourceDuration(p: AssetLookup, clip: Clip): Time | null {
  if (!isMediaClip(clip)) return null;
  const asset = p.assets[clip.assetId];
  if (!asset) return null;
  if (clip.kind === 'audio') return asset.audio?.duration ?? null;
  if (clip.kind === 'image') return null; // stills stretch freely
  return asset.video?.duration ?? asset.audio?.duration ?? null;
}

/**
 * How far each edge can be trimmed before running out of source material.
 * `null` means unbounded (stills, or an asset whose duration is not yet known).
 */
export interface TrimHandles {
  /** Max amount the in-point can move earlier. */
  readonly headroom: Time | null;
  /** Max amount the out-point can move later. */
  readonly tailroom: Time | null;
}

export function clipTrimHandles(p: AssetLookup, clip: Clip): TrimHandles {
  const sourceDuration = clipSourceDuration(p, clip);
  if (!isMediaClip(clip) || sourceDuration === null) return { headroom: null, tailroom: null };

  const speed = Math.abs(clip.speed) || 1;
  const used = clipSourceSpan(clip);
  const remaining = T.sub(sourceDuration, T.add(clip.sourceIn, used));
  // Convert leftover source time back into timeline time.
  const toTimeline = (source: Time): Time => T.scale(T.max(source, T.TIME_ZERO), 1 / speed);
  return {
    headroom: toTimeline(clip.sourceIn),
    tailroom: toTimeline(remaining),
  };
}

// ---------------------------------------------------------------------------
// Track queries
// ---------------------------------------------------------------------------

/** Clips on a track, resolved and in timeline order. */
export function trackClips(p: Project, trackId: TrackId): readonly Clip[] {
  const track = getTrack(p, trackId);
  return track.clipIds.map((id) => getClip(p, id));
}

/** The clip covering `at` on a track (half-open: start <= at < end), or null. */
export function clipAt(p: Project, trackId: TrackId, at: Time): Clip | null {
  const clips = trackClips(p, trackId);
  // Clips are sorted and non-overlapping, so binary search is safe.
  let lo = 0;
  let hi = clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const clip = clips[mid]!;
    if (T.lt(at, clip.start)) hi = mid - 1;
    else if (T.gte(at, clipEnd(clip))) lo = mid + 1;
    else return clip;
  }
  return null;
}

/** Clips on a track that overlap `range` at all. */
export function clipsInRange(p: Project, trackId: TrackId, range: TimeRange): readonly Clip[] {
  return trackClips(p, trackId).filter((c) => T.rangesOverlap(clipRange(c), range));
}

/** The gap containing `at` on a track, or null when a clip covers it. */
export function gapAt(p: Project, trackId: TrackId, at: Time): TimeRange | null {
  const clips = trackClips(p, trackId);
  if (clipAt(p, trackId, at) !== null) return null;

  let start = T.TIME_ZERO;
  for (const clip of clips) {
    if (T.lt(at, clip.start)) return T.rangeFromBounds(start, clip.start);
    start = clipEnd(clip);
  }
  return null; // past the last clip: an unbounded tail, not a gap
}

/** End of the last clip on a track. */
export function trackDuration(p: Project, trackId: TrackId): Time {
  const clips = trackClips(p, trackId);
  const last = clips[clips.length - 1];
  return last ? clipEnd(last) : T.TIME_ZERO;
}

export function sequenceTracks(p: Project, sequenceId: SequenceId): readonly Track[] {
  const seq = getSequence(p, sequenceId);
  return [...seq.videoTrackIds, ...seq.audioTrackIds].map((id) => getTrack(p, id));
}

/** End of the last clip anywhere in the sequence. */
export function sequenceDuration(p: Project, sequenceId: SequenceId): Time {
  let end = T.TIME_ZERO;
  for (const track of sequenceTracks(p, sequenceId)) {
    end = T.max(end, trackDuration(p, track.id));
  }
  return end;
}

// ---------------------------------------------------------------------------
// Mute / solo
// ---------------------------------------------------------------------------

/**
 * Audible tracks, honouring solo. Any soloed audio track silences the others,
 * which is why this cannot be decided per-track in isolation.
 */
export function audibleTrackIds(p: Project, sequenceId: SequenceId): ReadonlySet<TrackId> {
  const seq = getSequence(p, sequenceId);
  const tracks = seq.audioTrackIds.map((id) => getTrack(p, id));
  const soloed = tracks.filter((t) => t.solo);
  const candidates = soloed.length > 0 ? soloed : tracks;
  return new Set(candidates.filter((t) => !t.muted).map((t) => t.id));
}

/** Visible video tracks, bottom to top. */
export function visibleTrackIds(p: Project, sequenceId: SequenceId): readonly TrackId[] {
  const seq = getSequence(p, sequenceId);
  return seq.videoTrackIds.filter((id) => !getTrack(p, id).hidden);
}

// ---------------------------------------------------------------------------
// Render list — the compositor's input
// ---------------------------------------------------------------------------

export interface RenderLayer {
  readonly clip: VideoClip | TitleClip | SolidClip;
  readonly trackId: TrackId;
  /** Source time to decode, for asset-backed clips. */
  readonly sourceTime: Time | null;
  readonly transform: Transform2D;
  readonly opacity: number;
  readonly crop: Crop;
  readonly blendMode: BlendMode;
  /** Track-level effects apply after the clip's own stack. */
  readonly effects: readonly EffectInstance[];
  readonly trackEffects: readonly EffectInstance[];
}

const NO_CROP: Crop = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });

function resolveEffects(p: Project, ids: readonly string[]): readonly EffectInstance[] {
  const out: EffectInstance[] = [];
  for (const id of ids) {
    const effect = p.effects[id as never] as EffectInstance | undefined;
    if (effect && effect.enabled) out.push(effect);
  }
  return out;
}

/**
 * Everything the compositor must draw for one instant, bottom layer first.
 * Disabled clips, hidden tracks and disabled effects are already filtered out.
 */
export function renderListAt(p: Project, sequenceId: SequenceId, at: Time): readonly RenderLayer[] {
  const layers: RenderLayer[] = [];

  for (const trackId of visibleTrackIds(p, sequenceId)) {
    for (const { clip, opacityScale } of trackLayersAt(p, trackId, at)) {
      if (!clip.enabled || !isVisualClip(clip)) continue;

      const rel = clipRelativeTime(clip, at);
      layers.push({
        clip,
        trackId,
        sourceTime: isSyntheticClip(clip) ? null : clipSourceTimeAt(clip, at),
        transform: evalTransform(clip.transform, rel),
        opacity: evalNumber(clip.opacity, rel) * opacityScale,
        // Generated layers already fill the frame, so there is nothing to crop.
        crop: isSyntheticClip(clip) ? NO_CROP : evalCrop(clip.crop, rel),
        blendMode: clip.kind === 'title' ? 'normal' : clip.blendMode,
        effects: resolveEffects(p, clip.effects),
        trackEffects: resolveEffects(p, getTrack(p, trackId).effects),
      });
    }
  }

  return layers;
}

interface TrackLayer {
  readonly clip: Clip;
  /** Multiplied into the clip's own opacity. This is what mixes a dissolve. */
  readonly opacityScale: number;
}

/**
 * What one track contributes at an instant: normally a single clip, but two
 * while a transition is running.
 */
function trackLayersAt(p: Project, trackId: TrackId, at: Time): readonly TrackLayer[] {
  const active = activeTransitionAt(p, trackId, at);
  if (active) {
    // Only the incoming clip ramps. Fading both would darken the middle of the
    // dissolve: compositing `over` twice gives A(1-p)² + Bp, where a cross
    // dissolve is A(1-p) + Bp. Holding the outgoing clip opaque and letting the
    // incoming one fade up over it produces exactly the latter.
    return [
      { clip: active.from, opacityScale: 1 },
      { clip: active.to, opacityScale: active.progress },
    ];
  }
  const clip = clipAt(p, trackId, at);
  return clip ? [{ clip, opacityScale: 1 }] : [];
}

// ---------------------------------------------------------------------------
// Audio segments — the mixer's input
// ---------------------------------------------------------------------------

export interface AudioSegment {
  readonly clip: AudioClip;
  readonly trackId: TrackId;
  /** The part of the clip inside the requested range. */
  readonly timelineRange: TimeRange;
  /** Source time matching `timelineRange.start`. */
  readonly sourceStart: Time;
  readonly speed: number;
  readonly effects: readonly EffectInstance[];
  readonly trackEffects: readonly EffectInstance[];
}

/**
 * Audio to mix for a timeline range, already clipped to that range and filtered by
 * mute/solo. Gain, pan and fades stay as parameters on the clip so the mixer can
 * evaluate them per block rather than per segment.
 */
export function audioSegments(
  p: Project,
  sequenceId: SequenceId,
  range: TimeRange,
): readonly AudioSegment[] {
  const audible = audibleTrackIds(p, sequenceId);
  const segments: AudioSegment[] = [];

  for (const trackId of getSequence(p, sequenceId).audioTrackIds) {
    if (!audible.has(trackId)) continue;
    const track = getTrack(p, trackId);
    const trackEffects = resolveEffects(p, track.effects);

    for (const clip of clipsInRange(p, trackId, range)) {
      if (!clip.enabled || !isAudioClip(clip)) continue;
      const overlap = T.intersect(clipRange(clip), range);
      if (!overlap) continue;

      segments.push({
        clip,
        trackId,
        timelineRange: overlap,
        sourceStart: clipSourceTimeAt(clip, overlap.start),
        speed: clip.speed,
        effects: resolveEffects(p, clip.effects),
        trackEffects,
      });
    }
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Transitions & markers
// ---------------------------------------------------------------------------

/**
 * Timeline span a transition occupies, or null when its clips have gone.
 *
 * `centered` straddles the cut, so each clip must supply half the overlap;
 * `start` and `end` put the whole overlap on one side of it.
 */
export function transitionSpan(p: Project, transition: Transition): TimeRange | null {
  const to = p.clips[transition.toClipId];
  if (!to || !p.clips[transition.fromClipId]) return null;

  const cut = to.start;
  switch (transition.alignment) {
    case 'start':
      return T.range(cut, transition.duration);
    case 'end':
      return T.range(T.sub(cut, transition.duration), transition.duration);
    default: {
      const half = T.scale(transition.duration, 0.5);
      return T.range(T.sub(cut, half), transition.duration);
    }
  }
}

/** Transitions living on one track, in timeline order. */
export function trackTransitions(p: Project, trackId: TrackId): readonly Transition[] {
  return Object.values(p.transitions)
    .filter((t) => t.trackId === trackId)
    .sort((a, b) => {
      const sa = transitionSpan(p, a);
      const sb = transitionSpan(p, b);
      if (!sa || !sb) return 0;
      return T.cmp(sa.start, sb.start);
    });
}

/** The clips butting straight up against this one, sharing an exact cut. */
export function adjacentClips(
  p: Project,
  clip: Clip,
): { readonly previous: Clip | null; readonly next: Clip | null } {
  const clips = trackClips(p, clip.trackId);
  const index = clips.findIndex((c) => c.id === clip.id);
  if (index < 0) return { previous: null, next: null };

  const previous = clips[index - 1];
  const next = clips[index + 1];
  return {
    previous: previous && T.eq(clipEnd(previous), clip.start) ? previous : null,
    next: next && T.eq(clipEnd(clip), next.start) ? next : null,
  };
}

/** The transition on a given cut, if one is there. */
export function transitionBetween(
  p: Project,
  fromClipId: ClipId,
  toClipId: ClipId,
): Transition | null {
  return (
    Object.values(p.transitions).find(
      (t) => t.fromClipId === fromClipId && t.toClipId === toClipId,
    ) ?? null
  );
}

export interface ActiveTransition {
  readonly transition: Transition;
  readonly from: Clip;
  readonly to: Clip;
  /** 0 at the start of the transition, approaching 1 at its end. */
  readonly progress: number;
}

/** The transition covering `at` on this track, if any. */
export function activeTransitionAt(
  p: Project,
  trackId: TrackId,
  at: Time,
): ActiveTransition | null {
  for (const transition of trackTransitions(p, trackId)) {
    const span = transitionSpan(p, transition);
    if (!span) continue;
    if (T.lt(at, span.start) || T.gte(at, T.rangeEnd(span))) continue;

    const from = p.clips[transition.fromClipId];
    const to = p.clips[transition.toClipId];
    if (!from || !to) continue;
    return { transition, from, to, progress: T.ratio(T.sub(at, span.start), span.duration) };
  }
  return null;
}

/**
 * Longest transition a cut can support.
 *
 * A dissolve plays both clips at once, so each side has to keep going past its
 * own cut: the outgoing clip spends `tailroom`, the incoming one `headroom`.
 * Generated clips (titles, fills) have no source to run out of and only the clip
 * lengths bound them. Returns zero when the cut has no spare material at all.
 */
export function maxTransitionDuration(
  p: AssetLookup,
  from: Clip,
  to: Clip,
  alignment: Transition['alignment'] = 'centered',
): Time {
  // Swallowing a whole clip would erase the cut the transition belongs to.
  let limit = T.min(from.duration, to.duration);
  const cap = (value: Time): void => {
    limit = T.min(limit, value);
  };

  const { tailroom } = clipTrimHandles(p, from);
  const { headroom } = clipTrimHandles(p, to);

  switch (alignment) {
    case 'start':
      // Wholly after the cut: only the outgoing clip plays past its out point.
      if (tailroom !== null) cap(tailroom);
      break;
    case 'end':
      // Wholly before the cut: only the incoming clip starts early.
      if (headroom !== null) cap(headroom);
      break;
    default:
      // Straddling the cut: each side supplies half, so each handle buys double.
      if (tailroom !== null) cap(T.mulInt(tailroom, 2));
      if (headroom !== null) cap(T.mulInt(headroom, 2));
  }

  return T.max(limit, T.TIME_ZERO);
}

export function sequenceTransitions(p: Project, sequenceId: SequenceId): readonly Transition[] {
  return getSequence(p, sequenceId)
    .transitionIds.map((id) => p.transitions[id])
    .filter((x): x is Transition => x !== undefined);
}

export function sequenceMarkers(p: Project, sequenceId: SequenceId): readonly Marker[] {
  return getSequence(p, sequenceId)
    .markerIds.map((id) => p.markers[id])
    .filter((x): x is Marker => x !== undefined)
    .sort((a, b) => T.cmp(a.at, b.at));
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

export interface SnapOptions {
  readonly includeClipEdges?: boolean;
  readonly includeMarkers?: boolean;
  readonly includePlayhead?: boolean;
  readonly includeInOut?: boolean;
  /** Clips to ignore — normally the ones being dragged. */
  readonly excludeClipIds?: ReadonlySet<ClipId>;
}

/** Candidate times a drag should snap to, sorted and de-duplicated. */
export function snapPoints(
  p: Project,
  sequenceId: SequenceId,
  opts: SnapOptions = {},
): readonly Time[] {
  const {
    includeClipEdges = true,
    includeMarkers = true,
    includePlayhead = true,
    includeInOut = true,
    excludeClipIds,
  } = opts;

  const seq = getSequence(p, sequenceId);
  const points: Time[] = [T.TIME_ZERO];

  if (includeClipEdges) {
    for (const track of sequenceTracks(p, sequenceId)) {
      for (const clip of trackClips(p, track.id)) {
        if (excludeClipIds?.has(clip.id)) continue;
        points.push(clip.start, clipEnd(clip));
      }
    }
  }
  if (includeMarkers) {
    for (const marker of sequenceMarkers(p, sequenceId)) points.push(marker.at);
  }
  if (includePlayhead) points.push(seq.view.playhead);
  if (includeInOut) {
    if (seq.view.inPoint) points.push(seq.view.inPoint);
    if (seq.view.outPoint) points.push(seq.view.outPoint);
  }

  points.sort(T.cmp);
  return points.filter((t, i) => i === 0 || !T.eq(t, points[i - 1]!));
}

/** Nearest snap point within `tolerance`, or null. */
export function findSnap(
  candidates: readonly Time[],
  at: Time,
  tolerance: Time,
): Time | null {
  let best: Time | null = null;
  let bestDistance: Time | null = null;

  for (const candidate of candidates) {
    const distance = T.abs(T.sub(candidate, at));
    if (T.gt(distance, tolerance)) continue;
    if (bestDistance === null || T.lt(distance, bestDistance)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
