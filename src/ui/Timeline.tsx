/**
 * Timeline.
 *
 * Clip geometry comes straight from the document — there is no parallel UI model to
 * fall out of sync. Drags mutate the document through coalesced commands, so a whole
 * gesture collapses into one undo step (see `endGesture`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '../model/commands';
import type { PreviewCache } from '../engine/previews';
import {
  clipEnd,
  clipFitsTrack,
  getTrack,
  isGrouped,
  isMediaClip,
  selectionUnit,
  trackClips,
} from '../model/selectors';
import * as T from '../model/time';
import type { Clip, ClipId, Project, Time, Track, TrackId } from '../model/types';
import { useContextMenu, type MenuEntry } from './ContextMenu';
import {
  IconAudio,
  IconLink,
  IconMarker,
  IconNextEdit,
  IconPlus,
  IconSkipStart,
  IconClose,
  IconEye,
  IconGroup,
  IconUngroup,
  IconEyeOff,
  IconLock,
  IconMuted,
  IconRipple,
  IconSolo,
  IconSplit,
  IconTrash,
  IconUnlink,
  IconUnlocked,
  IconVideo,
  IconVolume,
} from './Icons';
import { appendPointFor, counterpartTrackId, orderedTrackIds, useStudio } from './store';

const TRACK_HEIGHT = 56;
const MIN_TAIL_SECONDS = 10;
const SNAP_PIXELS = 8;

type DragKind = 'move' | 'trim-in' | 'trim-out';

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

  const pxPerSecond = sequence.view.zoom;
  const playhead = sequence.view.playhead;
  const trackIds = useMemo(() => orderedTrackIds(project, sequenceId), [project, sequenceId]);

  const totalSeconds = Math.max(T.toSeconds(duration()) + MIN_TAIL_SECONDS, MIN_TAIL_SECONDS);
  const contentWidth = Math.ceil(totalSeconds * pxPerSecond);

  const scrollRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTrackId, setDropTrackId] = useState<TrackId | null>(null);

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

  const timeAtClientX = useCallback(
    (clientX: number): Time => {
      const el = scrollRef.current;
      if (!el) return T.TIME_ZERO;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left + el.scrollLeft;
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

  const startDrag = (event: React.PointerEvent, clip: Clip, kind: DragKind): void => {
    event.stopPropagation();
    event.preventDefault();
    const track = getTrack(project, clip.trackId);
    if (track.locked || clip.locked) return;

    // Alt isolates a single clip out of its unit, for the times you need to nudge
    // just the audio without detaching it permanently.
    const isolate = event.altKey;
    const groupIds = isolate ? [clip.id] : selectionUnit(project, clip.id);
    if (isolate) selectExact([clip.id]);
    else if (!selection.includes(clip.id)) select([clip.id]);

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

    const entries: MenuEntry[] = [
      {
        label: 'Split at playhead',
        icon: <IconSplit />,
        hint: 'S',
        // Splitting only does something when the playhead is inside the clip.
        disabled: !(T.lt(clip.start, playhead) && T.gt(clipEnd(clip), playhead)),
        onSelect: () => splitAt(playhead, [clip.trackId]),
      },
      {
        label: 'Split all tracks at playhead',
        icon: <IconSplit />,
        onSelect: () => splitAt(playhead, trackIds),
      },
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

  const onWheel = (event: React.WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(pxPerSecond * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  const ticks = useMemo(() => buildTicks(totalSeconds, pxPerSecond), [totalSeconds, pxPerSecond]);

  return (
    <div className="timeline" onWheel={onWheel}>
      <div className="track-headers">
        <div className="ruler-spacer" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px' }}>
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
        {trackIds.map((trackId) => (
          <TrackHeader
            key={trackId}
            track={getTrack(project, trackId)}
            onCommand={run}
            removable={trackIds.length > 1}
          />
        ))}
      </div>

      <div className="timeline-scroll" ref={scrollRef}>
        <div className="timeline-inner" style={{ width: contentWidth }}>
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

          <div ref={lanesRef}>
          {trackIds.map((trackId) => {
            const track = getTrack(project, trackId);
            return (
              <div
                key={trackId}
                data-track-id={trackId}
                className={`track-lane${track.locked ? ' locked' : ''}${
                  dropGhosts?.trackIds.includes(trackId) ? ' drop-active' : ''
                }`}
                style={{ height: TRACK_HEIGHT }}
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
                  if (event.target === event.currentTarget) select([]);
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
                {trackClips(project, trackId).map((clip) => (
                  <ClipView
                    key={clip.id}
                    clip={clip}
                    pxPerSecond={pxPerSecond}
                    selected={selection.includes(clip.id)}
                    preview={previewStyle(clip, pxPerSecond, previews)}
                    onSelect={(additive, isolate) => {
                      if (isolate) selectExact([clip.id]);
                      else if (additive) toggleSelect(clip.id);
                      else select([clip.id]);
                    }}
                    onDragStart={(event, kind) => startDrag(event, clip, kind)}
                    onContextMenu={(event) => openClipMenu(event, clip)}
                  />
                ))}
              </div>
            );
          })}
          </div>

          <div
            className="playhead"
            style={{ left: T.toSeconds(playhead) * pxPerSecond, height: '100%' }}
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
}: {
  track: Track;
  onCommand: (command: Command, label: string) => void;
  removable: boolean;
}): React.JSX.Element {
  const menu = useContextMenu();
  const toggle = (props: Record<string, boolean>, label: string): void =>
    onCommand({ type: 'setTrackProps', trackId: track.id, props }, label);

  const remove = (): void =>
    onCommand({ type: 'removeTrack', trackId: track.id }, 'Remove track');

  const entries: MenuEntry[] = [
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
      className="track-header"
      style={{ height: TRACK_HEIGHT }}
      onContextMenu={(event) => menu.open(event, entries)}
    >
      <span className="track-kind">
        {track.kind === 'audio' ? <IconAudio size={12} /> : <IconVideo size={12} />}
      </span>
      <span className="label" title={track.name}>
        {track.name}
      </span>
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
  onSelect: (additive: boolean, isolate: boolean) => void;
  onDragStart: (event: React.PointerEvent, kind: DragKind) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}): React.JSX.Element {
  const left = T.toSeconds(clip.start) * pxPerSecond;
  const width = Math.max(2, T.toSeconds(clip.duration) * pxPerSecond);
  const kindClass = clip.kind === 'audio' ? 'audio' : clip.kind === 'title' ? 'title' : 'video';

  return (
    <div
      className={`clip ${kindClass}${selected ? ' selected' : ''}${clip.enabled ? '' : ' disabled'}${preview ? ' has-preview' : ''}${isGrouped(clip) ? ' grouped' : ''}`}
      style={{ left, width, ...preview }}
      title={`${clip.name} · ${T.formatDuration(clip.duration, { decimals: 2 })}`}
      onContextMenu={onContextMenu}
      onPointerDown={(event) => {
        onSelect(event.shiftKey || event.metaKey || event.ctrlKey, event.altKey);
        onDragStart(event, 'move');
      }}
    >
      <div
        className="handle left"
        onPointerDown={(event) => {
          onSelect(false, event.altKey);
          onDragStart(event, 'trim-in');
        }}
      />
      <div className="clip-name">{clip.name}</div>
      <div
        className="handle right"
        onPointerDown={(event) => {
          onSelect(false, event.altKey);
          onDragStart(event, 'trim-out');
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
function buildTicks(totalSeconds: number, pxPerSecond: number): readonly Tick[] {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const step = candidates.find((c) => c * pxPerSecond >= 80) ?? 3600;

  const ticks: Tick[] = [];
  for (let seconds = 0; seconds <= totalSeconds; seconds += step) {
    ticks.push({
      seconds,
      x: seconds * pxPerSecond,
      label: formatTick(seconds, step),
    });
  }
  return ticks;
}

function formatTick(seconds: number, step: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  const decimals = step < 1 ? 1 : 0;
  return `${minutes}:${remainder.toFixed(decimals).padStart(decimals > 0 ? 4 : 2, '0')}`;
}

