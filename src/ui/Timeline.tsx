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
import { clipEnd, getTrack, isMediaClip, trackClips } from '../model/selectors';
import * as T from '../model/time';
import type { Clip, ClipId, Time, Track, TrackId } from '../model/types';
import { orderedTrackIds, useStudio } from './store';

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
  const toggleSelect = useStudio((s) => s.toggleSelect);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const setZoom = useStudio((s) => s.setZoom);
  const duration = useStudio((s) => s.duration);
  const previews = useStudio((s) => s.previews);
  // Previews arrive asynchronously; this re-renders the lanes when one lands.
  useStudio((s) => s.previewVersion);

  const pxPerSecond = sequence.view.zoom;
  const playhead = sequence.view.playhead;
  const trackIds = useMemo(() => orderedTrackIds(project, sequenceId), [project, sequenceId]);

  const totalSeconds = Math.max(T.toSeconds(duration()) + MIN_TAIL_SECONDS, MIN_TAIL_SECONDS);
  const contentWidth = Math.ceil(totalSeconds * pxPerSecond);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

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
        const target = snap(T.max(T.TIME_ZERO, T.add(drag.originStart, delta)), excluded);
        const shift = T.sub(target, drag.originStart);
        const moves = drag.groupIds
          .map((id) => project.clips[id])
          .filter((c): c is Clip => c !== undefined)
          .map((c) => ({
            clipId: c.id,
            toTrackId: c.trackId,
            toStart: T.max(T.TIME_ZERO, T.add(c.start, shift)),
          }));
        // Recompute from the drag origin each time so the gesture is not cumulative.
        const originMoves = moves.map((m) => {
          const c = project.clips[m.clipId]!;
          const offset = T.sub(c.start, clip.start);
          return { ...m, toStart: T.max(T.TIME_ZERO, T.add(target, offset)) };
        });
        runMany([{ type: 'moveClips', moves: originMoves }], 'Move clip', `drag:${drag.clipId}`);
        return;
      }

      if (drag.kind === 'trim-in') {
        const to = snap(T.add(drag.originStart, delta), excluded);
        const commands: Command[] = drag.groupIds.map((id) => ({
          type: 'trimClip',
          clipId: id,
          edge: 'in',
          to,
        }));
        runMany(commands, 'Trim clip', `trim-in:${drag.clipId}`);
        return;
      }

      const originalEnd = T.add(drag.originStart, drag.originDuration);
      const to = snap(T.add(originalEnd, delta), excluded);
      const commands: Command[] = drag.groupIds.map((id) => ({
        type: 'trimClip',
        clipId: id,
        edge: 'out',
        to,
      }));
      runMany(commands, 'Trim clip', `trim-out:${drag.clipId}`);
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
  }, [drag, project, pxPerSecond, runMany, snap, endGesture]);

  const startDrag = (event: React.PointerEvent, clip: Clip, kind: DragKind): void => {
    event.stopPropagation();
    event.preventDefault();
    const track = getTrack(project, clip.trackId);
    if (track.locked || clip.locked) return;

    if (!selection.includes(clip.id)) select([clip.id]);

    // Linked clips (a video and its own audio) move and trim together.
    const groupIds = clip.linkGroupId
      ? Object.values(project.clips)
          .filter((c) => c.linkGroupId === clip.linkGroupId)
          .map((c) => c.id)
      : [clip.id];

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
            + V
          </button>
          <button
            className="icon"
            title="Add an audio track"
            onClick={() => run({ type: 'addTrack', sequenceId, kind: 'audio' }, 'Add audio track')}
          >
            + A
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
          >
            {ticks.map((tick) => (
              <div key={tick.seconds} className="tick" style={{ left: tick.x }}>
                {tick.label}
              </div>
            ))}
          </div>

          {trackIds.map((trackId) => {
            const track = getTrack(project, trackId);
            return (
              <div
                key={trackId}
                className={`track-lane${track.locked ? ' locked' : ''}`}
                style={{ height: TRACK_HEIGHT }}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) select([]);
                }}
              >
                {trackClips(project, trackId).map((clip) => (
                  <ClipView
                    key={clip.id}
                    clip={clip}
                    pxPerSecond={pxPerSecond}
                    selected={selection.includes(clip.id)}
                    preview={previewStyle(clip, pxPerSecond, previews)}
                    onSelect={(additive) =>
                      additive ? toggleSelect(clip.id) : select([clip.id])
                    }
                    onDragStart={(event, kind) => startDrag(event, clip, kind)}
                  />
                ))}
              </div>
            );
          })}

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
  const toggle = (props: Record<string, boolean>, label: string): void =>
    onCommand({ type: 'setTrackProps', trackId: track.id, props }, label);

  return (
    <div className="track-header" style={{ height: TRACK_HEIGHT }}>
      <span className="label" title={track.name}>
        {track.name}
      </span>
      {track.kind === 'audio' ? (
        <>
          <button
            className={`icon${track.muted ? ' on' : ''}`}
            title="Mute"
            onClick={() => toggle({ muted: !track.muted }, 'Mute track')}
          >
            M
          </button>
          <button
            className={`icon${track.solo ? ' on' : ''}`}
            title="Solo"
            onClick={() => toggle({ solo: !track.solo }, 'Solo track')}
          >
            S
          </button>
        </>
      ) : (
        <button
          className={`icon${track.hidden ? ' on' : ''}`}
          title="Hide"
          onClick={() => toggle({ hidden: !track.hidden }, 'Hide track')}
        >
          {track.hidden ? '–' : 'V'}
        </button>
      )}
      <button
        className={`icon${track.locked ? ' on' : ''}`}
        title="Lock"
        onClick={() => toggle({ locked: !track.locked }, 'Lock track')}
      >
        L
      </button>
      {removable && (
        <button
          className="icon"
          title="Delete this track and its clips"
          onClick={() => onCommand({ type: 'removeTrack', trackId: track.id }, 'Remove track')}
        >
          ×
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
}: {
  clip: Clip;
  pxPerSecond: number;
  selected: boolean;
  preview: React.CSSProperties | undefined;
  onSelect: (additive: boolean) => void;
  onDragStart: (event: React.PointerEvent, kind: DragKind) => void;
}): React.JSX.Element {
  const left = T.toSeconds(clip.start) * pxPerSecond;
  const width = Math.max(2, T.toSeconds(clip.duration) * pxPerSecond);
  const kindClass = clip.kind === 'audio' ? 'audio' : clip.kind === 'title' ? 'title' : 'video';

  return (
    <div
      className={`clip ${kindClass}${selected ? ' selected' : ''}${clip.enabled ? '' : ' disabled'}${preview ? ' has-preview' : ''}`}
      style={{ left, width, ...preview }}
      title={`${clip.name} · ${T.formatDuration(clip.duration, { decimals: 2 })}`}
      onPointerDown={(event) => {
        onSelect(event.shiftKey || event.metaKey || event.ctrlKey);
        onDragStart(event, 'move');
      }}
    >
      <div
        className="handle left"
        onPointerDown={(event) => {
          onSelect(false);
          onDragStart(event, 'trim-in');
        }}
      />
      <div className="clip-name">{clip.name}</div>
      <div
        className="handle right"
        onPointerDown={(event) => {
          onSelect(false);
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

