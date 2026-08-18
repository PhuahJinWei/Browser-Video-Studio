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

import { evalCrop, evalNumber, evalTransform, integrateNumberParam } from './params';
import * as T from './time';
import type {
  Asset,
  AssetId,
  AudioClip,
  BlendMode,
  Clip,
  ClipId,
  Crop,
  CrossfadeCurve,
  EffectInstance,
  LayerWipe,
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
  WipeDirection,
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
  if (!clip.speedRamp) {
    return T.add(clip.sourceIn, clip.speed === 1 ? elapsed : T.scale(elapsed, clip.speed));
  }
  return T.add(
    clip.sourceIn,
    T.fromSeconds(integrateNumberParam(clip.speedRamp, T.TIME_ZERO, elapsed), 1_000_000),
  );
}

/** Length of source material a clip consumes: duration × |speed|. */
export function clipSourceSpan(clip: VideoClip | AudioClip): Time {
  if (!clip.speedRamp) {
    return T.abs(clip.speed === 1 ? clip.duration : T.scale(clip.duration, clip.speed));
  }
  return T.fromSeconds(
    Math.abs(integrateNumberParam(clip.speedRamp, T.TIME_ZERO, clip.duration)),
    1_000_000,
  );
}

/** Playback rate at one clip-relative instant. */
export function clipSpeedAt(clip: VideoClip | AudioClip, relative: Time): number {
  return clip.speedRamp ? evalNumber(clip.speedRamp, relative) : clip.speed;
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

  const used = clipSourceSpan(clip);
  const remaining = T.sub(sourceDuration, T.add(clip.sourceIn, used));
  // Outside the visible clip a ramp clamps to its edge value, so extension room is
  // source room divided by the corresponding edge rate.
  const headSpeed = Math.abs(clipSpeedAt(clip, T.TIME_ZERO)) || 1;
  const tailSpeed = Math.abs(clipSpeedAt(clip, clip.duration)) || 1;
  return {
    headroom: T.scale(T.max(clip.sourceIn, T.TIME_ZERO), 1 / headSpeed),
    tailroom: T.scale(T.max(remaining, T.TIME_ZERO), 1 / tailSpeed),
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
  /** Set while a wipe transition is revealing this layer. */
  readonly wipe: LayerWipe | null;
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
    for (const { clip, opacityScale, wipe } of trackLayersAt(p, trackId, at)) {
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
        wipe,
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
  /** Set instead of `opacityScale` when the transition is a wipe. */
  readonly wipe: LayerWipe | null;
}

/**
 * Constant power is the default because it is right for the normal case: two
 * different shots, whose signals are uncorrelated.
 */
export const DEFAULT_CROSSFADE_CURVE: CrossfadeCurve = 'equal-power';

/** Gain shape for a transition's audio crossfade. */
export function transitionCurve(transition: Transition): CrossfadeCurve {
  const param = transition.params['curve'];
  if (!param || param.kind !== 'static' || param.value !== 'linear') {
    return DEFAULT_CROSSFADE_CURVE;
  }
  return 'linear';
}

/** Wipe edge feather when a transition does not say otherwise. */
export const DEFAULT_WIPE_SOFTNESS = 0.004;

/**
 * Edge feather for a wipe, as a fraction of the sweep.
 *
 * Kept in the transition's `params` rather than as a field so older documents
 * — which have none — simply fall back to the default instead of needing a
 * migration.
 */
export function transitionSoftness(transition: Transition): number {
  const param = transition.params['softness'];
  if (!param || param.kind !== 'static' || typeof param.value !== 'number') {
    return DEFAULT_WIPE_SOFTNESS;
  }
  return Math.min(0.5, Math.max(0, param.value));
}

/** Transition types that reveal behind a moving edge rather than fading. */
const WIPE_DIRECTIONS: Readonly<Record<string, WipeDirection>> = {
  'wipe.right': 'right',
  'wipe.left': 'left',
  'wipe.down': 'down',
  'wipe.up': 'up',
  'wipe.iris': 'iris',
};

/**
 * What one track contributes at an instant: normally a single clip, but two
 * while a transition is running.
 */
function trackLayersAt(p: Project, trackId: TrackId, at: Time): readonly TrackLayer[] {
  const active = activeTransitionAt(p, trackId, at);
  if (active) {
    const direction = WIPE_DIRECTIONS[active.transition.transitionType];
    const softness = transitionSoftness(active.transition);
    const { from, to, progress } = active;

    // Against black there is only one clip, and nothing underneath to blend
    // with: it simply arrives, or leaves.
    if (!from || !to) {
      const clip = to ?? from!;
      const arriving = to !== null;
      if (direction) {
        // Same edge travelling the same way either side; `hide` is what turns a
        // wipe in from black into a wipe out to it.
        return [
          {
            clip,
            opacityScale: 1,
            wipe: { direction, progress, softness, hide: !arriving },
          },
        ];
      }
      return [{ clip, opacityScale: arriving ? progress : 1 - progress, wipe: null }];
    }

    if (direction) {
      // A wipe hides the incoming clip behind an edge instead of fading it, so
      // it stays fully opaque and the mask does the work.
      return [
        { clip: from, opacityScale: 1, wipe: null },
        {
          clip: to,
          opacityScale: 1,
          wipe: { direction, progress, softness, hide: false },
        },
      ];
    }

    // Only the incoming clip ramps. Fading both would darken the middle of the
    // dissolve: compositing `over` twice gives A(1-p)² + Bp, where a cross
    // dissolve is A(1-p) + Bp. Holding the outgoing clip opaque and letting the
    // incoming one fade up over it produces exactly the latter.
    return [
      { clip: from, opacityScale: 1, wipe: null },
      { clip: to, opacityScale: progress, wipe: null },
    ];
  }
  const clip = clipAt(p, trackId, at);
  return clip ? [{ clip, opacityScale: 1, wipe: null }] : [];
}

// ---------------------------------------------------------------------------
// Audio segments — the mixer's input
// ---------------------------------------------------------------------------

/** One side of a crossfade, as the mixer needs it. */
export interface SegmentCrossfade {
  readonly span: TimeRange;
  readonly curve: CrossfadeCurve;
}

export interface AudioSegment {
  readonly clip: AudioClip;
  readonly trackId: TrackId;
  /** The part of the clip inside the requested range. */
  readonly timelineRange: TimeRange;
  /** Source time matching `timelineRange.start`. */
  readonly sourceStart: Time;
  readonly speed: number;
  /** Set while this clip is fading up as a transition's incoming side. */
  readonly crossfadeIn: SegmentCrossfade | null;
  /** Set while it is fading away as the outgoing side. */
  readonly crossfadeOut: SegmentCrossfade | null;
  readonly effects: readonly EffectInstance[];
  readonly trackEffects: readonly EffectInstance[];
}

/**
 * When a clip can be heard, which reaches past its own edges wherever a
 * transition overlaps it — the outgoing side keeps playing into its tail handle
 * and the incoming side starts early out of its head handle.
 */
export function audibleClipRange(
  p: Project,
  clip: Clip,
): {
  readonly range: TimeRange;
  readonly crossfadeIn: SegmentCrossfade | null;
  readonly crossfadeOut: SegmentCrossfade | null;
} {
  let start = clip.start;
  let end = clipEnd(clip);
  let crossfadeIn: SegmentCrossfade | null = null;
  let crossfadeOut: SegmentCrossfade | null = null;

  for (const transition of trackTransitions(p, clip.trackId)) {
    const span = transitionSpan(p, transition);
    if (!span) continue;
    const curve = transitionCurve(transition);

    if (transition.toClipId === clip.id) {
      crossfadeIn = { span, curve };
      start = T.min(start, span.start);
    }
    if (transition.fromClipId === clip.id) {
      crossfadeOut = { span, curve };
      end = T.max(end, T.rangeEnd(span));
    }
  }

  return { range: T.rangeFromBounds(start, end), crossfadeIn, crossfadeOut };
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

    // Every clip on the track, not just those overlapping the range: a clip just
    // outside it can still be audible inside it through a transition handle.
    for (const clip of trackClips(p, trackId)) {
      if (!clip.enabled || !isAudioClip(clip)) continue;

      const audible = audibleClipRange(p, clip);
      const overlap = T.intersect(audible.range, range);
      if (!overlap) continue;

      segments.push({
        clip,
        trackId,
        timelineRange: overlap,
        sourceStart: clipSourceTimeAt(clip, overlap.start),
        speed: clipSpeedAt(clip, T.sub(overlap.start, clip.start)),
        crossfadeIn: audible.crossfadeIn,
        crossfadeOut: audible.crossfadeOut,
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
/**
 * Where a preset alignment puts the start of the span, measured from the cut.
 * `start` begins on it, `end` finishes on it, `centered` straddles it.
 */
export function presetOffset(
  alignment: Transition['alignment'],
  duration: Time,
): Time {
  switch (alignment) {
    case 'start':
      return T.TIME_ZERO;
    case 'end':
      return T.neg(duration);
    default:
      return T.neg(T.scale(duration, 0.5));
  }
}

/** Where this transition's span actually starts, relative to the cut. */
export function transitionOffset(transition: Transition): Time {
  return transition.offset ?? presetOffset(transition.alignment, transition.duration);
}

export function transitionSpan(p: Project, transition: Transition): TimeRange | null {
  const from = transition.fromClipId === null ? null : p.clips[transition.fromClipId];
  const to = transition.toClipId === null ? null : p.clips[transition.toClipId];

  // A fade against black sits wholly inside the one clip it has: it never plays
  // anything past an edge, so alignment has nothing to choose between.
  if (!from) {
    return to ? T.range(to.start, transition.duration) : null;
  }
  if (!to) {
    return T.range(T.sub(clipEnd(from), transition.duration), transition.duration);
  }

  return T.range(T.add(to.start, transitionOffset(transition)), transition.duration);
}

/**
 * How far the span may sit either side of the cut.
 *
 * Both clips play throughout, so the outgoing one has to reach the far end out
 * of its tail handle and the incoming one has to reach the near end out of its
 * head — and neither may be asked for more than it is long.
 */
export function transitionOffsetBounds(
  p: AssetLookup,
  from: Clip,
  to: Clip,
  duration: Time,
): { readonly earliest: Time; readonly latest: Time } {
  const { tailroom } = clipTrimHandles(p, from);
  const { headroom } = clipTrimHandles(p, to);

  // Earliest: limited by the incoming clip's head, and by the outgoing clip's
  // own length — the span cannot start before the clip it sits on.
  let earliest = T.neg(from.duration);
  if (headroom !== null) earliest = T.max(earliest, T.neg(headroom));

  // Latest: the span must end inside the incoming clip, and within the tail.
  let latest = T.sub(to.duration, duration);
  if (tailroom !== null) latest = T.min(latest, T.sub(tailroom, duration));

  // A span longer than the room available leaves nowhere legal; pin it rather
  // than hand back an inverted range.
  return T.lte(earliest, latest) ? { earliest, latest } : { earliest, latest: earliest };
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

/**
 * Every clip on `trackIds` that overlaps `range` at all.
 *
 * Touching counts as overlapping only when the clip has width there, so a
 * rectangle dragged up to a clip's edge does not pick it up.
 */
export function clipsWithin(
  p: Project,
  trackIds: readonly TrackId[],
  range: TimeRange,
): readonly Clip[] {
  const found: Clip[] = [];
  for (const trackId of trackIds) {
    for (const clip of trackClips(p, trackId)) {
      if (T.rangesOverlap(clipRange(clip), range)) found.push(clip);
    }
  }
  return found;
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
  fromClipId: ClipId | null,
  toClipId: ClipId | null,
): Transition | null {
  return (
    Object.values(p.transitions).find(
      (t) => t.fromClipId === fromClipId && t.toClipId === toClipId,
    ) ?? null
  );
}

/**
 * Every cut that should carry the same transition as this one.
 *
 * A linked A/V pair is edited as one unit, so a dissolve on the picture has to
 * take the sound with it — otherwise the image blends over a hard audio cut.
 */
export function pairedCuts(
  p: Project,
  from: Clip | null,
  to: Clip | null,
): readonly { readonly from: Clip | null; readonly to: Clip | null }[] {
  const cuts: { from: Clip | null; to: Clip | null }[] = [{ from, to }];

  // A fade against black pairs on the single clip it has.
  if (!from || !to) {
    const anchor = from ?? to!;
    if (!anchor.linkGroupId) return cuts;
    for (const candidate of Object.values(p.clips)) {
      if (candidate.id === anchor.id) continue;
      if (candidate.linkGroupId !== anchor.linkGroupId) continue;
      cuts.push(from ? { from: candidate, to: null } : { from: null, to: candidate });
    }
    return cuts;
  }

  if (!from.linkGroupId || !to.linkGroupId) return cuts;

  for (const candidate of Object.values(p.clips)) {
    if (candidate.id === from.id) continue;
    if (candidate.linkGroupId !== from.linkGroupId) continue;

    // The counterpart's own next clip must be the counterpart of `to`, or these
    // are two unrelated cuts that merely happen to involve linked clips.
    const { next } = adjacentClips(p, candidate);
    if (next && next.linkGroupId === to.linkGroupId) cuts.push({ from: candidate, to: next });
  }
  return cuts;
}

/**
 * How far the cut between two adjacent clips can move without opening a gap.
 *
 * Rolling later spends the outgoing clip's tail handle and eats into the
 * incoming clip; rolling earlier does the reverse. `minimum` is the smallest
 * either clip may be left at — a frame, normally — since a zero-length clip is
 * not a legal document.
 */
export function rollBounds(
  p: AssetLookup,
  from: Clip,
  to: Clip,
  minimum: Time = T.TIME_ZERO,
): { readonly earliest: Time; readonly latest: Time } {
  const cut = clipEnd(from);
  const { tailroom } = clipTrimHandles(p, from);
  const { headroom } = clipTrimHandles(p, to);

  let later = T.max(T.sub(to.duration, minimum), T.TIME_ZERO);
  if (tailroom !== null) later = T.min(later, tailroom);

  let earlier = T.max(T.sub(from.duration, minimum), T.TIME_ZERO);
  if (headroom !== null) earlier = T.min(earlier, headroom);

  return { earliest: T.sub(cut, earlier), latest: T.add(cut, later) };
}

/**
 * The cut on a track closest to `at`, ignoring cuts that already carry a
 * transition. Cuts are exact joins, so a gap between two clips is not one.
 */
export function nearestCut(
  p: Project,
  trackId: TrackId,
  at: Time,
): { readonly from: Clip; readonly to: Clip; readonly distanceSeconds: number } | null {
  const clips = trackClips(p, trackId);
  let best: { from: Clip; to: Clip; distanceSeconds: number } | null = null;

  for (let i = 0; i + 1 < clips.length; i++) {
    const from = clips[i]!;
    const to = clips[i + 1]!;
    if (!T.eq(clipEnd(from), to.start)) continue;
    if (transitionBetween(p, from.id, to.id)) continue;

    const distanceSeconds = Math.abs(T.toSeconds(T.sub(to.start, at)));
    if (!best || distanceSeconds < best.distanceSeconds) {
      best = { from, to, distanceSeconds };
    }
  }
  return best;
}

/** A transition together with the ones on its paired cuts. */
export function pairedTransitions(p: Project, transition: Transition): readonly Transition[] {
  const from = transition.fromClipId === null ? null : (p.clips[transition.fromClipId] ?? null);
  const to = transition.toClipId === null ? null : (p.clips[transition.toClipId] ?? null);
  if (!from && !to) return [transition];

  const found = pairedCuts(p, from, to)
    .map((cut) => transitionBetween(p, cut.from?.id ?? null, cut.to?.id ?? null))
    .filter((t): t is Transition => t !== null);
  return found.length > 0 ? found : [transition];
}

export interface ActiveTransition {
  readonly transition: Transition;
  /** Null while fading in from black. */
  readonly from: Clip | null;
  /** Null while fading out to black. */
  readonly to: Clip | null;
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

    const from = transition.fromClipId === null ? null : (p.clips[transition.fromClipId] ?? null);
    const to = transition.toClipId === null ? null : (p.clips[transition.toClipId] ?? null);
    if (!from && !to) continue;
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
  from: Clip | null,
  to: Clip | null,
  alignment: Transition['alignment'] = 'centered',
): Time {
  // Against black there is only one clip, and no handle is spent: the fade
  // happens inside the clip's own span, so its length is the only bound.
  if (!from) return to ? to.duration : T.TIME_ZERO;
  if (!to) return from.duration;

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

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Clips cut from each of these assets.
 *
 * `removeAsset` refuses to delete an asset that is still in use, so anything
 * offering to delete several at once has to know which ones will be refused
 * *before* it runs the batch — one rejection aborts the whole thing.
 */
export function clipsUsingAssets(
  p: Project,
  assetIds: readonly AssetId[],
): ReadonlyMap<AssetId, readonly ClipId[]> {
  const wanted = new Set(assetIds);
  const found = new Map<AssetId, ClipId[]>();
  for (const id of assetIds) found.set(id, []);

  for (const clip of Object.values(p.clips)) {
    if (!isMediaClip(clip) || !wanted.has(clip.assetId)) continue;
    found.get(clip.assetId)!.push(clip.id);
  }
  return found;
}

/**
 * Every folder path in use, plus the ancestors implied by them.
 *
 * `'B-roll/Day 1'` implies `'B-roll'` even when nothing sits directly in it, so
 * navigating into an intermediate folder is possible rather than a dead end.
 */
export function assetFolders(p: Project): readonly string[] {
  const paths = new Set<string>();
  for (const asset of Object.values(p.assets)) {
    if (!asset.folder) continue;
    const segments = asset.folder.split('/');
    for (let i = 1; i <= segments.length; i++) paths.add(segments.slice(0, i).join('/'));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/** Immediate child folder names of `parent` (`''` for the root). */
export function childFolders(
  p: Project,
  parent: string,
  extra: readonly string[] = [],
): readonly string[] {
  const prefix = parent ? `${parent}/` : '';
  const names = new Set<string>();

  for (const path of [...assetFolders(p), ...extra]) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    names.add(rest.split('/')[0]!);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** How many assets sit in `folder` or any folder beneath it. */
export function assetsInFolderTree(p: Project, folder: string): readonly Asset[] {
  const prefix = folder ? `${folder}/` : '';
  return Object.values(p.assets).filter(
    (asset) => asset.folder === folder || asset.folder.startsWith(prefix),
  );
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
