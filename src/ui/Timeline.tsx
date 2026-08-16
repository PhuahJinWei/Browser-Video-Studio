/**
 * Timeline.
 *
 * Clip geometry comes straight from the document — there is no parallel UI model to
 * fall out of sync. Drags mutate the document through coalesced commands, so a whole
 * gesture collapses into one undo step (see `endGesture`).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '../model/commands';
import type { PreviewCache } from '../engine/previews';
import {
  adjacentClips,
  clipEnd,
  clipFitsTrack,
  getTrack,
  isGrouped,
  isMediaClip,
  nearestCut,
  pairedCuts,
  pairedTransitions,
  selectionUnit,
  trackClips,
  trackTransitions,
  transitionBetween,
  transitionSpan,
} from '../model/selectors';
import { staticParam } from '../model/params';
import * as T from '../model/time';
import { TRANSITION_TYPES } from '../model/types';
import type {
  Clip,
  ClipId,
  FrameRate,
  Param,
  Project,
  Time,
  Track,
  TrackId,
  Transition,
  TransitionId,
} from '../model/types';
import { useContextMenu, type MenuEntry } from './ContextMenu';
import {
  IconAudio,
  IconClose,
  IconEye,
  IconEyeOff,
  IconGroup,
  IconInspector,
  IconLink,
  IconLock,
  IconMarker,
  IconMuted,
  IconNextEdit,
  IconPlus,
  IconRipple,
  IconSkipStart,
  IconSolo,
  IconSplit,
  IconText,
  IconTransition,
  IconTrash,
  IconUngroup,
  IconUnlink,
  IconUnlocked,
  IconVideo,
  IconVolume,
} from './Icons';
import { useLayout } from './layout';
import { appendPointFor, counterpartTrackId, orderedTrackIds, useStudio } from './store';
import {
  DEFAULT_TRANSITION_SECONDS,
  TRANSITION_DRAG_TYPE,
  transitionLabel,
  transitionShortLabel,
} from './transitions';

/**
 * Width of the sticky track-header column.
 *
 * Wide enough for an audio row's name, mute, solo, fader, lock and remove
 * without the name being squeezed to nothing.
 */
const HEADER_WIDTH = 216;
const MIN_TRACK_HEIGHT = 36;
const MIN_TAIL_SECONDS = 10;
const SNAP_PIXELS = 8;

type DragKind = 'move' | 'trim-in' | 'trim-out';

/**
 * What a click on a clip means.
 *
 * Ctrl/Cmd and Shift used to do the same thing. They are the two halves of
 * multi-select everywhere else: one picks clips out individually, the other
 * takes everything between.
 */
type SelectModifier = 'replace' | 'toggle' | 'range' | 'isolate';

function selectModifier(event: React.PointerEvent | React.MouseEvent): SelectModifier {
  // Alt first: isolating one clip out of its unit beats any of the others.
  if (event.altKey) return 'isolate';
  if (event.shiftKey) return 'range';
  if (event.ctrlKey || event.metaKey) return 'toggle';
  return 'replace';
}

/** A rubber-band selection in progress. */
interface MarqueeState {
  readonly originClientX: number;
  readonly originClientY: number;
  readonly clientX: number;
  readonly clientY: number;
  /** Ctrl/Cmd was held, so the sweep adds rather than replaces. */
  readonly additive: boolean;
}

interface DragState {
  readonly kind: DragKind;
  readonly clipId: ClipId;
  readonly originClientX: number;
  readonly originStart: Time;
  readonly originDuration: Time;
  readonly originTrackId: TrackId;
  /** Every clip that moves with this one (linked audio/video). */
  readonly groupIds: readonly ClipId[];
}

/**
 * A transition being retimed by dragging one of its edges.
 *
 * Only the cut and the alignment are needed: the new length follows from how far
 * the pointer is from the cut, so the gesture is never cumulative and a dropped
 * pointer event cannot make the transition drift.
 */
interface TransitionDragState {
  /**
   * `length` drags an edge, `slide` moves the whole badge along its cut, and
   * `roll` moves the cut itself — the one thing the badge covers up.
   */
  readonly kind: 'length' | 'slide' | 'roll';
  readonly transitionId: TransitionId;
  /** Paired ids, so picture and sound stay the same length. */
  readonly ids: readonly TransitionId[];
  /** Paired cuts, so a roll moves the sound's cut with the picture's. */
  readonly cuts: readonly { readonly fromId: ClipId; readonly toId: ClipId }[];
  readonly cut: Time;
  readonly alignment: Transition['alignment'];
  /** Pointer offset into the badge at grab time, so a slide does not jump. */
  readonly grabOffset: Time;
  readonly duration: Time;
}

/** MIME type carrying an assetId when dragging from the media bin. */
export const ASSET_DRAG_TYPE = 'application/x-bvs-asset';

/**
 * Nearest start position at or near `desired` where a clip of `duration` fits on a
 * track without overlapping anything.
 *
 * Moving a clip onto another must not resize the other one — resizing is a trim, and
 * trims are an explicit gesture — so a drag butts up against its neighbour and stops.
 */
function clampToFreeSpace(
  project: Project,
  trackId: TrackId,
  desired: Time,
  duration: Time,
  exclude: ReadonlySet<ClipId>,
): Time {
  const others = trackClips(project, trackId).filter((c) => !exclude.has(c.id));
  const wanted = T.max(desired, T.TIME_ZERO);

  const collides = (start: Time): boolean => {
    const end = T.add(start, duration);
    return others.some((c) => T.lt(start, clipEnd(c)) && T.lt(c.start, end));
  };
  if (!collides(wanted)) return wanted;

  // Walk the gaps between neighbours and keep the legal start closest to `wanted`.
  const edges: Time[] = [T.TIME_ZERO];
  for (const c of others) edges.push(c.start, clipEnd(c));

  let best: Time | null = null;
  let bestDistance = Infinity;
  for (const edge of edges) {
    for (const candidate of [edge, T.sub(edge, duration)]) {
      if (T.isNegative(candidate) || collides(candidate)) continue;
      const distance = Math.abs(T.toSeconds(T.sub(candidate, wanted)));
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best ?? wanted;
}

export function Timeline(): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const selection = useStudio((s) => s.selection);
  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;

  const run = useStudio((s) => s.run);
  const runMany = useStudio((s) => s.runMany);
  const endGesture = useStudio((s) => s.endGesture);
  const select = useStudio((s) => s.select);
  const selectExact = useStudio((s) => s.selectExact);
  const selectTrack = useStudio((s) => s.selectTrack);
  const selectTransition = useStudio((s) => s.selectTransition);
  const addTransitionOnCuts = useStudio((s) => s.addTransitionOnCuts);
  const splitAtPlayhead = useStudio((s) => s.splitAtPlayhead);
  const selectRangeTo = useStudio((s) => s.selectRangeTo);
  const selectWithin = useStudio((s) => s.selectWithin);
  const setInspectorOpen = useLayout((s) => s.setInspectorOpen);
  const inspectorOpen = useLayout((s) => s.inspectorOpen);
  const setError = useStudio((s) => s.setError);
  const selectedTransitionId = useStudio((s) => s.selectedTransitionId);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const toggleSelect = useStudio((s) => s.toggleSelect);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const setZoom = useStudio((s) => s.setZoom);
  const duration = useStudio((s) => s.duration);
  const previews = useStudio((s) => s.previews);
  const dropAssetOnTrack = useStudio((s) => s.dropAssetOnTrack);
  const draggingAssetId = useStudio((s) => s.draggingAssetId);
  const menu = useContextMenu();
  // Previews arrive asynchronously; this re-renders the lanes when one lands.
  useStudio((s) => s.previewVersion);

  /** Current zoom, for the native wheel listener that is not re-registered per render. */
  const zoomRef = useRef(sequence.view.zoom);
  const pxPerSecond = sequence.view.zoom;
  zoomRef.current = pxPerSecond;
  const playhead = sequence.view.playhead;
  const trackIds = useMemo(() => orderedTrackIds(project, sequenceId), [project, sequenceId]);

  const totalSeconds = Math.max(T.toSeconds(duration()) + MIN_TAIL_SECONDS, MIN_TAIL_SECONDS);
  const contentWidth = Math.ceil(totalSeconds * pxPerSecond);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [transitionDrag, setTransitionDrag] = useState<TransitionDragState | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [dropTrackId, setDropTrackId] = useState<TrackId | null>(null);
  /** Time+offset to restore after a zoom, so the pointer stays over the same frame. */
  const pendingAnchor = useRef<{ seconds: number; offset: number } | null>(null);

  /**
   * Where a dropped asset would land, as a pixel rect, keyed by track.
   *
   * The pointer picks the track; the track picks the time. Media is appended after
   * whatever is already on it, so a drop never lands mid-clip or opens a gap — the
   * horizontal position of the pointer is deliberately ignored.
   *
   * Both the hovered track and its paired one get a ghost, because a clip with
   * video and audio is placed on both — showing only the hovered lane implies the
   * partner stream is being dropped somewhere unknown.
   */
  const dropGhosts = useMemo(() => {
    if (!dropTrackId || !draggingAssetId) return null;
    const asset = project.assets[draggingAssetId];
    const hovered = project.tracks[dropTrackId];
    if (!asset || !hovered) return null;

    const duration = asset.video?.duration ?? asset.audio?.duration;
    if (!duration || !T.isPositive(duration)) return null;

    const hoveredCarries = Boolean(hovered.kind === 'video' ? asset.video : asset.audio);
    if (!hoveredCarries) return null;

    // The asset's other stream needs a track of its own; one may have to be created.
    const needsPartner = Boolean(hovered.kind === 'video' ? asset.audio : asset.video);
    const partnerId = needsPartner ? counterpartTrackId(project, sequenceId, dropTrackId) : null;

    const trackIdsWithGhost: TrackId[] = [dropTrackId];
    if (partnerId) trackIdsWithGhost.push(partnerId);

    const start = appendPointFor(project, sequenceId, dropTrackId, Boolean(partnerId));
    return {
      trackIds: trackIdsWithGhost,
      left: T.toSeconds(start) * pxPerSecond,
      width: Math.max(2, T.toSeconds(duration) * pxPerSecond),
      label: asset.name,
      // Warn that a track will appear, since there is no lane to draw a ghost on.
      newTrackNote: needsPartner && !partnerId
        ? `+ new ${hovered.kind === 'video' ? 'audio' : 'video'} track`
        : null,
    };
  }, [dropTrackId, draggingAssetId, project, sequenceId, pxPerSecond]);

  /** Which track lane sits under a viewport Y coordinate. */
  const trackAtClientY = useCallback((clientY: number): TrackId | null => {
    const lanes = lanesRef.current?.querySelectorAll<HTMLElement>('[data-track-id]');
    if (!lanes) return null;
    for (const lane of lanes) {
      const rect = lane.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        return (lane.dataset.trackId ?? null) as TrackId | null;
      }
    }
    return null;
  }, []);

  /** Every lane a vertical sweep between two screen positions touches. */
  const tracksBetweenClientY = useCallback((a: number, b: number): readonly TrackId[] => {
    const lanes = lanesRef.current?.querySelectorAll<HTMLElement>('[data-track-id]');
    if (!lanes) return [];
    const top = Math.min(a, b);
    const bottom = Math.max(a, b);

    const found: TrackId[] = [];
    for (const lane of lanes) {
      const rect = lane.getBoundingClientRect();
      if (rect.bottom < top || rect.top > bottom) continue;
      const id = lane.dataset.trackId;
      if (id) found.push(id as TrackId);
    }
    return found;
  }, []);

  const timeAtClientX = useCallback(
    (clientX: number): Time => {
      const el = scrollRef.current;
      if (!el) return T.TIME_ZERO;
      const rect = el.getBoundingClientRect();
      // The header column scrolls with the lanes now, so subtract its width.
      const x = clientX - rect.left + el.scrollLeft - HEADER_WIDTH;
      return T.max(T.TIME_ZERO, T.fromSeconds(x / pxPerSecond, 100_000));
    },
    [pxPerSecond],
  );

  /** Snap a time to nearby clip edges and the playhead, within a pixel tolerance. */
  const snap = useCallback(
    (at: Time, exclude: ReadonlySet<ClipId>): Time => {
      const tolerance = SNAP_PIXELS / pxPerSecond;
      let best: Time | null = null;
      let bestDistance = Infinity;

      const consider = (candidate: Time): void => {
        const distance = Math.abs(T.toSeconds(T.sub(candidate, at)));
        if (distance <= tolerance && distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      };

      consider(T.TIME_ZERO);
      consider(playhead);
      for (const trackId of trackIds) {
        for (const clip of trackClips(project, trackId)) {
          if (exclude.has(clip.id)) continue;
          consider(clip.start);
          consider(clipEnd(clip));
        }
      }
      return best ?? at;
    },
    [pxPerSecond, playhead, project, trackIds],
  );

  // ---------------------------------------------------------------- dragging

  useEffect(() => {
    if (!drag) return;

    const move = (event: PointerEvent): void => {
      const clip = project.clips[drag.clipId];
      if (!clip) return;

      const deltaSeconds = (event.clientX - drag.originClientX) / pxPerSecond;
      const delta = T.fromSeconds(deltaSeconds, 100_000);
      const excluded = new Set(drag.groupIds);

      if (drag.kind === 'move') {
        // The lane under the pointer is the destination, so a clip can change track.
        const hovered = trackAtClientY(event.clientY);
        const destination =
          hovered && clipFitsTrack(clip.kind, getTrack(project, hovered).kind) && !getTrack(project, hovered).locked
            ? hovered
            : drag.originTrackId;

        const wanted = snap(T.max(T.TIME_ZERO, T.add(drag.originStart, delta)), excluded);
        // Butt up against whatever is already on the destination track rather than
        // overwriting it.
        const target = clampToFreeSpace(project, destination, wanted, clip.duration, excluded);

        // Recompute from the drag origin each time so the gesture is not cumulative.
        const moves = drag.groupIds
          .map((id) => project.clips[id])
          .filter((c): c is Clip => c !== undefined)
          .map((c) => ({
            clipId: c.id,
            // Only the clip under the pointer changes track; its linked partner
            // stays on its own, since audio cannot live on a video track anyway.
            toTrackId: c.id === clip.id ? destination : c.trackId,
            toStart: T.max(T.TIME_ZERO, T.add(target, T.sub(c.start, clip.start))),
          }));

        // A group member may not fit even though the dragged clip does; in that case
        // hold the last good position instead of throwing an error at every pixel.
        const blocked = moves.some((m) => {
          const moving = project.clips[m.clipId];
          if (!moving) return false;
          return !T.eq(
            clampToFreeSpace(project, m.toTrackId, m.toStart, moving.duration, excluded),
            m.toStart,
          );
        });
        if (blocked) return;

        runMany([{ type: 'moveClips', moves }], 'Move clip', `drag:${drag.clipId}`);
        return;
      }

      // Trimming applies the same *delta* to every member, not the same absolute
      // edge. For a linked A/V pair the two are identical, since the clips are
      // coincident; for a group of unrelated clips at different positions, a shared
      // absolute edge would land before another clip's start and be rejected.
      const edge: 'in' | 'out' = drag.kind === 'trim-in' ? 'in' : 'out';
      const anchor = edge === 'in' ? drag.originStart : T.add(drag.originStart, drag.originDuration);
      const snapped = snap(T.add(anchor, delta), excluded);
      const shift = T.sub(snapped, anchor);

      const commands: Command[] = drag.groupIds
        .map((id) => project.clips[id])
        .filter((c): c is Clip => c !== undefined)
        .map((c) => ({
          type: 'trimClip' as const,
          clipId: c.id,
          edge,
          to: T.add(edge === 'in' ? c.start : clipEnd(c), shift),
        }));
      runMany(commands, 'Trim clip', `trim-${edge}:${drag.clipId}`);
    };

    const up = (): void => {
      setDrag(null);
      endGesture();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, project, pxPerSecond, runMany, snap, endGesture, trackAtClientY]);

  useEffect(() => {
    if (!transitionDrag) return;

    const move = (event: PointerEvent): void => {
      const pointer = timeAtClientX(event.clientX);

      if (transitionDrag.kind === 'slide') {
        // Where the span would start, keeping the point you grabbed under the
        // pointer; the command clamps it to what the clips can supply.
        const start = T.sub(pointer, transitionDrag.grabOffset);
        runMany(
          transitionDrag.ids.map((id) => ({
            type: 'setTransitionOffset' as const,
            transitionId: id,
            offset: T.sub(start, transitionDrag.cut),
          })),
          'Slide transition',
          `slide:${transitionDrag.transitionId}`,
        );
        return;
      }

      if (transitionDrag.kind === 'roll') {
        // The command clamps to what the two clips can supply, so the pointer can
        // run past the end of the material without the gesture breaking.
        runMany(
          transitionDrag.cuts.map((cut) => ({
            type: 'rollEdit' as const,
            fromClipId: cut.fromId,
            toClipId: cut.toId,
            to: pointer,
          })),
          'Roll edit',
          `roll:${transitionDrag.transitionId}`,
        );
        return;
      }

      const distance = Math.abs(T.toSeconds(T.sub(pointer, transitionDrag.cut)));
      // Centred transitions straddle the cut, so the pointer covers half the
      // length; the one-sided alignments cover all of it.
      const seconds = transitionDrag.alignment === 'centered' ? distance * 2 : distance;
      if (seconds < 0.02) return;

      runMany(
        transitionDrag.ids.map((id) => ({
          type: 'setTransitionDuration' as const,
          transitionId: id,
          duration: T.fromSeconds(seconds, 1000),
        })),
        'Set transition length',
        `transition-drag:${transitionDrag.transitionId}`,
      );
    };

    const up = (): void => {
      setTransitionDrag(null);
      endGesture();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [transitionDrag, runMany, endGesture, timeAtClientX]);

  /**
   * Drop a transition style onto a track: it lands on the cut closest to where
   * the pointer was let go, since a transition belongs to a cut rather than to a
   * position.
   */
  const dropTransitionOnTrack = (
    transitionType: string,
    trackId: TrackId,
    at: Time,
  ): void => {
    const cut = nearestCut(project, trackId, at);
    if (!cut) {
      setError('No bare cut on that track to drop a transition on');
      return;
    }
    addTransitionOnCuts(
      pairedCuts(project, cut.from, cut.to),
      transitionType,
      T.fromSeconds(DEFAULT_TRANSITION_SECONDS, 1000),
    );
  };

  /**
   * Rubber-band selection.
   *
   * Resolved in time and track terms rather than in pixels, so a sweep that
   * crosses tracks of different heights still picks up exactly the lanes it
   * visually covers.
   */
  useEffect(() => {
    if (!marquee) return;

    const move = (event: PointerEvent): void => {
      setMarquee((current) =>
        current ? { ...current, clientX: event.clientX, clientY: event.clientY } : current,
      );
    };

    const up = (): void => {
      const covered = tracksBetweenClientY(marquee.originClientY, marquee.clientY);
      const from = timeAtClientX(Math.min(marquee.originClientX, marquee.clientX));
      const to = timeAtClientX(Math.max(marquee.originClientX, marquee.clientX));
      setMarquee(null);

      // A click rather than a sweep: the lane's own handler already cleared it.
      if (covered.length === 0 || !T.isPositive(T.sub(to, from))) return;
      selectWithin(covered, T.rangeFromBounds(from, to), marquee.additive);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [marquee, timeAtClientX, tracksBetweenClientY, selectWithin]);

  const startTransitionDrag = (
    event: React.PointerEvent,
    transition: Transition,
    kind: TransitionDragState['kind'],
  ): void => {
    event.stopPropagation();
    event.preventDefault();
    if (getTrack(project, transition.trackId).locked) return;

    const from = transition.fromClipId === null ? null : (project.clips[transition.fromClipId] ?? null);
    const to = transition.toClipId === null ? null : (project.clips[transition.toClipId] ?? null);
    if (!from && !to) return;
    // A fade against black is pinned to its clip edge: no cut to roll, nowhere
    // to slide to.
    if ((kind === 'roll' || kind === 'slide') && (!from || !to)) return;

    const span = transitionSpan(project, transition);
    selectTransition(transition.id);
    setTransitionDrag({
      kind,
      transitionId: transition.id,
      ids: pairedTransitions(project, transition).map((t) => t.id),
      cuts: pairedCuts(project, from, to)
        .filter((cut) => cut.from && cut.to)
        .map((cut) => ({ fromId: cut.from!.id, toId: cut.to!.id })),
      // Against black the anchor is the clip edge the fade sits against.
      cut: to ? to.start : clipEnd(from!),
      alignment: transition.alignment,
      grabOffset: span ? T.sub(timeAtClientX(event.clientX), span.start) : T.TIME_ZERO,
      duration: transition.duration,
    });
  };

  const startDrag = (
    event: React.PointerEvent,
    clip: Clip,
    kind: DragKind,
    modifier: SelectModifier,
  ): void => {
    event.stopPropagation();
    event.preventDefault();
    const track = getTrack(project, clip.trackId);
    if (track.locked || clip.locked) return;

    // Read the selection back out of the store rather than from this render's
    // snapshot: the click that started this drag has only just changed it, and
    // acting on the stale value is what used to undo every Ctrl-click.
    const current = useStudio.getState().selection;

    // Alt isolates a single clip out of its unit, for the times you need to nudge
    // just the audio without detaching it permanently.
    const unit = selectionUnit(project, clip.id);
    const groupIds =
      modifier === 'isolate'
        ? [clip.id]
        : // Dragging one of several selected clips takes them all.
          current.includes(clip.id)
          ? [...new Set([...current, ...unit])]
          : unit;

    setDrag({
      kind,
      clipId: clip.id,
      originClientX: event.clientX,
      originStart: clip.start,
      originDuration: clip.duration,
      originTrackId: clip.trackId,
      groupIds,
    });
  };

  // ---------------------------------------------------------- context menus

  const splitAt = (at: Time, trackIds: readonly TrackId[]): void =>
    run({ type: 'splitClips', trackIds, at }, 'Split');

  const openClipMenu = (event: React.MouseEvent, clip: Clip): void => {
    if (!selection.includes(clip.id)) select([clip.id]);
    const targets = selection.includes(clip.id) && selection.length > 1 ? selection : [clip.id];

    // Only offer "detach" when the clip is actually tied to another one.
    const linked = clip.linkGroupId
      ? Object.values(project.clips).filter((c) => c.linkGroupId === clip.linkGroupId)
      : [];

    const { previous, next } = adjacentClips(project, clip);
    const dissolveEntry = (
      label: string,
      from: Clip | null,
      to: Clip | null,
      againstBlack = false,
    ): MenuEntry => {
      const existing =
        from || to ? transitionBetween(project, from?.id ?? null, to?.id ?? null) : null;
      return {
        label: existing ? `${label} (already there)` : label,
        icon: <IconTransition />,
        // Against a neighbour both sides are needed; against black, only one.
        disabled: (againstBlack ? !from && !to : !from || !to) || existing !== null,
        onSelect: () => {
          if (!from && !to) return;
          // Every cut in one batch, so a linked A/V pair stays in step and the
          // whole thing is one undo.
          addTransitionOnCuts(
            pairedCuts(project, from, to),
            'dissolve',
            T.time(1),
            label,
          );
        },
      };
    };

    const entries: MenuEntry[] = [
      {
        label: 'Split',
        icon: <IconSplit />,
        hint: 'S',
        // Only does anything when the playhead is actually inside the clip.
        disabled: !(T.lt(clip.start, playhead) && T.gt(clipEnd(clip), playhead)),
        onSelect: () => splitAtPlayhead(),
      },
      'separator',
      dissolveEntry('Cross dissolve at start', previous, clip),
      dissolveEntry('Cross dissolve at end', clip, next),
      // Against black instead of against a neighbour — the only option at the
      // very start and end of a track, and the commonest transition there is.
      dissolveEntry('Fade in from black', null, clip, true),
      dissolveEntry('Fade out to black', clip, null, true),
      'separator',
      {
        label: linked.length > 1 ? `Detach audio from video (${linked.length} clips)` : 'Detach audio from video',
        icon: <IconUnlink />,
        disabled: linked.length < 2,
        onSelect: () => run({ type: 'unlinkClips', clipIds: [clip.id] }, 'Detach audio'),
      },
      {
        label: 'Link selected clips',
        icon: <IconLink />,
        disabled: selection.length < 2,
        onSelect: () => run({ type: 'linkClips', clipIds: selection }, 'Link clips'),
      },
      'separator',
      {
        label: 'Group',
        icon: <IconGroup />,
        hint: 'Ctrl+G',
        disabled: selection.length < 2,
        onSelect: () => run({ type: 'groupClips', clipIds: selection }, 'Group clips'),
      },
      {
        label: 'Ungroup',
        icon: <IconUngroup />,
        hint: 'Ctrl+Shift+G',
        disabled: !selection.some((id) => project.clips[id]?.groupId),
        onSelect: () => run({ type: 'ungroupClips', clipIds: selection }, 'Ungroup clips'),
      },
      'separator',
      {
        label: clip.enabled ? 'Disable' : 'Enable',
        icon: clip.enabled ? <IconEyeOff /> : <IconEye />,
        onSelect: () =>
          run(
            { type: 'setClipProps', clipId: clip.id, props: { enabled: !clip.enabled } },
            clip.enabled ? 'Disable clip' : 'Enable clip',
          ),
      },
      {
        label: clip.locked ? 'Unlock' : 'Lock',
        icon: clip.locked ? <IconLock /> : <IconUnlocked />,
        onSelect: () =>
          run(
            { type: 'setClipProps', clipId: clip.id, props: { locked: !clip.locked } },
            clip.locked ? 'Unlock clip' : 'Lock clip',
          ),
      },
      'separator',
      ...(inspectorOpen
        ? []
        : ([
            {
              label: 'Show properties',
              icon: <IconInspector />,
              hint: 'Ctrl+4',
              onSelect: () => {
                select([clip.id]);
                setInspectorOpen(true);
              },
            },
            'separator',
          ] as MenuEntry[])),
      {
        label: targets.length > 1 ? `Delete ${targets.length} clips` : 'Delete',
        icon: <IconTrash />,
        hint: 'Del',
        danger: true,
        onSelect: () => run({ type: 'removeClips', clipIds: targets, mode: 'lift' }, 'Delete clips'),
      },
      {
        label: 'Ripple delete',
        icon: <IconRipple />,
        danger: true,
        onSelect: () => run({ type: 'removeClips', clipIds: targets, mode: 'ripple' }, 'Ripple delete'),
      },
    ];
    menu.open(event, entries);
  };

  /** Would rolling this cut to the playhead actually move it anywhere legal? */
  const rollableToPlayhead = (transition: Transition): boolean => {
    const to = transition.toClipId === null ? null : project.clips[transition.toClipId];
    return to !== null && to !== undefined && !T.eq(to.start, playhead);
  };

  const openTransitionMenu = (event: React.MouseEvent, transition: Transition): void => {
    event.stopPropagation();
    // Same as right-clicking a clip or a track: the menu acts on this one, so the
    // inspector should be looking at it too.
    selectTransition(transition.id);
    const seconds = T.toSeconds(transition.duration);
    // Every paired cut restyles, retimes and clears together, so a linked A/V
    // pair can never end up with a 2 s picture wipe over a 1 s audio crossfade.
    const paired = pairedTransitions(project, transition);
    const audioOnly = getTrack(project, transition.trackId).kind === 'audio';

    menu.open(event, [
      ...TRANSITION_TYPES.map((type) => ({
        label: transitionLabel(type),
        icon: <IconTransition />,
        checked: transition.transitionType === type,
        // Sound has no edge to wipe; an audio-only transition is always a crossfade.
        disabled: audioOnly && type !== 'dissolve',
        onSelect: () =>
          runMany(
            paired.map((t) => ({
              type: 'setTransitionType' as const,
              transitionId: t.id,
              // The picture wipes; the sound underneath still crossfades.
              transitionType:
                getTrack(project, t.trackId).kind === 'audio' ? 'dissolve' : type,
            })),
            'Set transition style',
          ),
      })),
      'separator',
      {
        label: 'Roll cut to playhead',
        icon: <IconNextEdit />,
        hint: 'Alt-drag',
        // Only means anything with a clip on both sides, and somewhere to go.
        disabled:
          transition.fromClipId === null ||
          transition.toClipId === null ||
          !rollableToPlayhead(transition),
        onSelect: () =>
          runMany(
            paired
              .filter((t) => t.fromClipId !== null && t.toClipId !== null)
              .map((t) => ({
                type: 'rollEdit' as const,
                fromClipId: t.fromClipId!,
                toClipId: t.toClipId!,
                to: playhead,
              })),
            'Roll edit',
          ),
      },
      {
        label: 'Recentre on the cut',
        icon: <IconTransition />,
        hint: 'drag to slide',
        disabled: transition.offset === null,
        onSelect: () =>
          runMany(
            paired.map((t) => ({
              type: 'setTransitionOffset' as const,
              transitionId: t.id,
              offset: null,
            })),
            'Recentre transition',
          ),
      },
      'separator',
      {
        label: 'Set duration…',
        icon: <IconTransition />,
        onSelect: () => {
          const answer = prompt('Transition length in seconds', String(seconds));
          const value = answer === null ? NaN : Number(answer);
          if (!Number.isFinite(value) || value <= 0) return;
          runMany(
            paired.map((t) => ({
              type: 'setTransitionDuration' as const,
              transitionId: t.id,
              duration: T.fromSeconds(value, 1000),
            })),
            'Set transition length',
          );
        },
      },
      'separator',
      ...(inspectorOpen
        ? []
        : ([
            {
              label: 'Show properties',
              icon: <IconInspector />,
              hint: 'Ctrl+4',
              onSelect: () => setInspectorOpen(true),
            },
            'separator',
          ] as MenuEntry[])),
      {
        label: paired.length > 1 ? `Remove transition (${paired.length})` : 'Remove transition',
        icon: <IconTrash />,
        danger: true,
        onSelect: () =>
          runMany(
            paired.map((t) => ({ type: 'removeTransition' as const, transitionId: t.id })),
            'Remove transition',
          ),
      },
    ]);
  };

  const openLaneMenu = (event: React.MouseEvent, trackId: TrackId): void => {
    const at = timeAtClientX(event.clientX);
    menu.open(event, [
      {
        label: 'Move playhead here',
        icon: <IconNextEdit />,
        onSelect: () => setPlayhead(at),
      },
      {
        label: 'Split all tracks at playhead',
        icon: <IconSplit />,
        hint: 'S',
        onSelect: () => splitAt(playhead, trackIds),
      },
      'separator',
      {
        label: 'Add video track',
        icon: <IconVideo />,
        onSelect: () => run({ type: 'addTrack', sequenceId, kind: 'video' }, 'Add video track'),
      },
      {
        label: 'Add audio track',
        icon: <IconAudio />,
        onSelect: () => run({ type: 'addTrack', sequenceId, kind: 'audio' }, 'Add audio track'),
      },
      'separator',
      {
        label: 'Delete this track',
        icon: <IconTrash />,
        danger: true,
        disabled: trackIds.length <= 1,
        onSelect: () => run({ type: 'removeTrack', trackId }, 'Remove track'),
      },
    ]);
  };

  const openRulerMenu = (event: React.MouseEvent): void => {
    const at = timeAtClientX(event.clientX);
    menu.open(event, [
      {
        label: 'Split all tracks at playhead',
        icon: <IconSplit />,
        hint: 'S',
        onSelect: () => splitAt(playhead, trackIds),
      },
      {
        label: 'Split all tracks here',
        icon: <IconSplit />,
        onSelect: () => {
          setPlayhead(at);
          splitAt(at, trackIds);
        },
      },
      'separator',
      {
        label: 'Add marker here',
        icon: <IconMarker />,
        onSelect: () => run({ type: 'addMarker', sequenceId, at }, 'Add marker'),
      },
      {
        label: 'Go to start',
        icon: <IconSkipStart />,
        onSelect: () => setPlayhead(T.TIME_ZERO),
      },
    ]);
  };

  // ------------------------------------------------------------- interaction

  const scrubFromEvent = (event: React.PointerEvent): void => {
    setPlayhead(timeAtClientX(event.clientX));
  };

  const onRulerPointerDown = (event: React.PointerEvent): void => {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    scrubFromEvent(event);
  };
  const onRulerPointerMove = (event: React.PointerEvent): void => {
    if (event.buttons === 1) scrubFromEvent(event);
  };

  /**
   * Ctrl/Cmd+wheel zooms; a plain wheel is left alone so the container scrolls
   * through the tracks, and Shift+wheel pans sideways. Zoom keeps whatever is under
   * the pointer under the pointer — rescaling around the left edge makes the clip
   * you are aiming at slide away.
   *
   * Registered natively with `passive: false`. React attaches wheel listeners
   * passively, so `preventDefault` inside an `onWheel` prop is ignored and the
   * browser zooms the whole page alongside the timeline.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();

      const rect = el.getBoundingClientRect();
      const offset = event.clientX - rect.left - HEADER_WIDTH;
      pendingAnchor.current = { seconds: (offset + el.scrollLeft) / zoomRef.current, offset };
      setZoom(zoomRef.current * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  /**
   * Re-anchor after a zoom, once the DOM carries the new width.
   *
   * This has to be a layout effect: a `requestAnimationFrame` callback can run
   * before React commits the re-render, so the correction lands against the old
   * width and the content drifts anyway.
   */
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    pendingAnchor.current = null;
    el.scrollLeft = Math.max(0, anchor.seconds * pxPerSecond - anchor.offset);
  }, [pxPerSecond]);

  const ticks = useMemo(
    () => buildTicks(totalSeconds, pxPerSecond, sequence.frameRate),
    [totalSeconds, pxPerSecond, sequence.frameRate],
  );

  return (
    <div className="timeline" ref={scrollRef}>
      {/*
        One scroll container for the headers, the ruler and the lanes. The header
        column is sticky-left and the ruler sticky-top, so both stay put while the
        whole thing scrolls in either direction. Two separately-scrolling panes
        (the previous arrangement) clipped vertically and left tracks unreachable.
      */}
      <div className="timeline-grid" style={{ width: HEADER_WIDTH + contentWidth }}>
        <div className="timeline-topbar">
          <div className="timeline-corner" style={{ width: HEADER_WIDTH }}>
            <button
              className="icon"
              title="Add a video track"
              onClick={() => run({ type: 'addTrack', sequenceId, kind: 'video' }, 'Add video track')}
            >
              <IconPlus /> <IconVideo size={11} />
            </button>
            <button
              className="icon"
              title="Add an audio track"
              onClick={() => run({ type: 'addTrack', sequenceId, kind: 'audio' }, 'Add audio track')}
            >
              <IconPlus /> <IconAudio size={11} />
            </button>
          </div>
          <div
            className="ruler"
            style={{ width: contentWidth }}
            onPointerDown={onRulerPointerDown}
            onPointerMove={onRulerPointerMove}
            onContextMenu={openRulerMenu}
          >
            {ticks.map((tick) => (
              <div key={tick.seconds} className="tick" style={{ left: tick.x }}>
                {tick.label}
              </div>
            ))}
          </div>
        </div>

        <div className="timeline-body" ref={lanesRef}>
          {trackIds.map((trackId) => {
            const track = getTrack(project, trackId);
            const height = Math.max(MIN_TRACK_HEIGHT, track.height);
            return (
              <div className="timeline-row" key={trackId} style={{ height }}>
                <TrackHeader
                  track={track}
                  onCommand={run}
                  removable={trackIds.length > 1}
                  width={HEADER_WIDTH}
                  selected={selectedTrackId === trackId}
                  onSelect={() => selectTrack(trackId)}
                />
                <div
                  data-track-id={trackId}
                  className={`track-lane${track.locked ? ' locked' : ''}${
                    dropGhosts?.trackIds.includes(trackId) ? ' drop-active' : ''
                  }`}
                  style={{ width: contentWidth }}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes(TRANSITION_DRAG_TYPE)) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'copy';
                      return;
                    }
                    if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                    setDropTrackId(trackId);
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                    setDropTrackId((current) => (current === trackId ? null : current));
                  }}
                  onDrop={(event) => {
                    const droppedTransition = event.dataTransfer.getData(TRANSITION_DRAG_TYPE);
                    if (droppedTransition) {
                      event.preventDefault();
                      setDropTrackId(null);
                      // The cut nearest where it was let go, on this track only.
                      dropTransitionOnTrack(droppedTransition, trackId, timeAtClientX(event.clientX));
                      return;
                    }
                    const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE);
                    setDropTrackId(null);
                    if (!assetId) return;
                    event.preventDefault();
                    dropAssetOnTrack(assetId as never, trackId);
                  }}
                  onDragEnd={() => setDropTrackId(null)}
                  onPointerDown={(event) => {
                    // Only from bare lane: a clip or a badge handles its own.
                    if (event.target !== event.currentTarget) return;
                    if (!event.ctrlKey && !event.metaKey) select([]);
                    setMarquee({
                      originClientX: event.clientX,
                      originClientY: event.clientY,
                      clientX: event.clientX,
                      clientY: event.clientY,
                      additive: event.ctrlKey || event.metaKey,
                    });
                  }}
                  onContextMenu={(event) => {
                    if (event.target === event.currentTarget) openLaneMenu(event, trackId);
                  }}
                >
                  {dropGhosts?.trackIds.includes(trackId) && (
                    <div
                      className="drop-ghost"
                      style={{ left: dropGhosts.left, width: dropGhosts.width }}
                    >
                      <span>{dropGhosts.label}</span>
                      {dropGhosts.newTrackNote && trackId === dropTrackId && (
                        <span className="ghost-note">{dropGhosts.newTrackNote}</span>
                      )}
                    </div>
                  )}
                  {trackTransitions(project, trackId).map((transition) => {
                    const span = transitionSpan(project, transition);
                    if (!span) return null;
                    const width = Math.max(8, T.toSeconds(span.duration) * pxPerSecond);
                    const label = transitionShortLabel(transition.transitionType);
                    return (
                      <div
                        key={transition.id}
                        className={`clip-transition${
                          selectedTransitionId === transition.id ? ' selected' : ''
                        }`}
                        style={{ left: T.toSeconds(span.start) * pxPerSecond, width }}
                        title={`${transitionLabel(transition.transitionType)} · ${T.formatDuration(transition.duration, { decimals: 2 })}\nDrag to slide · drag an edge to retime · Alt-drag to roll the cut`}
                        onContextMenu={(event) => openTransitionMenu(event, transition)}
                        onPointerDown={(event) => {
                          // The badge covers the cut's own trim handles, so Alt on
                          // the body is how the cut underneath stays reachable.
                          startTransitionDrag(
                            event,
                            transition,
                            event.altKey ? 'roll' : 'slide',
                          );
                        }}
                      >
                        {/* Only worth the room once the badge is wide enough to read. */}
                        {width >= 56 && <span className="transition-label">{label}</span>}
                        <div
                          className="transition-handle left"
                          onPointerDown={(event) => startTransitionDrag(event, transition, 'length')}
                        />
                        <div
                          className="transition-handle right"
                          onPointerDown={(event) => startTransitionDrag(event, transition, 'length')}
                        />
                      </div>
                    );
                  })}
                  {trackClips(project, trackId).map((clip) => (
                    <ClipView
                      key={clip.id}
                      clip={clip}
                      pxPerSecond={pxPerSecond}
                      selected={selection.includes(clip.id)}
                      preview={previewStyle(clip, pxPerSecond, previews)}
                      onSelect={(modifier) => {
                        if (modifier === 'isolate') selectExact([clip.id]);
                        else if (modifier === 'toggle') toggleSelect(clip.id);
                        else if (modifier === 'range') selectRangeTo(clip.id);
                        else select([clip.id]);
                      }}
                      onDragStart={(event, kind, modifier) => startDrag(event, clip, kind, modifier)}
                      onContextMenu={(event) => openClipMenu(event, clip)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

        </div>

        {marquee && <MarqueeBox marquee={marquee} />}

        {/*
          A sibling of the topbar and the lanes rather than a child of either, so the
          line runs from the ruler right down through the tracks. Its head sits in
          the ruler and takes pointer events, so the playhead can be dragged directly
          instead of only by clicking the ruler behind it.
        */}
        <div
          className="playhead"
          style={{ left: HEADER_WIDTH + T.toSeconds(playhead) * pxPerSecond }}
        >
          <div
            className="playhead-head"
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (event.buttons !== 1) return;
              setPlayhead(timeAtClientX(event.clientX));
            }}
          />
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- pieces

function TrackHeader({
  track,
  onCommand,
  removable,
  width,
  selected,
  onSelect,
}: {
  track: Track;
  onCommand: (command: Command, label: string) => void;
  removable: boolean;
  width: number;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const menu = useContextMenu();
  const setInspectorOpen = useLayout((s) => s.setInspectorOpen);
  const inspectorOpen = useLayout((s) => s.inspectorOpen);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(track.name);

  const toggle = (props: Record<string, boolean>, label: string): void =>
    onCommand({ type: 'setTrackProps', trackId: track.id, props }, label);

  const remove = (): void =>
    onCommand({ type: 'removeTrack', trackId: track.id }, 'Remove track');

  const startRename = (): void => {
    setDraft(track.name);
    setRenaming(true);
  };

  const commitRename = (): void => {
    setRenaming(false);
    const name = draft.trim();
    // An empty name would leave the header blank with no way back to it.
    if (name && name !== track.name) {
      onCommand({ type: 'setTrackProps', trackId: track.id, props: { name } }, 'Rename track');
    }
  };

  const entries: MenuEntry[] = [
    ...(inspectorOpen
      ? []
      : ([
          {
            label: 'Show properties',
            icon: <IconInspector />,
            hint: 'Ctrl+4',
            onSelect: () => {
              onSelect();
              setInspectorOpen(true);
            },
          },
        ] as MenuEntry[])),
    { label: 'Rename track…', icon: <IconText />, onSelect: startRename },
    'separator',
    ...(track.kind === 'audio'
      ? [
          {
            label: track.muted ? 'Unmute' : 'Mute',
            icon: track.muted ? <IconMuted /> : <IconVolume />,
            onSelect: () => toggle({ muted: !track.muted }, 'Mute track'),
          },
          {
            label: track.solo ? 'Unsolo' : 'Solo',
            icon: <IconSolo />,
            onSelect: () => toggle({ solo: !track.solo }, 'Solo track'),
          },
        ]
      : [
          {
            label: track.hidden ? 'Show track' : 'Hide track',
            icon: track.hidden ? <IconEyeOff /> : <IconEye />,
            onSelect: () => toggle({ hidden: !track.hidden }, 'Hide track'),
          },
        ]),
    {
      label: track.locked ? 'Unlock track' : 'Lock track',
      icon: track.locked ? <IconLock /> : <IconUnlocked />,
      onSelect: () => toggle({ locked: !track.locked }, 'Lock track'),
    },
    'separator',
    {
      label: 'Delete track',
      icon: <IconTrash />,
      danger: true,
      disabled: !removable,
      onSelect: remove,
    },
  ];

  return (
    <div
      className={`track-header${selected ? ' selected' : ''}`}
      style={{ width }}
      onPointerDown={(event) => {
        // Buttons and the rename field handle their own clicks.
        if ((event.target as HTMLElement).closest('button, input')) return;
        onSelect();
      }}
      onContextMenu={(event) => {
        onSelect();
        menu.open(event, entries);
      }}
    >
      <span className="track-kind">
        {track.kind === 'audio' ? <IconAudio size={12} /> : <IconVideo size={12} />}
      </span>
      {renaming ? (
        <input
          className="rename-input"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRename();
            if (event.key === 'Escape') setRenaming(false);
            event.stopPropagation();
          }}
          // The lane below would otherwise start a selection under the field.
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : (
        <span
          className="label"
          title={`${track.name} — double-click to rename`}
          onDoubleClick={startRename}
        >
          {track.name}
        </span>
      )}
      {track.kind === 'audio' ? (
        <>
          <button
            className={`icon${track.muted ? ' on' : ''}`}
            title={track.muted ? 'Unmute' : 'Mute'}
            onClick={() => toggle({ muted: !track.muted }, 'Mute track')}
          >
            {track.muted ? <IconMuted /> : <IconVolume />}
          </button>
          <button
            className={`icon${track.solo ? ' on' : ''}`}
            title="Solo"
            onClick={() => toggle({ solo: !track.solo }, 'Solo track')}
          >
            <IconSolo />
          </button>
          <TrackVolume track={track} />
        </>
      ) : (
        <button
          className={`icon${track.hidden ? ' on' : ''}`}
          title={track.hidden ? 'Show track' : 'Hide track'}
          onClick={() => toggle({ hidden: !track.hidden }, 'Hide track')}
        >
          {track.hidden ? <IconEyeOff /> : <IconEye />}
        </button>
      )}
      <button
        className={`icon${track.locked ? ' on' : ''}`}
        title={track.locked ? 'Unlock track' : 'Lock track'}
        onClick={() => toggle({ locked: !track.locked }, 'Lock track')}
      >
        {track.locked ? <IconLock /> : <IconUnlocked />}
      </button>
      {removable && (
        <button className="icon" title="Delete this track and its clips" onClick={remove}>
          <IconClose />
        </button>
      )}
    </div>
  );
}

/**
 * Position the asset-wide filmstrip or waveform behind a clip.
 *
 * The image covers the whole source, so trimming and moving only shift a CSS
 * background — no re-rasterisation, and clips cut from one asset share one image.
 */
function previewStyle(
  clip: Clip,
  pxPerSecond: number,
  previews: PreviewCache | null,
): React.CSSProperties | undefined {
  if (!previews || !isMediaClip(clip)) return undefined;

  const preview =
    clip.kind === 'audio' ? previews.getWaveform(clip.assetId) : previews.getFilmstrip(clip.assetId);
  if (!preview) return undefined;

  // A still has no timeline of frames to map onto: tile the poster instead.
  if (preview.sourceSeconds <= 0) {
    return {
      backgroundImage: `url(${preview.url})`,
      backgroundSize: 'auto 100%',
      backgroundRepeat: 'repeat-x',
      backgroundPosition: 'left center',
    };
  }

  const speed = Math.abs(clip.speed) || 1;
  // Pixels the whole source would occupy at this zoom and speed.
  const sourceWidth = (preview.sourceSeconds / speed) * pxPerSecond;
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) return undefined;

  const offset = (T.toSeconds(clip.sourceIn) / speed) * pxPerSecond;
  return {
    backgroundImage: `url(${preview.url})`,
    backgroundSize: `${sourceWidth}px 100%`,
    backgroundPosition: `${-offset}px center`,
    backgroundRepeat: 'no-repeat',
  };
}

function ClipView({
  clip,
  pxPerSecond,
  selected,
  preview,
  onSelect,
  onDragStart,
  onContextMenu,
}: {
  clip: Clip;
  pxPerSecond: number;
  selected: boolean;
  preview: React.CSSProperties | undefined;
  onSelect: (modifier: SelectModifier) => void;
  onDragStart: (event: React.PointerEvent, kind: DragKind, modifier: SelectModifier) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}): React.JSX.Element {
  const left = T.toSeconds(clip.start) * pxPerSecond;
  const width = Math.max(2, T.toSeconds(clip.duration) * pxPerSecond);
  const kindClass =
    clip.kind === 'audio'
      ? 'audio'
      : clip.kind === 'title'
        ? 'title'
        : clip.kind === 'solid'
          ? 'solid'
          : 'video';
  // A fill clip shows the colour it produces, so the timeline reads at a glance.
  const fillStyle = clip.kind === 'solid' ? { background: clip.fill } : undefined;

  return (
    <div
      className={`clip ${kindClass}${selected ? ' selected' : ''}${clip.enabled ? '' : ' disabled'}${preview ? ' has-preview' : ''}${isGrouped(clip) ? ' grouped' : ''}`}
      style={{ left, width, ...preview, ...fillStyle }}
      title={`${clip.name} · ${T.formatDuration(clip.duration, { decimals: 2 })}`}
      onContextMenu={onContextMenu}
      onPointerDown={(event) => {
        const modifier = selectModifier(event);
        onSelect(modifier);
        onDragStart(event, 'move', modifier);
      }}
    >
      <div
        className="handle left"
        onPointerDown={(event) => {
          const modifier = event.altKey ? 'isolate' : 'replace';
          onSelect(modifier);
          onDragStart(event, 'trim-in', modifier);
        }}
      />
      <div className="clip-name">{clip.name}</div>
      <div
        className="handle right"
        onPointerDown={(event) => {
          const modifier = event.altKey ? 'isolate' : 'replace';
          onSelect(modifier);
          onDragStart(event, 'trim-out', modifier);
        }}
      />
    </div>
  );
}

interface Tick {
  readonly seconds: number;
  readonly x: number;
  readonly label: string;
}

/** Choose a tick spacing that keeps labels at least ~80 px apart. */
/**
 * Track volume, in the header rather than only in the inspector.
 *
 * The mixer has always applied `gainDb`; reaching it meant selecting the track
 * first, which is not where anyone looks for a fader.
 */
function TrackVolume({ track }: { track: Track }): React.JSX.Element {
  const run = useStudio((s) => s.run);
  const endGesture = useStudio((s) => s.endGesture);
  const db = staticValue(track.gainDb, 0);

  return (
    <input
      className="track-volume"
      type="range"
      min={-60}
      max={12}
      step={0.5}
      value={db}
      title={`Volume ${db > 0 ? '+' : ''}${db.toFixed(1)} dB — double-click for unity`}
      onChange={(event) =>
        run(
          {
            type: 'setTrackParam',
            trackId: track.id,
            key: 'gainDb',
            param: staticParam(Number(event.target.value)),
          },
          'Set track volume',
          `gain:${track.id}`,
        )
      }
      onPointerUp={endGesture}
      onDoubleClick={() =>
        run(
          { type: 'setTrackParam', trackId: track.id, key: 'gainDb', param: staticParam(0) },
          'Reset track volume',
        )
      }
      // Otherwise the header behind it takes the drag and selects the track.
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

/** Static value of a parameter, or a fallback when it is keyframed. */
function staticValue(param: Param<number>, fallback: number): number {
  return param.kind === 'static' ? param.value : fallback;
}

/** The rubber band itself, positioned straight from the pointer. */
function MarqueeBox({ marquee }: { marquee: MarqueeState }): React.JSX.Element {
  const left = Math.min(marquee.originClientX, marquee.clientX);
  const top = Math.min(marquee.originClientY, marquee.clientY);
  return (
    <div
      className="marquee"
      style={{
        left,
        top,
        width: Math.abs(marquee.clientX - marquee.originClientX),
        height: Math.abs(marquee.clientY - marquee.originClientY),
      }}
    />
  );
}

function buildTicks(
  totalSeconds: number,
  pxPerSecond: number,
  frameRate: FrameRate,
): readonly Tick[] {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const step = candidates.find((c) => c * pxPerSecond >= 80) ?? 3600;

  const ticks: Tick[] = [];
  for (let seconds = 0; seconds <= totalSeconds; seconds += step) {
    ticks.push({
      seconds,
      x: seconds * pxPerSecond,
      label: formatTick(seconds, frameRate),
    });
  }
  return ticks;
}

/**
 * Real timecode on the ruler.
 *
 * Derived from the sequence's own frame rate rather than counted in decimal
 * seconds, so the ruler and the transport readout agree — which they did not
 * when this formatted `M:SS` by hand.
 */
function formatTick(seconds: number, frameRate: FrameRate): string {
  const [hh = '00', mm = '00', ss = '00', ff = '00'] = T.toTimecode(
    T.fromSeconds(seconds, 1000),
    frameRate,
  ).split(/[:;]/);

  // Frames are shown even where they are always 00, because dropping them makes
  // `MM:SS` and `HH:MM` indistinguishable at a glance. Hours appear only once the
  // sequence is long enough to have any.
  const hours = Number(hh);
  return hours > 0 ? `${hh}:${mm}:${ss}:${ff}` : `${mm}:${ss}:${ff}`;
}

