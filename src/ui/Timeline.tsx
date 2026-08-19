/**
 * Timeline.
 *
 * Clip geometry comes straight from the document — there is no parallel UI model to
 * fall out of sync. Drags mutate the document through coalesced commands, so a whole
 * gesture collapses into one undo step (see `endGesture`).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '../model/commands';
import { DEFAULT_TRACK_HEIGHT } from '../model/factories';
import {
  clipEnd,
  clipFitsTrack,
  clipSourceSpan,
  getTrack,
  isGrouped,
  isMediaClip,
  linkability,
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
  SequenceId,
  Time,
  Track,
  TrackId,
  TrackKind,
  Transition,
  TransitionId,
} from '../model/types';
import { clipMenuTargets } from './clipMenuTargets';
import { LanePreview, type LaneClip } from './LanePreview';
import { useContextMenu, type MenuEntry } from './ContextMenu';
import { useDialog } from './Dialog';
import { clipsForDragOrigin } from './dragOrigin';
import { planGapInsert } from './insertGap';
import { ownsPointerGesture } from './pointerGesture';
import { shiftedTrack } from './trackShift';
import {
  IconAlert,
  IconAudio,
  IconFade,
  IconEye,
  IconEyeOff,
  IconGroup,
  IconInspector,
  IconLink,
  IconLock,
  IconMarker,
  IconMore,
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
import { Fader } from './Fader';
import {
  formatGain,
  formatGainPercent,
  formatPercent,
  GAIN_PERCENT_MAX,
  GAIN_PERCENT_UNITY,
  gainDbToPercent,
  percentToGainDb,
} from './format';
import {
  TIMELINE_VIDEO_RATIO_MAX,
  TIMELINE_VIDEO_RATIO_MIN,
  useLayout,
} from './layout';
import {
  appendPointFor,
  counterpartTrackId,
  emptyTracksToRemove,
  orderedTrackIds,
  useStudio,
} from './store';
import {
  clampTrackHeight,
  isExpandedTrackHeader,
  TRACK_HEIGHT_MAX,
  TRACK_HEIGHT_MIN,
  TRACK_HEIGHT_STEP,
} from './trackHeight';
import {
  DEFAULT_TRANSITION_SECONDS,
  transitionLabel,
  transitionShortLabel,
} from './transitions';

/**
 * Width of the sticky track-header column.
 *
 * Wide enough for an expanded audio header's identity and mixing rows.
 */
const HEADER_WIDTH = 216;
const TRACK_SECTION_DIVIDER_HEIGHT = 8;
const MIN_TAIL_SECONDS = 10;
const SNAP_PIXELS = 8;

type DragKind = 'move' | 'trim-in' | 'trim-out';

/**
 * Scroll a pane by the least it takes to show one of its rows.
 *
 * `scrollIntoView` would do it, but it walks every scrollable ancestor on the way
 * up — which here means yanking the timeline sideways and the page with it.
 */
function scrollRowIntoPane(pane: HTMLElement, row: HTMLElement): void {
  const paneRect = pane.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const above = rowRect.top - paneRect.top;
  const below = rowRect.bottom - paneRect.bottom;
  // A row taller than the pane cannot be shown whole, so its top wins.
  if (above < 0) pane.scrollTop += above;
  else if (below > 0) pane.scrollTop += Math.min(below, above);
}

/**
 * A time after snapping, and what it snapped to.
 *
 * The readout has to show the snapped value rather than the raw pointer time: a
 * number that disagrees with where the clip actually lands is worse than none,
 * and it disagrees precisely when accuracy is being relied on.
 */
interface Snapped {
  readonly at: Time;
  /** The point it locked onto, or null when it moved freely. */
  readonly hit: Time | null;
}

/**
 * The timecode that follows the pointer through a drag.
 *
 * Placed from client coordinates and rendered fixed, so it does not drift when the
 * timeline is scrolled mid-gesture.
 */
interface DragHint {
  readonly clientX: number;
  readonly clientY: number;
  readonly primary: string;
  readonly secondary: string | null;
  readonly snapped: boolean;
}

/**
 * Where a new track would go, worked out from a pointer that has left the block of
 * lanes its clip can live on.
 *
 * Deliberately triggered by leaving the block rather than by hovering near a seam:
 * a proximity band inside the lanes fires on the small vertical drift of an ordinary
 * horizontal drag, and offering to restructure the timeline by accident is worse
 * than making the gesture slightly more deliberate.
 */
interface Insertion {
  /** Which end of the lane block it sits at, so the right gap can light up. */
  readonly where: 'above' | 'below';
  readonly trackKind: TrackKind;
  /** Insertion index within that kind's list in the document. */
  readonly index: number;
  /** Client Y of the edge to draw the line along. */
  readonly clientY: number;
  readonly label: string;
}

/** The same idea for media dragged out of the library, which uses native drag events. */
interface AssetInsertion {
  readonly where: 'top' | 'bottom';
  readonly trackKind: TrackKind;
  readonly index: number;
}

/**
 * Width of a fade or transition button, and how far it sits in from a clip's edge.
 *
 * Sized to the tightest case rather than to taste: an audio clip carries two rows of
 * these, and both have to fit inside a clip on a default 56px audio lane. Anything
 * larger would need the volume row to disappear on an ordinary track. The visual
 * stays small while the *hit* area is padded out in CSS, which is what actually makes
 * them comfortable to click.
 */
/** Shared so a lane with nothing on it does not hand the painter a fresh array. */
const EMPTY_LANE: readonly LaneClip[] = [];

const AFFORDANCE_WIDTH = 18;
const AFFORDANCE_HEIGHT = 16;
/** Clear of the 7px trim handle, which owns the very edge and is used far more often. */
const EDGE_INSET = 9;
/**
 * Shortest lane that can hold a button at the top and another at the bottom.
 *
 * Clips are inset 3px top and bottom, and each row needs 5px of margin — so below
 * this the two rows would overlap and the lower one is dropped instead.
 */
const MIN_LANE_FOR_TWO_ROWS = AFFORDANCE_HEIGHT * 2 + 5 * 2 + 4 + 6;

/**
 * A fade or transition button on a clip boundary.
 *
 * Transitions and fades were only ever reachable through a right-click menu, which is
 * the usual reason a feature goes unused — nothing on screen said either existed.
 */
interface Affordance {
  readonly key: string;
  readonly kind: 'fade-in' | 'fade-out' | 'cut';
  /** Left edge of the button, in lane pixels. */
  readonly x: number;
  readonly clip: Clip;
  /** The clip on the other side of a cut. */
  readonly other?: Clip;
  /** A fade is already there, so the button removes it. */
  readonly active?: boolean;
}

/**
 * What a click on a clip means.
 *
 * Ctrl/Cmd and Shift used to do the same thing. They are the two halves of
 * multi-select everywhere else: one picks clips out individually, the other
 * takes everything between.
 */
type SelectModifier = 'replace' | 'toggle' | 'range' | 'isolate';

/**
 * Whether a pointerdown should start a gesture at all.
 *
 * `pointerdown` fires for the right button too, and it fires *before* `contextmenu`.
 * Without this, right-clicking one of several selected clips ran the plain-click
 * path first and collapsed the selection to that clip — so by the time the menu
 * opened, "Group" saw a single clip and was disabled.
 */
function isPrimaryButton(event: React.PointerEvent): boolean {
  return event.button === 0;
}

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
  /**
   * Where each of them started.
   *
   * A move edits the document on every pointer event rather than drawing a
   * proxy, so once the drag is under way nothing on screen remembers where the
   * clips came from. This is what the outline left behind is drawn from.
   */
  readonly origins: readonly {
    readonly clipId: ClipId;
    readonly trackId: TrackId;
    readonly start: Time;
    readonly duration: Time;
  }[];
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
  const dialog = useDialog();
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
  const removeEmptyTracks = useStudio((s) => s.removeEmptyTracks);
  const selectRangeTo = useStudio((s) => s.selectRangeTo);
  const selectWithin = useStudio((s) => s.selectWithin);
  const setInspectorOpen = useLayout((s) => s.setInspectorOpen);
  const inspectorOpen = useLayout((s) => s.inspectorOpen);
  const timelineVideoRatio = useLayout((s) => s.timelineVideoRatio);
  const setTimelineVideoRatio = useLayout((s) => s.setTimelineVideoRatio);
  const setTimelinePaneScroll = useLayout((s) => s.setTimelinePaneScroll);
  const setStatus = useStudio((s) => s.setStatus);
  const showProgramPreview = useStudio((s) => s.showProgramPreview);
  const selectedTransitionId = useStudio((s) => s.selectedTransitionId);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const toggleSelect = useStudio((s) => s.toggleSelect);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const setZoom = useStudio((s) => s.setZoom);
  const duration = useStudio((s) => s.duration);
  const previews = useStudio((s) => s.previews);
  const dropAssetOnTrack = useStudio((s) => s.dropAssetOnTrack);
  const dropAssetOnNewTrack = useStudio((s) => s.dropAssetOnNewTrack);
  const moveClipsToNewTrack = useStudio((s) => s.moveClipsToNewTrack);
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
  const emptyTrackCount = emptyTracksToRemove(project, sequenceId).length;

  /**
   * Usable width of the pane, tracked so the ruler can fill it.
   *
   * The content is only ever as wide as the sequence plus a tail, so in any window
   * wider than that the ruler and the lanes stopped early and left a band of nothing
   * down the right-hand side. Measuring the pane is the only way to know how much
   * further they have to reach.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const videoPaneRef = useRef<HTMLDivElement>(null);
  const audioPaneRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPaneWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setPaneWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const layout = useLayout.getState();
    if (videoPaneRef.current) videoPaneRef.current.scrollTop = layout.timelineVideoScrollTop;
    if (audioPaneRef.current) audioPaneRef.current.scrollTop = layout.timelineAudioScrollTop;
  }, []);

  /**
   * Bring a track that has just appeared into view.
   *
   * Each stack scrolls on its own and track heights are fixed, so past a few tracks
   * a new one is simply added off-screen: the command runs, nothing visibly happens,
   * and the only clue is a scrollbar that got shorter. Undoing a delete lands here
   * too, which is the same courtesy for the same reason.
   */
  const seenTracks = useRef<{ sequenceId: SequenceId; ids: ReadonlySet<TrackId> } | null>(null);
  useLayoutEffect(() => {
    const previous = seenTracks.current;
    seenTracks.current = { sequenceId, ids: new Set(trackIds) };
    // Nothing was *added* on a first render or a switch of sequence — the whole
    // stack is new, and wherever that sequence was left scrolled to is the answer.
    if (!previous || previous.sequenceId !== sequenceId) return;

    for (const [list, pane] of [
      [sequence.videoTrackIds, videoPaneRef.current],
      [sequence.audioTrackIds, audioPaneRef.current],
    ] as const) {
      if (!pane) continue;
      /*
       * The deepest new one in the *document's* order, which is not the pane's:
       * video renders top-down, so V3 is the first row and V1 the last. Filling
       * the counterpart stack up to a matching index adds several at once — A1,
       * A2, A3 to pair with V3 — and the clip lands on the last of them, which
       * is the one worth looking at.
       */
      const added = list.filter((trackId) => !previous.ids.has(trackId));
      const target = added[added.length - 1];
      if (!target) continue;

      const row = [...pane.querySelectorAll<HTMLElement>('[data-track-id]')]
        .find((element) => element.dataset.trackId === target)
        ?.closest<HTMLElement>('.timeline-row');
      if (row) scrollRowIntoPane(pane, row);
    }
  }, [trackIds, sequenceId, sequence]);

  const tailSeconds = Math.max(T.toSeconds(duration()) + MIN_TAIL_SECONDS, MIN_TAIL_SECONDS);
  // Whichever is longer: the material, or enough to reach the right-hand edge.
  const contentWidth = Math.max(
    Math.ceil(tailSeconds * pxPerSecond),
    Math.ceil(paneWidth - HEADER_WIDTH),
  );
  const totalSeconds = contentWidth / pxPerSecond;

  const lanesRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [transitionDrag, setTransitionDrag] = useState<TransitionDragState | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [dropTrackId, setDropTrackId] = useState<TrackId | null>(null);
  /** Time+offset to restore after a zoom, so the pointer stays over the same frame. */
  const pendingAnchor = useRef<{ seconds: number; offset: number } | null>(null);

  /** The readout following the pointer, and the edge a drag has caught. */
  const [hint, setHint] = useState<DragHint | null>(null);
  const [snapMark, setSnapMark] = useState<Time | null>(null);
  const [insertion, setInsertion] = useState<Insertion | null>(null);
  /**
   * The live insertion, for the pointer-up handler.
   *
   * `up` closes over the render that registered it, and the last pointer move may
   * have arrived after that — a ref is what makes the drop see the newest answer.
   */
  const insertionRef = useRef<Insertion | null>(null);
  /**
   * A media drop aimed above or below every lane.
   *
   * The clip-drag path works this out from the pointer on each move; a native
   * drag cannot, because `dragover` fires on whatever element is under the cursor
   * and the space above the lanes belongs to the ruler.
   */
  const [assetInsertion, setAssetInsertion] = useState<AssetInsertion | null>(null);

  const frameRate = sequence.frameRate;
  /** For the hover timer, which fires outside the render that scheduled it. */
  const frameRateRef = useRef(frameRate);
  frameRateRef.current = frameRate;

  /**
   * The clip detail card, and the timer that delays it.
   *
   * Suppressed outright while a drag is running: during a gesture the readout that
   * follows the pointer is the thing worth reading, and a second floating panel
   * fighting it for the same corner of the screen is just noise.
   */
  const [hoverCard, setHoverCard] = useState<HoverCardState | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A card is on screen, so movement should not restart its clock. */
  const hoverShown = useRef(false);
  /**
   * Whether any gesture owns the pointer, read from inside the pending timer.
   *
   * A ref rather than the state itself: the timer was scheduled in an earlier render
   * and closes over whatever was true then, which is exactly the moment before a
   * drag begins.
   */
  const gestureRef = useRef(false);
  gestureRef.current = drag !== null || transitionDrag !== null || marquee !== null;

  const cancelHover = useCallback((): void => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hoverShown.current = false;
    setHoverCard(null);
  }, []);

  const scheduleHover = useCallback(
    (event: React.PointerEvent, clip: Clip): void => {
      // Never during a gesture. Dragging, trimming, sweeping a marquee — a card that
      // appears in the middle of any of them lands on top of the work it describes,
      // and the answer it gives is one nobody asked for.
      if (gestureRef.current) return;
      // Already answered: leave it be. Restarting the clock on a card that is on
      // screen would make it flicker as the pointer drifts over the same clip.
      if (hoverShown.current) return;

      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
      const { clientX, clientY } = event;
      hoverTimer.current = setTimeout(() => {
        const latest = useStudio.getState();
        // Gone, or a gesture started while we were waiting.
        const current = latest.project().clips[clip.id];
        if (!current || gestureRef.current) return;
        const detail = clipDetails(latest.project(), current, frameRateRef.current);
        hoverShown.current = true;
        setHoverCard({ subjectId: clip.id, clientX, clientY, ...detail, subtitle: detail.subtitle });
      }, TIMELINE_HOVER_DELAY_MS);
    },
    [],
  );

  /*
   * Drop the card when the clip it describes goes.
   *
   * Deleting whatever is under the pointer unmounts it, so no `pointerleave` ever
   * arrives and the card is left describing a clip that is not there any more. The
   * same applies to undo, to a ripple delete taking a neighbour, and to a split
   * replacing one clip with two.
   */
  useEffect(() => {
    if (hoverCard && !project.clips[hoverCard.subjectId as ClipId]) cancelHover();
  }, [project.clips, hoverCard, cancelHover]);

  // A pending card must not land after this panel has gone.
  useEffect(() => cancelHover, [cancelHover]);

  /** Clear everything a gesture puts on screen. */
  const clearGestureHints = useCallback((): void => {
    setHint(null);
    setSnapMark(null);
    setInsertion(null);
    insertionRef.current = null;
  }, []);

  /**
   * Where a media drop above or below every lane would put its new track.
   *
   * Null when the asset has no stream for that kind of track — dragging a music file
   * up over the video stack should not offer to make a video track it cannot fill.
   */
  const assetInsertionFor = useCallback(
    (where: 'top' | 'bottom'): AssetInsertion | null => {
      const asset = draggingAssetId ? project.assets[draggingAssetId] : null;
      if (!asset) return null;
      if (where === 'top') {
        return asset.video
          ? { where, trackKind: 'video', index: sequence.videoTrackIds.length }
          : null;
      }
      return asset.audio ? { where, trackKind: 'audio', index: sequence.audioTrackIds.length } : null;
    },
    [draggingAssetId, project, sequence.videoTrackIds.length, sequence.audioTrackIds.length],
  );

  const showHint = useCallback(
    (event: { clientX: number; clientY: number }, primary: string, secondary: string | null, snapped: boolean): void => {
      setHint({ clientX: event.clientX, clientY: event.clientY, primary, secondary, snapped });
    },
    [],
  );

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
      const pane = lane.closest<HTMLElement>('.timeline-pane');
      if (!pane) continue;
      const paneRect = pane.getBoundingClientRect();
      if (clientY < paneRect.top || clientY > paneRect.bottom) continue;
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
      const pane = lane.closest<HTMLElement>('.timeline-pane');
      if (!pane) continue;
      const paneRect = pane.getBoundingClientRect();
      const rect = lane.getBoundingClientRect();
      const visibleTop = Math.max(rect.top, paneRect.top);
      const visibleBottom = Math.min(rect.bottom, paneRect.bottom);
      if (visibleBottom < visibleTop || visibleBottom < top || visibleTop > bottom) continue;
      const id = lane.dataset.trackId;
      if (id) found.push(id as TrackId);
    }
    return found;
  }, []);

  /** Keep a dragged clip or asset moving through a pane's independently-scrolled stack. */
  const autoScrollPaneAt = useCallback((clientY: number): void => {
    const threshold = 32;
    const maximumStep = 18;
    for (const pane of [videoPaneRef.current, audioPaneRef.current]) {
      if (!pane) continue;
      const rect = pane.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const fromTop = clientY - rect.top;
      const fromBottom = rect.bottom - clientY;
      if (fromTop < threshold) {
        pane.scrollTop -= Math.ceil(maximumStep * (1 - fromTop / threshold));
      } else if (fromBottom < threshold) {
        pane.scrollTop += Math.ceil(maximumStep * (1 - fromBottom / threshold));
      }
      return;
    }
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

  /**
   * Snap a time to nearby clip edges and the playhead, within a pixel tolerance.
   *
   * Reports what it locked onto as well as the result, so the readout can show the
   * value the clip will actually take and the lane can draw a line on the edge it
   * caught — an invisible snap is indistinguishable from a mis-drag.
   */
  const snap = useCallback(
    (at: Time, exclude: ReadonlySet<ClipId>): Snapped => {
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
      return best === null ? { at, hit: null } : { at: best, hit: best };
    },
    [pxPerSecond, playhead, project, trackIds],
  );

  /**
   * Where a new track would go for a clip of this kind, or null to drop normally.
   *
   * Armed by the pointer leaving the block of lanes the clip can live on at all —
   * above the video stack, or below it into the audio lanes where a video clip
   * cannot land anyway. That makes the gesture unambiguous without a proximity band
   * that would fire on the ordinary vertical drift of a horizontal drag.
   */
  /** What a drop in a gap would make, shared by the ghosts and by the drop itself. */
  const gapPlan = useMemo(
    () =>
      drag && insertion
        ? planGapInsert(project, sequence, drag.clipId, drag.groupIds, insertion)
        : null,
    [drag, insertion, project, sequence],
  );

  /**
   * The dragged clips, drawn where they would land rather than left behind on their
   * old lanes. The document is not touched — the tracks do not exist until the drop
   * — so this is the one place the timeline shows something the project does not
   * yet contain.
   */
  const insertGhosts = useMemo(() => {
    const sides: { above: InsertGhost[]; below: InsertGhost[] } = { above: [], below: [] };
    if (!gapPlan) return sides;

    // A ghost is a placeholder for a drop that has not happened, so it carries the
    // clip's own colour rather than its picture: the picture is drawn by the lane
    // the clip is actually on, and a ghost is by definition not on one yet.
    const ghostFor = (clip: Clip): InsertGhost => ({
      id: clip.id,
      left: T.toSeconds(clip.start) * pxPerSecond,
      width: Math.max(2, T.toSeconds(clip.duration) * pxPerSecond),
      kind: clipKindClass(clip),
      height: Math.max(TRACK_HEIGHT_MIN, getTrack(project, clip.trackId).height),
      appearance: clip.kind === 'solid' ? { background: clip.fill } : {},
    });

    sides[gapPlan.primaryTrack.side].push(ghostFor(gapPlan.primary));
    if (gapPlan.partnerTrack) {
      for (const partner of gapPlan.partners) sides[gapPlan.partnerTrack.side].push(ghostFor(partner));
    }
    return sides;
  }, [gapPlan, project, pxPerSecond, previews]);

  /** Clips whose lane copy the ghosts stand in for, so neither is drawn twice. */
  const relocatingIds = useMemo(
    () =>
      new Set<ClipId>(
        gapPlan ? [gapPlan.primary.id, ...(gapPlan.partnerTrack ? gapPlan.partners.map((c) => c.id) : [])] : [],
      ),
    [gapPlan],
  );

  /**
   * What each lane's painter draws, in the lane's own pixel space.
   *
   * Built here because React already knows where every clip sits; the painter only
   * has to map it to the viewport. Keyed by track so a lane re-renders when its own
   * clips move and not when another track's do.
   */
  const lanePlans = useMemo(() => {
    const plans = new Map<TrackId, LaneClip[]>();
    for (const trackId of trackIds) {
      const laneClips: LaneClip[] = [];
      for (const clip of trackClips(project, trackId)) {
        if (!isMediaClip(clip)) continue;
        // A clip being lifted into an insertion gap is shown by its ghost there, so
        // the lane must stop drawing it: hiding the clip's own element no longer
        // hides its picture now that the picture is painted underneath.
        if (relocatingIds.has(clip.id)) continue;
        const asset = project.assets[clip.assetId];
        if (!asset) continue;
        const isAudio = clip.kind === 'audio';
        // A ramp has no single rate a strip could be laid out at, so its average
        // over the clip is used; playback still runs the exact curve.
        const speed = clip.speedRamp
          ? Math.max(0.001, T.ratio(clipSourceSpan(clip), clip.duration))
          : Math.abs(clip.speed) || 1;
        const size = asset.video?.size;
        laneClips.push({
          id: clip.id,
          kind: isAudio ? 'audio' : 'video',
          assetId: clip.assetId,
          x: T.toSeconds(clip.start) * pxPerSecond,
          width: Math.max(1, T.toSeconds(clip.duration) * pxPerSecond),
          sourceIn: T.toSeconds(clip.sourceIn),
          speed,
          sourceSeconds: T.toSeconds(
            (isAudio ? asset.audio?.duration : asset.video?.duration) ?? clip.duration,
          ),
          frameAspect: size && size.width > 0 && size.height > 0 ? size.width / size.height : 16 / 9,
        });
      }
      plans.set(trackId, laneClips);
    }
    return plans;
  }, [project, trackIds, pxPerSecond, relocatingIds]);

  const insertionAt = useCallback(
    (clientY: number, clipKind: Clip['kind']): Insertion | null => {
      // Nothing to insert relative to yet.
      if (!lanesRef.current?.querySelector('[data-track-id]')) return null;

      // Each adaptive tail is both the spare pane space and the new-track target.
      // Hit-testing it directly keeps the ruler and the opposite media section out.
      const zone = [...(lanesRef.current?.querySelectorAll<HTMLElement>('[data-insert-gap]') ?? [])]
        .map((element) => ({
          side: element.dataset.insertGap,
          rect: element.getBoundingClientRect(),
          paneRect: element.closest<HTMLElement>('.timeline-pane')?.getBoundingClientRect(),
        }))
        .find(
          ({ rect, paneRect }) =>
            paneRect &&
            clientY >= paneRect.top &&
            clientY <= paneRect.bottom &&
            clientY >= rect.top &&
            clientY <= rect.bottom,
        );
      if (!zone) return null;

      const videoCount = sequence.videoTrackIds.length;
      const trackKind: TrackKind = clipFitsTrack(clipKind, 'video') ? 'video' : 'audio';
      // Each section owns its outward edge: video tracks are created above the
      // video stack, audio tracks below the audio stack. Crossing the divider is a
      // track move, not an invitation to create the other kind in the wrong pane.
      if (
        (zone.side === 'top' && trackKind !== 'video') ||
        (zone.side === 'bottom' && trackKind !== 'audio')
      ) {
        return null;
      }
      const label = `New ${trackKind} track`;

      // Above everything: the new track goes on top of that kind's stack. For video
      // that is the end of `videoTrackIds`, since display order reverses it.
      if (zone.side === 'top') {
        return {
          where: 'above',
          trackKind,
          index: trackKind === 'video' ? videoCount : 0,
          clientY: zone.rect.bottom,
          label,
        };
      }
      return {
        where: 'below',
        trackKind,
        index: trackKind === 'video' ? 0 : sequence.audioTrackIds.length,
        clientY: zone.rect.top,
        label,
      };
    },
    [sequence.videoTrackIds.length, sequence.audioTrackIds.length],
  );

  // ---------------------------------------------------------------- dragging

  useEffect(() => {
    if (!drag) return;

    const move = (event: PointerEvent): void => {
      const clip = project.clips[drag.clipId];
      if (!clip) return;
      autoScrollPaneAt(event.clientY);

      const deltaSeconds = (event.clientX - drag.originClientX) / pxPerSecond;
      const delta = T.fromSeconds(deltaSeconds, 100_000);
      const excluded = new Set(drag.groupIds);

      if (drag.kind === 'move') {
        // Leaving the block of lanes this clip can live on means a new track rather
        // than a failed drop. The clip keeps its own lane meanwhile — the line shows
        // where it is going, and the track itself is not made until the pointer is
        // released, so a drag across the gap cannot leave a trail of empty tracks.
        const wantsNewTrack = insertionAt(event.clientY, clip.kind);
        insertionRef.current = wantsNewTrack;
        setInsertion(wantsNewTrack);

        // The lane under the pointer is the destination, so a clip can change track.
        const hovered = wantsNewTrack ? null : trackAtClientY(event.clientY);
        const destination =
          hovered && clipFitsTrack(clip.kind, getTrack(project, hovered).kind) && !getTrack(project, hovered).locked
            ? hovered
            : drag.originTrackId;

        const snapped = snap(T.max(T.TIME_ZERO, T.add(drag.originStart, delta)), excluded);
        const wanted = snapped.at;
        // Butt up against whatever is already on the destination track rather than
        // overwriting it.
        const target = clampToFreeSpace(project, destination, wanted, clip.duration, excluded);

        // The readout reports the position actually taken — after snapping and after
        // being clamped off a neighbour — not where the pointer happens to be.
        showHint(
          event,
          T.toTimecode(target, frameRate),
          formatDelta(T.sub(target, drag.originStart), frameRate),
          snapped.hit !== null && T.eq(target, snapped.at),
        );
        setSnapMark(snapped.hit !== null && T.eq(target, snapped.at) ? snapped.hit : null);

        // Recompute from the drag origin each time so the gesture is not cumulative.
        // That has to include the vertical step: reading a member's *current* track
        // would measure each move against the last one, so a drag up and back down
        // would shift it twice and then find nothing left to undo.
        const originTracks = new Map(drag.origins.map((origin) => [origin.clipId, origin.trackId]));
        const moves = drag.groupIds
          .map((id) => project.clips[id])
          .filter((c): c is Clip => c !== undefined)
          .map((c) => ({
            clipId: c.id,
            // The rest of the unit takes the same step through its own stack, so a
            // linked pair stays a pair when the picture changes lane and a
            // multi-track selection keeps its shape.
            toTrackId:
              c.id === clip.id
                ? destination
                : shiftedTrack(
                    project,
                    sequence,
                    drag.originTrackId,
                    destination,
                    originTracks.get(c.id) ?? c.trackId,
                  ),
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
      const shift = T.sub(snapped.at, anchor);

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

      // A trim is about length, so the length leads and the edge's own move follows.
      // The duration is read back from the document, since the command clamps a trim
      // to the material the source can supply and the pointer routinely asks for more.
      const trimmed = useStudio.getState().project().clips[drag.clipId];
      const duration = trimmed?.duration ?? drag.originDuration;
      showHint(
        event,
        T.formatDuration(duration, { decimals: 2 }),
        formatDelta(T.sub(duration, drag.originDuration), frameRate),
        snapped.hit !== null,
      );
      setSnapMark(snapped.hit);
    };

    const up = (): void => {
      const pending = insertionRef.current;
      if (pending) {
        // Read the document back rather than using this render's copy: the drag has
        // been moving clips through it on every pointer event.
        const state = useStudio.getState();
        const latest = state.project();
        const plan = planGapInsert(latest, sequence, drag.clipId, drag.groupIds, pending);

        if (plan) {
          const partnerIds = new Set(plan.partnerTrack ? plan.partners.map((c) => c.id) : []);
          const moves = drag.groupIds
            .map((id) => latest.clips[id])
            .filter((c): c is Clip => c !== undefined)
            .map((c) => ({
              clipId: c.id,
              // null lands on the track about to be made, and a linked partner on
              // the second one. Anything else in the unit — a group of same-kind
              // clips — stays on its own, as it does for a cross-track drag.
              toTrackId: c.id === plan.primary.id || partnerIds.has(c.id) ? null : c.trackId,
              toStart: c.start,
            }));
          // Same coalesce key as the drag, so the new tracks and the move they came
          // from collapse into the one undo step the whole gesture deserves.
          moveClipsToNewTrack(
            plan.primaryTrack.kind,
            plan.primaryTrack.index,
            moves,
            `drag:${drag.clipId}`,
            plan.partnerTrack
              ? { kind: plan.partnerTrack.kind, index: plan.partnerTrack.index, clipIds: [...partnerIds] }
              : undefined,
          );
        }
      }

      setDrag(null);
      clearGestureHints();
      endGesture();
    };

    // A drag starting while a card was pending would show it mid-gesture.
    cancelHover();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [
    drag,
    cancelHover,
    project,
    pxPerSecond,
    runMany,
    snap,
    endGesture,
    trackAtClientY,
    insertionAt,
    moveClipsToNewTrack,
    sequence,
    clearGestureHints,
    showHint,
    frameRate,
    autoScrollPaneAt,
  ]);

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
        // Where the span actually settled, since the command clamps it to the
        // handles the two clips can spare.
        const settled = useStudio.getState().project().transitions[transitionDrag.transitionId];
        showHint(
          event,
          T.formatDuration(transitionDrag.duration, { decimals: 2 }),
          settled?.offset ? `offset ${formatDelta(settled.offset, frameRate)}` : 'centred on the cut',
          false,
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
        // A roll moves the cut, so the cut's new position is the number that matters —
        // read back from the document, which clamps it to the available material.
        const first = transitionDrag.cuts[0];
        const moved = first ? useStudio.getState().project().clips[first.toId] : undefined;
        const cut = moved?.start ?? pointer;
        showHint(event, T.toTimecode(cut, frameRate), formatDelta(T.sub(cut, transitionDrag.cut), frameRate), false);
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
      showHint(
        event,
        T.formatDuration(T.fromSeconds(seconds, 1000), { decimals: 2 }),
        transitionLabel(
          useStudio.getState().project().transitions[transitionDrag.transitionId]?.transitionType ??
            'dissolve',
        ),
        false,
      );
    };

    const up = (): void => {
      setTransitionDrag(null);
      clearGestureHints();
      endGesture();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [transitionDrag, runMany, endGesture, timeAtClientX, showHint, clearGestureHints, frameRate]);

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
      origins: groupIds
        .map((id) => project.clips[id])
        .filter((c): c is Clip => c !== undefined)
        .map((c) => ({ clipId: c.id, trackId: c.trackId, start: c.start, duration: c.duration })),
    });
  };

  // ------------------------------------------------------- clip affordances

  const clipsForAffordances = (trackId: TrackId): readonly Clip[] =>
    clipsForDragOrigin(project, trackId, drag?.kind === 'move' ? drag.origins : null);

  /**
   * The fade and transition buttons along the top of a track.
   *
   * One per boundary, so every edge has exactly one meaning: an outer edge with
   * nothing butted against it offers a fade against black, and a bare cut between two
   * clips offers a transition. A cut that already carries one shows the existing badge
   * instead, which is why those are skipped here.
   *
   * Positions are computed in the lane rather than inside the clips: `.clip` is
   * `overflow: hidden`, so a button drawn in its corner would be clipped, and one
   * centred on a cut belongs to neither of the two clips it sits between.
   */
  const affordancesFor = (trackId: TrackId): readonly Affordance[] => {
    const clips = clipsForAffordances(trackId);
    const found: Affordance[] = [];

    clips.forEach((clip, index) => {
      const previous = clips[index - 1];
      const next = clips[index + 1];
      const left = T.toSeconds(clip.start) * pxPerSecond;
      const right = T.toSeconds(clipEnd(clip)) * pxPerSecond;

      // -- leading edge: a fade against black, or a cut with the clip before it
      const buttsPrevious = previous !== undefined && T.eq(clipEnd(previous), clip.start);
      if (buttsPrevious) {
        if (!transitionBetween(project, previous.id, clip.id)) {
          found.push({ key: `cut:${clip.id}`, kind: 'cut', x: left, clip, other: previous });
        }
      } else {
        found.push({
          key: `in:${clip.id}`,
          kind: 'fade-in',
          x: left + EDGE_INSET,
          clip,
          active: transitionBetween(project, null, clip.id) !== null,
        });
      }

      // -- trailing edge: only where nothing follows, since the next clip's leading
      //    edge already owns the boundary between them.
      const buttsNext = next !== undefined && T.eq(clipEnd(clip), next.start);
      if (!buttsNext) {
        found.push({
          key: `out:${clip.id}`,
          kind: 'fade-out',
          x: right - EDGE_INSET - AFFORDANCE_WIDTH,
          clip,
          active: transitionBetween(project, clip.id, null) !== null,
        });
      }
    });

    /*
     * Drop anything that would collide.
     *
     * A clip two pixels wide has the same two edges as one that fills the screen, and
     * without this its buttons would stack on top of each other and on its
     * neighbours'. Sorting first means the survivor is always the leftmost of a
     * cluster rather than whichever happened to be built first.
     */
    found.sort((a, b) => a.x - b.x);
    const spaced: Affordance[] = [];
    for (const item of found) {
      const last = spaced[spaced.length - 1];
      if (last && item.x - last.x < AFFORDANCE_WIDTH + 4) continue;
      // A fade button that has run past its own clip's far edge has no room either.
      if (item.kind !== 'cut') {
        const width = T.toSeconds(item.clip.duration) * pxPerSecond;
        if (width < AFFORDANCE_WIDTH + EDGE_INSET * 2) continue;
      }
      spaced.push(item);
    }
    return spaced;
  };

  const FADE_DURATION = T.fromSeconds(DEFAULT_TRANSITION_SECONDS, 1000);

  /**
   * Add or remove a fade against black at one end of a clip.
   *
   * A fade is a transition with nothing on the far side, which is the same mechanism
   * for picture and for sound — `audibleClipRange` reads a transition into a clip
   * whether or not it comes from another one. Going through `pairedCuts` means a
   * linked pair fades together instead of the sound cutting in under a fading image.
   */
  const toggleFade = (clip: Clip, edge: 'in' | 'out', active: boolean): void => {
    const from = edge === 'in' ? null : clip;
    const to = edge === 'in' ? clip : null;

    if (active) {
      const existing = transitionBetween(project, from?.id ?? null, to?.id ?? null);
      if (!existing) return;
      runMany(
        pairedTransitions(project, existing).map((t) => ({
          type: 'removeTransition' as const,
          transitionId: t.id,
        })),
        'Remove fade',
      );
      return;
    }
    addTransitionOnCuts(
      pairedCuts(project, from, to),
      'dissolve',
      FADE_DURATION,
      edge === 'in' ? 'Fade in from black' : 'Fade out to black',
    );
  };

  /** Offer the transition styles for a bare cut. */
  const openCutMenu = (event: React.MouseEvent, from: Clip, to: Clip): void => {
    const audioOnly = getTrack(project, to.trackId).kind === 'audio';
    menu.open(
      event,
      TRANSITION_TYPES.map((type) => ({
        label: transitionLabel(type),
        icon: <IconTransition />,
        // Sound has no edge to wipe; an audio-only transition is always a crossfade.
        disabled: audioOnly && type !== 'dissolve',
        onSelect: () =>
          addTransitionOnCuts(pairedCuts(project, from, to), type, FADE_DURATION, 'Add transition'),
      })),
    );
  };

  // ---------------------------------------------------------- context menus

  const splitAt = (at: Time, trackIds: readonly TrackId[]): void =>
    run({ type: 'splitClips', trackIds, at }, 'Split');

  const openClipMenu = (event: React.MouseEvent, clip: Clip): void => {
    const alreadySelected = selection.includes(clip.id);
    if (!alreadySelected) select([clip.id]);

    /*
     * What the delete entries act on.
     *
     * Worked out from the document rather than read back from `selection`, which is
     * this render's value and so does not yet know about the `select` above — the
     * menu's entries are built now and captured as they stand. Right-clicking a
     * linked or grouped clip that was not already selected therefore lit the whole
     * unit up and then deleted one member of it, which is the very split
     * `selectionUnit` exists to prevent. Del never had the problem, since it reads
     * the live selection, so the menu and the key disagreed on the same clip.
     */
    const targets = clipMenuTargets(project, selection, clip.id);

    // Only offer "detach" when the clip is actually tied to another one.
    const linked = clip.linkGroupId
      ? Object.values(project.clips).filter((c) => c.linkGroupId === clip.linkGroupId)
      : [];

    /*
     * Whether the selection is nothing more than one A/V link.
     *
     * Selecting either half of a linked pair selects both, so "Group" was always
     * offered on a clip that already moves as a unit — grouping it with itself. It
     * stays available the moment anything else is in the selection, because grouping
     * a linked pair *with* a third clip is a real edit.
     */
    // Says why, rather than only whether: a greyed entry with no reason is a dead
    // end, and the commonest case — the clips are already linked — is one a person
    // will otherwise keep retrying.
    const link = linkability(project, selection);

    const isOnlyOneLinkUnit =
      selection.length > 1 &&
      clip.linkGroupId !== null &&
      selection.every((id) => project.clips[id]?.linkGroupId === clip.linkGroupId);

    /*
     * The four dissolve entries that used to sit here are gone.
     *
     * They are now buttons on the clip's own edges, which is both easier to reach and
     * — more to the point — visible without opening a menu first. Two of the four
     * were also greyed out most of the time, since a dissolve needs a neighbour.
     */
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
      {
        label: linked.length > 1 ? `Detach audio from video (${linked.length} clips)` : 'Detach audio from video',
        icon: <IconUnlink />,
        disabled: linked.length < 2,
        onSelect: () => run({ type: 'unlinkClips', clipIds: [clip.id] }, 'Detach audio'),
      },
      {
        label: link.ok ? 'Link selected clips' : `Link selected clips (${link.reason})`,
        icon: <IconLink />,
        disabled: !link.ok,
        onSelect: () => run({ type: 'linkClips', clipIds: selection }, 'Link clips'),
      },
      'separator',
      {
        label: isOnlyOneLinkUnit ? 'Group (already linked)' : 'Group',
        icon: <IconGroup />,
        hint: 'Ctrl+G',
        disabled: selection.length < 2 || isOnlyOneLinkUnit,
        onSelect: () => {
          run({ type: 'groupClips', clipIds: selection }, 'Group clips');
          setStatus(`Grouped ${selection.length} clips — they now move and trim together.`);
        },
      },
      {
        label: 'Ungroup',
        icon: <IconUngroup />,
        hint: 'Ctrl+Shift+G',
        disabled: !selection.some((id) => project.clips[id]?.groupId),
        onSelect: () => {
          run({ type: 'ungroupClips', clipIds: selection }, 'Ungroup clips');
          setStatus('Ungrouped — those clips move independently again.');
        },
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
        // Counted like its neighbour: the two take the same clips and differ only in
        // whether the gap closes, so a count on one and not the other read as though
        // they also disagreed about what they would take.
        label: targets.length > 1 ? `Ripple delete ${targets.length} clips` : 'Ripple delete',
        icon: <IconRipple />,
        hint: 'Shift+Del',
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
        onSelect: () => void (async () => {
          const answer = await dialog.prompt({
            title: 'Transition duration',
            inputLabel: 'Seconds',
            initialValue: String(seconds),
            confirmLabel: 'Set duration',
          });
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
        })(),
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
        label:
          emptyTrackCount > 0
            ? `Remove ${emptyTrackCount} empty track${emptyTrackCount === 1 ? '' : 's'}`
            : 'Remove empty tracks',
        icon: <IconTrash />,
        disabled: emptyTrackCount === 0,
        onSelect: removeEmptyTracks,
      },
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

  /**
   * The pointer whose press actually began on the ruler or playhead handle.
   *
   * `event.buttons === 1` is not ownership: it is also true when a press begins on
   * some other control and merely enters the ruler later. Capture plus an explicit
   * id makes scrubbing a gesture of this surface rather than a global held-button
   * side effect.
   */
  const scrubPointer = useRef<number | null>(null);

  const scrubFromEvent = (event: React.PointerEvent): void => {
    const at = timeAtClientX(event.clientX);
    setPlayhead(at);
    // Scrubbing gets the same readout as a clip drag: the ruler's own ticks thin
    // out as you zoom out, so the nearest label can be half a minute away.
    showHint(event, T.toTimecode(at, frameRate), null, false);
  };

  const onRulerPointerDown = (event: React.PointerEvent): void => {
    if (!isPrimaryButton(event)) return;
    event.preventDefault();
    scrubPointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubFromEvent(event);
  };
  const onRulerPointerMove = (event: React.PointerEvent): void => {
    if (ownsPointerGesture(scrubPointer.current, event.pointerId)) scrubFromEvent(event);
  };
  const finishRulerScrub = (event: React.PointerEvent): void => {
    if (!ownsPointerGesture(scrubPointer.current, event.pointerId)) return;
    scrubPointer.current = null;
    clearGestureHints();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
      if (!event.ctrlKey && !event.metaKey) {
        if (event.shiftKey && event.deltaY !== 0) {
          event.preventDefault();
          el.scrollLeft += event.deltaY;
        }
        return;
      }
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
    el.style.setProperty('--timeline-scroll-x', `${Math.round(el.scrollLeft)}px`);
  }, [pxPerSecond]);

  /*
   * Publish how much room the panes' scrollbar gutters take.
   *
   * The panes reserve a stable gutter on their right edge; the guide overlay spans
   * the split, so without this a play head scrolled to the far right would be drawn
   * across that gutter. Measured rather than assumed, because the width of a
   * scrollbar is a platform and setting decision, and it is zero on overlay ones.
   */
  useEffect(() => {
    const pane = videoPaneRef.current;
    const split = lanesRef.current;
    if (!pane || !split) return;

    const measure = (): void => {
      split.style.setProperty(
        '--timeline-pane-gutter',
        `${Math.max(0, pane.offsetWidth - pane.clientWidth)}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  /*
   * Publish the horizontal scroll offset for anything positioned against the
   * viewport rather than against the content — the lane previews' canvases, and the
   * sticky column headers. The lane painters listen to the scroll event themselves;
   * this is only the CSS half.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const publish = (): void => {
      el.style.setProperty('--timeline-scroll-x', `${Math.round(el.scrollLeft)}px`);
    };
    publish();
    el.addEventListener('scroll', publish, { passive: true });
    return () => el.removeEventListener('scroll', publish);
  }, []);

  const ticks = useMemo(
    () => buildTicks(totalSeconds, pxPerSecond, sequence.frameRate),
    [totalSeconds, pxPerSecond, sequence.frameRate],
  );

  // Rounded, because the line is drawn from this and a fractional left edge makes a
  // 2px rule antialias across three columns and read as a soft grey smear.
  const playheadX = Math.round(T.toSeconds(playhead) * pxPerSecond);

  const draggedClip = drag?.kind === 'move' ? project.clips[drag.clipId] : null;
  const draggedClipTrackKind: TrackKind | null = draggedClip
    ? clipFitsTrack(draggedClip.kind, 'video')
      ? 'video'
      : 'audio'
    : null;
  const canInsertVideo =
    draggedClipTrackKind === 'video' || assetInsertionFor('top') !== null;
  const canInsertAudio =
    draggedClipTrackKind === 'audio' || assetInsertionFor('bottom') !== null;

  /** Unused pane room doubles as a generous target without moving any tracks. */
  const timelineTail = (paneKind: TrackKind): React.JSX.Element => {
    const side = paneKind === 'video' ? 'top' : 'bottom';
    const dragging = paneKind === 'video' ? canInsertVideo : canInsertAudio;
    const ghosts = side === 'top' ? insertGhosts.above : insertGhosts.below;
    const active =
      (side === 'top' && insertion?.where === 'above') ||
      (side === 'bottom' && insertion?.where === 'below') ||
      assetInsertion?.where === side;

    return (
      <div
        className={`timeline-tail ${side}${dragging ? ' insert-ready' : ''}${active ? ' insert-active' : ''}`}
        data-insert-gap={side}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (!event.ctrlKey && !event.metaKey) select([]);
        }}
        onDragOver={(event) => {
          if (!dragging || !event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDropTrackId(null);
          setAssetInsertion(assetInsertionFor(side));
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          setAssetInsertion(null);
        }}
        onDrop={(event) => {
          const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE);
          if (!assetId) return;
          event.preventDefault();
          setAssetInsertion(null);
          const target = assetInsertionFor(side);
          if (target) dropAssetOnNewTrack(assetId as never, target.trackKind, target.index);
        }}
      >
        <div className="tail-header" style={{ width: HEADER_WIDTH }} />
        <div className="timeline-tail-lane">
          {ghosts.map((ghost) => (
            <div
              key={ghost.id}
              className={`insert-ghost ${ghost.kind}`}
              style={{
                left: ghost.left,
                width: ghost.width,
                height: ghost.height,
                ...(side === 'top' ? { bottom: 0 } : { top: 0 }),
                ...ghost.appearance,
              }}
            />
          ))}
          {dragging && ghosts.length === 0 && (
            <span className="insert-tail-note">
              {active ? 'Release' : 'Drop'} to create a new {paneKind} track
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="timeline" ref={scrollRef}>
      {/*
        The outer container owns the one shared horizontal time axis. Its wide child
        creates the scrollbar; the sticky shell remains viewport-sized while each
        track pane gets its own vertical overflow.
      */}
      <div className="timeline-scroll-width" style={{ width: HEADER_WIDTH + contentWidth }}>
        <div className="timeline-shell" style={{ width: paneWidth || '100%' }}>
          <div className="timeline-topbar-viewport">
            <div className="timeline-topbar" style={{ width: HEADER_WIDTH + contentWidth }}>
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
            onPointerUp={finishRulerScrub}
            onPointerCancel={finishRulerScrub}
            onLostPointerCapture={finishRulerScrub}
            onContextMenu={openRulerMenu}
          >
            {ticks.map((tick) => (
              <div
                key={`${tick.frame ? 'f' : 't'}${tick.seconds}`}
                className={`tick${tick.major ? ' major' : ''}${tick.frame ? ' frame' : ''}`}
                style={{ left: tick.x }}
              >
                {tick.label && <span>{tick.label}</span>}
              </div>
            ))}
            {/*
              The grab handle lives inside the ruler rather than in a full-height
              overlay, so the sticky corner covers it when the timeline is scrolled
              right instead of it floating over the track headers.
            */}
            <div
              className="playhead-head"
              style={{ left: playheadX }}
              title={`Playhead ${T.toTimecode(playhead, frameRate)} — drag to scrub`}
              onPointerDown={(event) => {
                if (!isPrimaryButton(event)) return;
                event.stopPropagation();
                event.preventDefault();
                scrubPointer.current = event.pointerId;
                event.currentTarget.setPointerCapture(event.pointerId);
                showHint(event, T.toTimecode(playhead, frameRate), null, false);
              }}
              onPointerMove={(event) => {
                if (!ownsPointerGesture(scrubPointer.current, event.pointerId)) return;
                const at = timeAtClientX(event.clientX);
                setPlayhead(at);
                showHint(event, T.toTimecode(at, frameRate), null, false);
              }}
              onPointerUp={finishRulerScrub}
              onPointerCancel={finishRulerScrub}
              onLostPointerCapture={finishRulerScrub}
            />
              </div>
            </div>
          </div>

          <div
            className="timeline-split"
            ref={lanesRef}
            style={{
              gridTemplateRows: `minmax(44px, ${timelineVideoRatio}fr) ${TRACK_SECTION_DIVIDER_HEIGHT}px minmax(44px, ${1 - timelineVideoRatio}fr)`,
            }}
          >
            {(['video', 'audio'] as const).map((paneKind) => {
              const paneTrackIds = trackIds.filter(
                (trackId) => getTrack(project, trackId).kind === paneKind,
              );
              return (
              <div className={`timeline-pane-group ${paneKind}`} key={paneKind}>
                <div
                  className={`timeline-pane ${paneKind}`}
                  ref={paneKind === 'video' ? videoPaneRef : audioPaneRef}
                  onScroll={(event) =>
                    setTimelinePaneScroll(paneKind, event.currentTarget.scrollTop)
                  }
                  onDragOver={(event) => autoScrollPaneAt(event.clientY)}
                >
                  <div
                    className="timeline-pane-grid"
                    style={{ width: HEADER_WIDTH + contentWidth }}
                  >
          {paneKind === 'video' && timelineTail('video')}
          {paneTrackIds.map((trackId, rowIndex) => {
            const track = getTrack(project, trackId);
            const height = Math.max(TRACK_HEIGHT_MIN, track.height);
            // The bottom video row ends flush against the section divider, which owns
            // that seam; its resize handle stays inside the row rather than over it.
            const atPaneBoundary = paneKind === 'video' && rowIndex === paneTrackIds.length - 1;
            return (
              <div
                className={`timeline-row${atPaneBoundary ? ' at-pane-boundary' : ''}`}
                key={trackId}
                style={{ height }}
              >
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
                    if (!isPrimaryButton(event)) return;
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
                  <LanePreview
                    clips={lanePlans.get(trackId) ?? EMPTY_LANE}
                    previews={previews}
                    pxPerSecond={pxPerSecond}
                    scrollerRef={scrollRef}
                    height={height}
                  />
                  {/*
                    Where the clips were when the drag started.

                    Nothing else on screen says it: a move rewrites the document as
                    the pointer travels, so the clip *is* at the new place and there
                    is no proxy trailing behind it. Without this the only record of
                    where a nudge began is your memory of it.
                  */}
                  {drag?.kind === 'move' &&
                    drag.origins
                      .filter((origin) => origin.trackId === trackId)
                      .map((origin) => {
                        const current = project.clips[origin.clipId];
                        if (!current) return null;
                        const original = {
                          ...current,
                          trackId: origin.trackId,
                          start: origin.start,
                          duration: origin.duration,
                        };
                        return (
                          <div
                            key={origin.clipId}
                            className={`clip drag-origin ${clipKindClass(original)}`}
                            style={{
                              left: T.toSeconds(origin.start) * pxPerSecond,
                              width: Math.max(2, T.toSeconds(origin.duration) * pxPerSecond),
                              ...(original.kind === 'solid'
                                ? { background: original.fill }
                                : {}),
                            }}
                          />
                        );
                      })}
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
                          if (!isPrimaryButton(event)) return;
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
                          onPointerDown={(event) =>
                            isPrimaryButton(event) && startTransitionDrag(event, transition, 'length')
                          }
                        />
                        <div
                          className="transition-handle right"
                          onPointerDown={(event) =>
                            isPrimaryButton(event) && startTransitionDrag(event, transition, 'length')
                          }
                        />
                      </div>
                    );
                  })}
                  {trackClips(project, trackId).map((clip) => (
                    <ClipView
                      key={clip.id}
                      clip={clip}
                      relocating={relocatingIds.has(clip.id)}
                      pxPerSecond={pxPerSecond}
                      selected={selection.includes(clip.id)}
                      // The picture and sound are drawn by the lane's canvas, under
                      // the clips. A clip carries only what it owns: its border, its
                      // kind edge, its name and its badges.
                      painted={isMediaClip(clip)}
                      /*
                        Both kinds say when they are working, but only sound can say
                        how far along it is.

                        Peaks are one job over the whole file — a real denominator,
                        and seconds long on a long source, so a bar earns its place.
                        Picture is many small jobs sized to the viewport: the only
                        honest denominator is "the cells in view", which refills on
                        every scroll and would make a bar flash rather than inform.
                        So the clip shimmers until it has frames, then goes quiet.
                      */
                      loading={
                        isMediaClip(clip) &&
                        (clip.kind === 'audio'
                          ? previews?.getPeaks(clip.assetId) === undefined
                          : (previews?.thumbnails.isWarmingUp(clip.assetId) ?? false))
                      }
                      progress={
                        isMediaClip(clip) && clip.kind === 'audio'
                          ? (previews?.getPeaksProgress(clip.assetId) ?? null)
                          : null
                      }
                      missing={
                        isMediaClip(clip) && project.assets[clip.assetId]?.status.state === 'missing'
                      }
                      onSelect={(modifier) => {
                        // A clip belongs to the edited program, so interacting with
                        // one is also an unambiguous request to leave Source view.
                        showProgramPreview();
                        if (modifier === 'isolate') selectExact([clip.id]);
                        else if (modifier === 'toggle') toggleSelect(clip.id);
                        else if (modifier === 'range') selectRangeTo(clip.id);
                        else select([clip.id]);
                      }}
                      onDragStart={(event, kind, modifier) => startDrag(event, clip, kind, modifier)}
                      onContextMenu={(event) => openClipMenu(event, clip)}
                      onHoverStart={(event) => scheduleHover(event, clip)}
                      onHoverEnd={cancelHover}
                    />
                  ))}

                  {/*
                    Drawn after the clips so they sit above them, and all at one height
                    so the row reads as a strip of controls rather than decoration
                    scattered over the clips.
                  */}
                  {/*
                    Per-clip gain, in the clip's bottom-left corner.

                    Down there rather than up with the fades because it means something
                    different: the fades act on a clip's edges, this acts on the whole
                    of it. It also keeps clear of the cut button, which lands mid-clip
                    whenever a cut does. The track header has a fader for the whole
                    track; this is for the one clip that came in too hot.
                  */}
                  {!track.locked &&
                    track.kind === 'audio' &&
                    // Two rows of buttons need a lane tall enough to hold them; on a
                    // track dragged right down, this row is what gives way.
                    height >= MIN_LANE_FOR_TWO_ROWS &&
                    clipsForAffordances(trackId).map((clip) => {
                      const width = T.toSeconds(clip.duration) * pxPerSecond;
                      if (width < AFFORDANCE_WIDTH + EDGE_INSET * 2) return null;
                      return (
                        <ClipVolume
                          key={`vol:${clip.id}`}
                          clip={clip}
                          x={T.toSeconds(clip.start) * pxPerSecond + EDGE_INSET}
                        />
                      );
                    })}

                  {!track.locked &&
                    affordancesFor(trackId).map((item) =>
                      item.kind === 'cut' ? (
                        <button
                          key={item.key}
                          className="clip-affordance cut"
                          style={{ left: item.x - AFFORDANCE_WIDTH / 2 }}
                          title="Add a transition on this cut"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => openCutMenu(event, item.other!, item.clip)}
                        >
                          <IconTransition size={12} />
                        </button>
                      ) : (
                        <button
                          key={item.key}
                          className={`clip-affordance ${item.kind}${item.active ? ' on' : ''}`}
                          style={{ left: item.x }}
                          title={
                            item.active
                              ? `Remove the fade ${item.kind === 'fade-in' ? 'in' : 'out'}`
                              : `Fade ${item.kind === 'fade-in' ? 'in from' : 'out to'} black`
                          }
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() =>
                            toggleFade(
                              item.clip,
                              item.kind === 'fade-in' ? 'in' : 'out',
                              item.active ?? false,
                            )
                          }
                        >
                          <IconFade size={12} flip={item.kind === 'fade-out'} />
                        </button>
                      ),
                    )}
                </div>
                <TrackResizeHandle
                  track={track}
                  tracksOfKind={trackIds
                    .map((id) => getTrack(project, id))
                    .filter((candidate) => candidate.kind === track.kind)}
                  onSelect={() => selectTrack(trackId)}
                  onCommand={run}
                  onCommandMany={runMany}
                  onCommit={endGesture}
                />
              </div>
            );
          })}

          {paneKind === 'audio' && timelineTail('audio')}
                  </div>
                </div>
                {paneKind === 'video' && (
                  <TrackSectionDivider
                    ratio={timelineVideoRatio}
                    onChange={setTimelineVideoRatio}
                  />
                )}
              </div>
              );
            })}

            {/*
              Every full-height guide, once, over the whole split.

              These used to live inside each pane's content, which made a line that
              spans the timeline into one element per pane — and left it unable to
              cross the divider, since that is a separate opaque grid row. The
              divider grew its own third copy of the playhead to paper over the gap,
              and the snap line simply kept the gap.

              Drawing them here instead makes crossing the divider structural rather
              than something to keep in sync. Clipping the overlay at the header
              column is also what keeps a guide off the track headers: the old
              arrangement did that by stacking underneath them, which is why they had
              to sit below the clips they are meant to be read against.
            */}
            <div className="timeline-guides" style={{ left: HEADER_WIDTH }}>
              <div className="playhead-line" style={{ left: playheadX }} />
              {snapMark !== null && (
                <div
                  className="snap-line"
                  style={{ left: Math.round(T.toSeconds(snapMark) * pxPerSecond) }}
                />
              )}
            </div>
          </div>

          {marquee && <MarqueeBox marquee={marquee} />}
        </div>
      </div>

      {/*
        Both of these are placed straight from pointer coordinates, so they are fixed
        rather than absolute — inside the scrolling grid they would drift the moment
        the timeline scrolled under them.
      */}
      {insertion && (
        <div className="insert-line" style={{ top: insertion.clientY }} />
      )}
      {hint && <DragHintBox hint={hint} />}
      {/* A gesture's own readout takes precedence; two floating panels is one too many. */}
      {hoverCard && !drag && !transitionDrag && <HoverCard state={hoverCard} />}
    </div>
  );
}

// -------------------------------------------------------------------- pieces

/** Allocates vertical room between the independently scrolling video/audio stacks. */
function TrackSectionDivider({
  ratio,
  onChange,
}: {
  ratio: number;
  onChange: (ratio: number) => void;
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false);

  useEffect(
    () => () => document.body.classList.remove('resizing-track-sections'),
    [],
  );

  const setFromClientY = (element: HTMLElement, clientY: number): void => {
    const split = element.closest<HTMLElement>('.timeline-split');
    if (!split) return;
    const rect = split.getBoundingClientRect();
    const available = Math.max(1, rect.height - TRACK_SECTION_DIVIDER_HEIGHT);
    const next = (clientY - rect.top - TRACK_SECTION_DIVIDER_HEIGHT / 2) / available;
    onChange(Math.max(TIMELINE_VIDEO_RATIO_MIN, Math.min(TIMELINE_VIDEO_RATIO_MAX, next)));
  };

  const finish = (): void => {
    setDragging(false);
    document.body.classList.remove('resizing-track-sections');
  };

  return (
    <div
      className={`track-section-divider${dragging ? ' dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-label="Resize video and audio track panes"
      aria-orientation="horizontal"
      aria-valuemin={Math.round(TIMELINE_VIDEO_RATIO_MIN * 100)}
      aria-valuemax={Math.round(TIMELINE_VIDEO_RATIO_MAX * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      title="Resize video and audio panes — double-click to balance"
      onPointerDown={(event) => {
        if (!isPrimaryButton(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing-track-sections');
        setDragging(true);
        setFromClientY(event.currentTarget, event.clientY);
      }}
      onPointerMove={(event) => {
        if (!dragging || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        setFromClientY(event.currentTarget, event.clientY);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        setFromClientY(event.currentTarget, event.clientY);
        event.currentTarget.releasePointerCapture(event.pointerId);
        finish();
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onChange(0.5);
      }}
      onKeyDown={(event) => {
        let next: number | null = null;
        if (event.key === 'ArrowUp') next = ratio - 0.02;
        else if (event.key === 'ArrowDown') next = ratio + 0.02;
        else if (event.key === 'PageUp') next = ratio - 0.1;
        else if (event.key === 'PageDown') next = ratio + 0.1;
        else if (event.key === 'Home') next = TIMELINE_VIDEO_RATIO_MIN;
        else if (event.key === 'End') next = TIMELINE_VIDEO_RATIO_MAX;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        onChange(Math.max(TIMELINE_VIDEO_RATIO_MIN, Math.min(TIMELINE_VIDEO_RATIO_MAX, next)));
      }}
    />
  );
}

/** Direct manipulation for the height property that was previously Inspector-only. */
function TrackResizeHandle({
  track,
  tracksOfKind,
  onSelect,
  onCommand,
  onCommandMany,
  onCommit,
}: {
  track: Track;
  tracksOfKind: readonly Track[];
  onSelect: () => void;
  onCommand: (command: Command, label: string, coalesceKey?: string) => void;
  onCommandMany: (commands: readonly Command[], label: string, coalesceKey?: string) => void;
  onCommit: () => void;
}): React.JSX.Element {
  const drag = useRef<{
    pointerId: number;
    clientY: number;
    height: number;
    bases: readonly { trackId: TrackId; height: number }[] | null;
    lastHeights: Map<TrackId, number> | null;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(
    () => () => document.body.classList.remove('resizing-track'),
    [],
  );

  const setHeight = (height: number): void => {
    const clamped = clampTrackHeight(height);
    const bases = drag.current?.bases;
    if (bases) {
      const delta = clamped - drag.current!.height;
      const lastHeights = drag.current!.lastHeights!;
      const commands = bases
        .map((base) => ({
          type: 'setTrackProps' as const,
          trackId: base.trackId,
          props: { height: clampTrackHeight(base.height + delta) },
        }))
        .filter((command) => command.props.height !== lastHeights.get(command.trackId));
      if (commands.length === 0) return;
      for (const command of commands) lastHeights.set(command.trackId, command.props.height!);
      onCommandMany(commands, `Resize ${track.kind} tracks`, `height:${track.kind}:all`);
      return;
    }
    if (clamped === track.height) return;
    onCommand(
      { type: 'setTrackProps', trackId: track.id, props: { height: clamped } },
      'Resize track',
      `height:${track.id}`,
    );
  };

  const finish = (): void => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove('resizing-track');
    onCommit();
  };

  return (
    <div
      className={`track-resize-handle${dragging ? ' dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${track.name}`}
      aria-orientation="horizontal"
      aria-valuemin={TRACK_HEIGHT_MIN}
      aria-valuemax={TRACK_HEIGHT_MAX}
      aria-valuenow={track.height}
      title={`Resize ${track.name} — Shift-drag all ${track.kind} tracks · double-click to reset`}
      onPointerDown={(event) => {
        if (!isPrimaryButton(event)) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect();
        drag.current = {
          pointerId: event.pointerId,
          clientY: event.clientY,
          height: track.height,
          bases: event.shiftKey
            ? tracksOfKind.map((candidate) => ({
                trackId: candidate.id,
                height: candidate.height,
              }))
            : null,
          lastHeights: event.shiftKey
            ? new Map(tracksOfKind.map((candidate) => [candidate.id, candidate.height]))
            : null,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing-track');
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        setHeight(active.height + event.clientY - active.clientY);
      }}
      onPointerUp={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        setHeight(active.height + event.clientY - active.clientY);
        finish();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setHeight(DEFAULT_TRACK_HEIGHT);
        onCommit();
      }}
      onKeyDown={(event) => {
        let height: number | null = null;
        if (event.key === 'ArrowUp') height = track.height - TRACK_HEIGHT_STEP;
        else if (event.key === 'ArrowDown') height = track.height + TRACK_HEIGHT_STEP;
        else if (event.key === 'PageUp') height = track.height - TRACK_HEIGHT_STEP * 5;
        else if (event.key === 'PageDown') height = track.height + TRACK_HEIGHT_STEP * 5;
        else if (event.key === 'Home') height = TRACK_HEIGHT_MIN;
        else if (event.key === 'End') height = TRACK_HEIGHT_MAX;
        if (height === null) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect();
        setHeight(height);
        onCommit();
      }}
    />
  );
}

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

  const expanded = isExpandedTrackHeader(track.height);
  const operationalControls = track.kind === 'audio' ? (
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
        title={track.solo ? 'Unsolo' : 'Solo'}
        onClick={() => toggle({ solo: !track.solo }, 'Solo track')}
      >
        <IconSolo />
      </button>
      {expanded && <TrackVolume track={track} />}
    </>
  ) : (
    <button
      className={`icon${track.hidden ? ' on' : ''}`}
      title={track.hidden ? 'Show track' : 'Hide track'}
      onClick={() => toggle({ hidden: !track.hidden }, 'Hide track')}
    >
      {track.hidden ? <IconEyeOff /> : <IconEye />}
    </button>
  );

  return (
    <div
      className={`track-header ${expanded ? 'expanded' : 'compact'}${selected ? ' selected' : ''}`}
      style={{ width }}
      onPointerDown={(event) => {
        // Buttons and the rename field handle their own clicks.
        if ((event.target as HTMLElement).closest('button, input')) return;
        if (!isPrimaryButton(event)) return;
        onSelect();
      }}
      onContextMenu={(event) => {
        onSelect();
        menu.open(event, entries);
      }}
    >
      <div className="track-header-row identity">
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
        {!expanded && operationalControls}
        <button
          className={`icon${track.locked ? ' on' : ''}`}
          title={track.locked ? 'Unlock track' : 'Lock track'}
          onClick={() => toggle({ locked: !track.locked }, 'Lock track')}
        >
          {track.locked ? <IconLock /> : <IconUnlocked />}
        </button>
        <button
          className="icon track-menu-button"
          title="Track actions"
          aria-label={`${track.name} actions`}
          onClick={(event) => {
            onSelect();
            menu.open(event, entries);
          }}
        >
          <IconMore />
        </button>
      </div>
      {expanded && <div className="track-header-row operations">{operationalControls}</div>}
    </div>
  );
}


/** The visual family shared by clips and every drag representation of a clip. */
function clipKindClass(clip: Clip): 'audio' | 'title' | 'solid' | 'video' {
  return clip.kind === 'audio'
    ? 'audio'
    : clip.kind === 'title'
      ? 'title'
      : clip.kind === 'solid'
        ? 'solid'
        : 'video';
}

function ClipView({
  clip,
  relocating,
  pxPerSecond,
  selected,
  painted,
  loading,
  progress,
  missing,
  onSelect,
  onDragStart,
  onContextMenu,
  onHoverStart,
  onHoverEnd,
}: {
  clip: Clip;
  /** Shown inside an insertion gap instead, so the lane copy would be a duplicate. */
  relocating: boolean;
  pxPerSecond: number;
  selected: boolean;
  painted: boolean;
  /** No preview has landed yet, and none has failed — it is still being decoded. */
  loading: boolean;
  /** How far this clip's preview has got, 0-1, or null when it is not building. */
  progress: number | null;
  /** The asset's bytes could not be found when the project was reopened. */
  missing: boolean;
  onSelect: (modifier: SelectModifier) => void;
  onDragStart: (event: React.PointerEvent, kind: DragKind, modifier: SelectModifier) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onHoverStart: (event: React.PointerEvent) => void;
  onHoverEnd: () => void;
}): React.JSX.Element {
  const left = T.toSeconds(clip.start) * pxPerSecond;
  const width = Math.max(2, T.toSeconds(clip.duration) * pxPerSecond);
  const kindClass = clipKindClass(clip);
  // A fill clip shows the colour it produces, so the timeline reads at a glance.
  const fillStyle = clip.kind === 'solid' ? { background: clip.fill } : undefined;

  /*
   * No name on the clip.
   *
   * The filmstrip or waveform says what a clip is, and a label over it was covering
   * the picture to repeat something the hover card now gives in full — with the
   * position, length and source range a single line could never carry.
   *
   * The badges stay: they report state rather than identity, and a clip whose media
   * has gone missing has to say so without being pointed at first.
   */
  const showBadges = width >= 22;

  return (
    <div
      className={`clip ${kindClass}${relocating ? ' relocating' : ''}${selected ? ' selected' : ''}${clip.enabled ? '' : ' disabled'}${painted ? ' has-preview' : ''}${isGrouped(clip) ? ' grouped' : ''}${loading ? ' loading' : ''}${missing ? ' missing' : ''}`}
      style={{ left, width, ...fillStyle }}
      // No `title`: the hover card replaces it. Leaving both would show a styled card
      // and then the browser's own tooltip on top of it a moment later.
      onPointerEnter={onHoverStart}
      // Movement restarts the clock, so the delay measures a *rest* rather than the
      // time since the pointer crossed an edge. Sweeping across a clip on the way
      // somewhere else never summons anything, however long the crossing takes.
      onPointerMove={onHoverStart}
      onPointerLeave={onHoverEnd}
      onContextMenu={onContextMenu}
      onPointerDown={(event) => {
        // Right-click is the context menu's business; selecting here would collapse
        // a multi-selection before the menu could act on it.
        if (!isPrimaryButton(event)) return;
        const modifier = selectModifier(event);
        onSelect(modifier);
        onDragStart(event, 'move', modifier);
      }}
    >
      <div
        className="handle left"
        onPointerDown={(event) => {
          if (!isPrimaryButton(event)) return;
          const modifier = event.altKey ? 'isolate' : 'replace';
          onSelect(modifier);
          onDragStart(event, 'trim-in', modifier);
        }}
      />
      {showBadges && (isGrouped(clip) || missing) && (
        <div className="clip-badges">
          {isGrouped(clip) && (
            <span className="clip-badge">
              <IconGroup size={9} />
            </span>
          )}
          {missing && (
            <span className="clip-badge missing">
              <IconAlert size={9} />
            </span>
          )}
        </div>
      )}
      {progress !== null && (
        /*
          The preview being built, as a bar along the foot of the clip.

          The strip itself fills in from the left as it decodes, which says most of
          it; the bar says how much is left, and it is the only thing that does on a
          source long enough for the strip to take a while. Sticky, so it stays in
          view when the clip is wider than the lane.
        */
        <div className="clip-progress" title={`Building preview: ${Math.round(progress * 100)}%`}>
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <div
        className="handle right"
        onPointerDown={(event) => {
          if (!isPrimaryButton(event)) return;
          const modifier = event.altKey ? 'isolate' : 'replace';
          onSelect(modifier);
          onDragStart(event, 'trim-out', modifier);
        }}
      />
    </div>
  );
}

/**
 * A signed offset, for the second line of a drag readout.
 *
 * The absolute position tells you where a clip landed; the delta tells you how far
 * it travelled, which is the number you are actually holding in your head when
 * nudging something into place against a cut somewhere off screen.
 */
function formatDelta(delta: Time, frameRate: FrameRate): string {
  if (T.isZero(delta)) return '±0';
  // A true minus sign rather than a hyphen: it sits on the digit baseline in the
  // monospaced face the readout uses, where a hyphen rides high and reads as a dash.
  const sign = T.isNegative(delta) ? '−' : '+';
  return `${sign}${T.toTimecode(T.abs(delta), frameRate)}`;
}

/**
 * How long the pointer must rest before a hover card appears, in the library.
 *
 * Hovering a card there is a question — what is this file — so it should be answered
 * quickly. The native `title` tooltip this replaces waits about a second, which is
 * past the point of being useful.
 */
export const HOVER_DELAY_MS = 450;

/**
 * The same, on the timeline, where it is deliberately slower.
 *
 * Pointing at a bin card is asking; pointing at a clip is usually *working*. At the
 * library's pace an ordinary pause while lining up an edit summons a card, and it
 * appears over the very thing being edited. This is about the length of a pause that
 * means "what is this?" rather than one that means "hold on".
 */
export const TIMELINE_HOVER_DELAY_MS = 800;

export interface HoverRow {
  readonly label: string;
  readonly value: string;
}

export interface HoverCardState {
  /**
   * What the card is describing — a clip id, or an asset id.
   *
   * The card holds a snapshot of the details rather than a live reference, which is
   * what let it outlive its subject: deleting the thing under the pointer unmounts
   * it, so `pointerleave` never fires and the card sat there describing something
   * that no longer existed. Naming the subject is what lets the owner notice.
   */
  readonly subjectId: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly title: string;
  readonly subtitle: string | null;
  readonly rows: readonly HoverRow[];
}

/**
 * A detail card, shown after the pointer rests on something.
 *
 * Fixed rather than absolute, like the drag readout, so it does not drift when the
 * panel underneath it scrolls. Flipped to the left or above the pointer when it would
 * otherwise run off screen — a card that reports the details is no use half cut off.
 */
export function HoverCard({ state }: { state: HoverCardState }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const left =
      state.clientX + 16 + box.width > window.innerWidth - 8
        ? Math.max(8, state.clientX - 16 - box.width)
        : state.clientX + 16;
    const top =
      state.clientY + 14 + box.height > window.innerHeight - 8
        ? Math.max(8, state.clientY - 14 - box.height)
        : state.clientY + 14;
    setPlacement({ left, top });
  }, [state.clientX, state.clientY, state.title]);

  return (
    <div
      ref={ref}
      className="hover-card"
      style={{
        left: placement?.left ?? -9999,
        top: placement?.top ?? -9999,
        // Hidden for the first paint, before it has been measured and placed.
        visibility: placement ? 'visible' : 'hidden',
      }}
    >
      <div className="hover-title">{state.title}</div>
      {state.subtitle && <div className="hover-subtitle">{state.subtitle}</div>}
      <dl>
        {state.rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The readout that follows the pointer through a drag. */
function DragHintBox({ hint }: { hint: DragHint }): React.JSX.Element {
  return (
    <div
      className={`drag-hint${hint.snapped ? ' snapped' : ''}`}
      // Offset up and right of the pointer so the cursor never covers the digits,
      // and fixed so it does not drift if the timeline scrolls mid-gesture.
      style={{ left: hint.clientX + 14, top: hint.clientY - 34 }}
    >
      <span className="primary">{hint.primary}</span>
      {hint.secondary && <span className="secondary">{hint.secondary}</span>}
    </div>
  );
}

interface Tick {
  readonly seconds: number;
  readonly x: number;
  /** Full height and labelled; minors are short and bare. */
  readonly major: boolean;
  /** A single-frame subdivision, drawn shortest of all. */
  readonly frame?: boolean;
  readonly label?: string;
}

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
    <Fader
      className="track-volume"
      min={0}
      max={GAIN_PERCENT_MAX}
      step={1}
      value={Math.round(gainDbToPercent(db))}
      // Unity, which is where a track sits until someone moves it.
      neutral={GAIN_PERCENT_UNITY}
      neutralSnapSteps={5}
      thumb={10}
      format={formatPercent}
      title={`Track volume ${formatGain(db)} — double-click for 100%`}
      ariaLabel={`${track.name} volume`}
      onChange={(percent) =>
        run(
          {
            type: 'setTrackParam',
            trackId: track.id,
            key: 'gainDb',
            param: staticParam(percentToGainDb(percent)),
          },
          'Set track volume',
          `gain:${track.id}`,
        )
      }
      onCommit={endGesture}
      onReset={() =>
        run(
          { type: 'setTrackParam', trackId: track.id, key: 'gainDb', param: staticParam(0) },
          'Reset track volume',
        )
      }
    />
  );
}

/** Static value of a parameter, or a fallback when it is keyframed. */
function staticValue(param: Param<number>, fallback: number): number {
  return param.kind === 'static' ? param.value : fallback;
}

const CLIP_KIND_LABELS: Record<Clip['kind'], string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Still',
  title: 'Title',
  solid: 'Colour',
  nested: 'Sequence',
};

/**
 * Everything worth knowing about a clip, for its hover card.
 *
 * This is where the detail went when the name came off the narrow clips: position,
 * length and — the part no label ever carried — which part of the source is on
 * screen, which is what you actually need when matching two takes.
 */
function clipDetails(
  project: Project,
  clip: Clip,
  frameRate: FrameRate,
): { title: string; subtitle: string; rows: HoverRow[] } {
  const rows: HoverRow[] = [
    { label: 'Start', value: T.toTimecode(clip.start, frameRate) },
    { label: 'End', value: T.toTimecode(clipEnd(clip), frameRate) },
    { label: 'Duration', value: T.formatDuration(clip.duration, { decimals: 2 }) },
  ];

  const asset = isMediaClip(clip) ? project.assets[clip.assetId] : undefined;
  if (isMediaClip(clip)) {
    rows.push({ label: 'Source in', value: T.toTimecode(clip.sourceIn, frameRate) });
    // Stills have no source timeline, so an out-point would be meaningless.
    if (clip.kind !== 'image') {
      rows.push({
        label: 'Source out',
        value: T.toTimecode(T.add(clip.sourceIn, clipSourceSpan(clip)), frameRate),
      });
    }
    if (clip.speedRamp) {
      rows.push({
        label: 'Speed',
        value: `${clip.speedRamp.kind === 'keyframed' ? clip.speedRamp.keyframes.length : 1}-point ramp`,
      });
    } else if (clip.speed !== 1) rows.push({ label: 'Speed', value: `${clip.speed.toFixed(2)}×` });
  }

  if (asset?.video) {
    rows.push({
      label: 'Format',
      value: `${asset.video.size.width}×${asset.video.size.height}${
        asset.video.frameRate ? ` · ${T.fpsToNumber(asset.video.frameRate).toFixed(2)} fps` : ''
      }`,
    });
  }
  if (asset?.audio) {
    rows.push({ label: 'Audio', value: `${asset.audio.channels} ch · ${asset.audio.sampleRate / 1000} kHz` });
  }
  if (clip.kind === 'audio') {
    const db = staticValue(clip.gainDb, 0);
    rows.push({
      label: 'Gain',
      value: clip.gainDb.kind === 'static' ? formatGainPercent(db) : 'Keyframed',
    });
  }
  if (!clip.enabled) rows.push({ label: 'State', value: 'Disabled' });
  if (clip.locked) rows.push({ label: 'State', value: 'Locked' });
  if (asset?.status.state === 'missing') rows.push({ label: 'Media', value: 'Missing — re-import it' });

  const track = project.tracks[clip.trackId];
  return {
    title: clip.name,
    subtitle: `${CLIP_KIND_LABELS[clip.kind]}${track ? ` · ${track.name}` : ''}`,
    rows,
  };
}

/**
 * Gain for a single audio clip, opened from a button on the clip itself.
 *
 * A popover rather than an inline slider: a fader needs room a short clip does not
 * have, and a slider lying across the clip would compete with the drag that moves it.
 *
 * A keyframed `gainDb` is left alone. Writing a static value over an animated one
 * would silently discard the automation, so the button says so and does nothing —
 * the inspector is where an animated parameter belongs.
 */
function ClipVolume({ clip, x }: { clip: Clip; x: number }): React.JSX.Element | null {
  const run = useStudio((s) => s.run);
  const endGesture = useStudio((s) => s.endGesture);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside, true);
    return () => window.removeEventListener('pointerdown', closeOutside, true);
  }, [open]);

  if (clip.kind !== 'audio') return null;
  const animated = clip.gainDb.kind !== 'static';
  const db = staticValue(clip.gainDb, 0);

  return (
    <>
      <button
        ref={buttonRef}
        className={`clip-affordance volume${db !== 0 ? ' on' : ''}`}
        style={{ left: x }}
        title={
          animated
            ? 'Volume is keyframed — open the inspector to edit it'
            : `Clip volume ${formatGain(db)} — double-click the fader for 100%`
        }
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((current) => !current)}
      >
        <IconVolume size={12} />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="clip-volume-popover"
          // Centred on its button, but never pushed off the left of the lane — the
          // button now sits near a clip's start, and a clip can start at zero.
          style={{ left: Math.max(0, x + AFFORDANCE_WIDTH / 2 - 60) }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {animated ? (
            <span className="hint">Keyframed</span>
          ) : (
            <>
              <Fader
                className="clip-volume-fader"
                min={0}
                max={GAIN_PERCENT_MAX}
                step={1}
                value={Math.round(gainDbToPercent(db))}
                neutral={GAIN_PERCENT_UNITY}
                neutralSnapSteps={5}
                format={formatPercent}
                ariaLabel={`${clip.name} volume`}
                onChange={(percent) =>
                  run(
                    {
                      type: 'setClipParam',
                      clipId: clip.id,
                      key: 'gainDb',
                      param: staticParam(percentToGainDb(percent)),
                    },
                    'Set clip volume',
                    `clip-gain:${clip.id}`,
                  )
                }
                onCommit={endGesture}
                onReset={() =>
                  run(
                    {
                      type: 'setClipParam',
                      clipId: clip.id,
                      key: 'gainDb',
                      param: staticParam(0),
                    },
                    'Reset clip volume',
                  )
                }
              />
              <span className="gain">{formatGainPercent(db)}</span>
            </>
          )}
        </div>
      )}
    </>
  );
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

/**
 * Steps a ruler may use, in seconds.
 *
 * Each is a whole multiple of the one before wherever it matters, so the minor ticks
 * of one step land exactly on the majors of the next and the rule never shows an
 * uneven comb.
 */
const TICK_STEPS = [
  0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200,
] as const;

/** How many minor divisions sit inside one labelled interval. */
function minorDivisions(step: number): number {
  // Sexagesimal steps read naturally in sixths (10s inside a minute); the rest in
  // halves or fifths, whichever keeps the minors from crowding.
  if (step >= 60) return 6;
  if (step === 30 || step === 15) return 3;
  if (step === 0.04) return 1;
  return 5;
}

/**
 * Labelled major ticks and the unlabelled minors between them.
 *
 * A ruler is legible because its marks are not all the same: the long ones carry the
 * numbers and the short ones let you count between. Every tick used to be a
 * full-height line with a label, which is a set of columns rather than a rule.
 *
 * `minSpacing` is a floor on how close two *labels* may come. Removing it entirely
 * does not show more of the timeline, it just overlaps the digits into a smear —
 * so the ruler gets denser by adding minors, not by crowding the numbers.
 */
/**
 * The strip above and below the lanes that makes a new track when something is
 * dropped in it.
 *
 * Always there rather than opening on a drag. It costs a little height, but a target
 * that only exists once you are already dragging cannot be discovered — and a strip
 * that appears mid-gesture shifts the lanes under the pointer, which was the reason
 * to keep it out of the way in the first place.
 *
 * Clips arrive through pointer events and are handled by `insertionAt`, which keys
 * off this strip occupying the space above the first lane. Library media arrives
 * through native drag events, which do not move the pointer, so those are wired up
 * here instead.
 */
interface InsertGhost {
  readonly id: ClipId;
  readonly left: number;
  readonly width: number;
  readonly kind: string;
  readonly height: number;
  readonly appearance: React.CSSProperties;
}

function buildTicks(
  totalSeconds: number,
  pxPerSecond: number,
  frameRate: FrameRate,
  minSpacing = 76,
): readonly Tick[] {
  const frameSeconds = T.toSeconds(T.frameDuration(frameRate));
  // Zoomed far enough in, the useful subdivision is the frame itself.
  const step: number =
    TICK_STEPS.find((c) => c * pxPerSecond >= minSpacing) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const minors = minorDivisions(step);
  const minorStep = step / minors;
  // Frame ticks, but only when they would not merge into a solid bar.
  const showFrames = frameSeconds * pxPerSecond >= 6 && minorStep > frameSeconds * 1.5;

  const ticks: Tick[] = [];
  const count = Math.ceil(totalSeconds / minorStep);
  for (let i = 0; i <= count; i++) {
    const seconds = i * minorStep;
    const major = i % minors === 0;
    ticks.push({
      seconds,
      x: seconds * pxPerSecond,
      major,
      ...(major ? { label: formatTick(seconds, frameRate) } : {}),
    });
  }

  if (showFrames) {
    const frameCount = Math.ceil(totalSeconds / frameSeconds);
    for (let i = 0; i <= frameCount; i++) {
      const seconds = i * frameSeconds;
      // Skip any that a minor already covers, or the two draw on top of each other.
      if (Math.abs((seconds / minorStep) % 1) < 0.001) continue;
      ticks.push({ seconds, x: seconds * pxPerSecond, major: false, frame: true });
    }
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
