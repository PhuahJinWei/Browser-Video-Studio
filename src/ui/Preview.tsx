import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layerCorners } from '../engine/layerGeometry';
import { evalTransform } from '../model/params';
import * as T from '../model/time';
import type { ClipId, Size, Time } from '../model/types';
import { IconAudio, IconCheck, IconClose } from './Icons';
import { firstStepStates } from './firstSteps';
import { useLayout } from './layout';
import { playback, usePlayback } from './playback';
import {
  draggedParam,
  isPositionable,
  monitorScale,
  pictureRect,
  paramOrigin,
  type PositionableClip,
} from './previewDrag';
import { useContextMenu } from './ContextMenu';
import { IconCamera, IconFullscreen, IconTrash } from './Icons';
import {
  fitToFrameCommands,
  resetPositionCommands,
  resetTransformCommands,
} from './monitorActions';
import { useStudio } from './store';
import { Transport, type SourceTransport } from './Transport';
import { tip } from './tooltip';

/** The program/source monitor: picture, telemetry overlay, and transport beneath. */
/**
 * The shape of a still, as a plain number for the CSS to divide by.
 *
 * Falls back to 16:9 rather than to nothing: a missing descriptor should letterbox
 * something sensible, not collapse the box to zero and show an empty monitor.
 */
function stillAspect(asset: { image: { size: Size } | null; video: { size: Size } | null }): number {
  const size = asset.image?.size ?? asset.video?.size;
  if (!size || size.width <= 0 || size.height <= 0) return 16 / 9;
  return size.width / size.height;
}

export function Preview(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceMediaRef = useRef<HTMLMediaElement>(null);
  const attachEngine = useStudio((s) => s.attachEngine);
  const restoreLastProject = useStudio((s) => s.restoreLastProject);
  const showTelemetry = useStudio((s) => s.showTelemetry);
  const telemetry = useStudio((s) => s.telemetry);
  const exportProgress = useStudio((s) => s.exportProgress);
  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const mediaFiles = useStudio((s) => s.mediaFiles);
  const previewAssetId = useStudio((s) => s.previewAssetId);
  const sourceMarks = useStudio((s) => s.sourceMarks);
  const showProgramPreview = useStudio((s) => s.showProgramPreview);
  const selection = useStudio((s) => s.selection);
  const runMany = useStudio((s) => s.runMany);
  const endGesture = useStudio((s) => s.endGesture);
  const previews = useStudio((s) => s.previews);
  useStudio((s) => s.previewVersion);
  const monitorVolume = useLayout((s) => s.monitorVolume);
  const monitorMuted = useLayout((s) => s.monitorMuted);
  const transparencyGrid = useLayout((s) => s.transparencyGrid);
  const engine = useStudio((s) => s.engine);
  // Whether it is playing is the one part of the transport a render cares about,
  // and it changes when someone presses a button rather than sixty times a second.
  const sourcePlaying = usePlayback((state) => state.mode === 'source' && state.playing);
  /*
   * Program time, so an outline follows a scrub and a keyframed position.
   *
   * Null while a source is in the monitor, since the channel then carries that
   * clip's own time and not the edit's. Outlines are hidden in that case anyway, so
   * the fallback is only ever used to keep the arithmetic below well-defined.
   */
  const programPosition =
    usePlayback((state) => (state.mode === 'program' ? state.position : null)) ?? T.TIME_ZERO;
  const [dragging, setDragging] = useState(false);

  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;
  const sourceAsset = previewAssetId ? project.assets[previewAssetId] ?? null : null;
  const sourceFile = previewAssetId ? mediaFiles.get(previewAssetId) ?? null : null;
  const hasClips = Object.keys(project.clips).length > 0;
  const hasMedia = Object.keys(project.assets).length > 0;

  const sourceUrl = useMemo(() => (sourceFile ? URL.createObjectURL(sourceFile) : null), [sourceFile]);
  useEffect(
    () => () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    },
    [sourceUrl],
  );

  useEffect(() => {
    if (!canvasRef.current) return;
    void attachEngine(canvasRef.current).then(() => restoreLastProject());
  }, [attachEngine, restoreLastProject]);

  useEffect(() => {
    useStudio.getState().engine?.setSize(sequence.size);
  }, [sequence.size.width, sequence.size.height]);

  // Keyed on the engine as well as the flag: attaching is asynchronous, so a grid
  // switched on before the first attach would otherwise never be handed over.
  useEffect(() => {
    engine?.setTransparencyGrid(transparencyGrid);
  }, [engine, transparencyGrid]);

  useEffect(() => {
    const media = sourceMediaRef.current;
    if (media) media.currentTime = T.toSeconds(playback.get().position);
  }, [previewAssetId]);

  /*
   * Seeks made anywhere else — the keyboard, the scrub rail, the timeline — reach
   * the element through the channel.
   *
   * The tolerance is what stops a feedback loop: the element reports its own time
   * back into the channel while it plays, and reacting to that by seeking it would
   * make it stutter against itself.
   */
  useEffect(() => playback.subscribe((state) => {
    const media = sourceMediaRef.current;
    if (!media || state.mode !== 'source') return;
    const wanted = T.toSeconds(state.position);
    if (Math.abs(media.currentTime - wanted) > 0.08) media.currentTime = wanted;
  }), []);

  useEffect(() => {
    const media = sourceMediaRef.current;
    if (!media) return;
    media.volume = monitorVolume;
    media.muted = monitorMuted;
  }, [monitorVolume, monitorMuted, sourceUrl]);

  // Native `timeupdate` is intentionally sparse. Sample the media clock while it is
  // playing so the shared scrubber remains fluid, just like the program monitor.
  useEffect(() => {
    if (!sourcePlaying) return;
    let frame = 0;
    const update = (): void => {
      const media = sourceMediaRef.current;
      if (media) {
        const outPoint = sourceAsset ? sourceMarks.get(sourceAsset.id)?.outPoint ?? null : null;
        if (outPoint && media.currentTime >= T.toSeconds(outPoint)) {
          media.currentTime = T.toSeconds(outPoint);
          media.pause();
          playback.set({ position: outPoint, playing: false });
          return;
        }
        playback.set({ position: T.fromSeconds(media.currentTime, 1_000_000) });
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [sourcePlaying, sourceAsset, sourceMarks]);

  useEffect(() => {
    const toggle = (): void => {
      const media = sourceMediaRef.current;
      if (!media) return;
      if (media.paused) void media.play();
      else media.pause();
    };
    window.addEventListener('bvs:toggle-source-preview', toggle);
    return () => window.removeEventListener('bvs:toggle-source-preview', toggle);
  }, []);

  const sourceDuration = sourceAsset?.video?.duration ?? sourceAsset?.audio?.duration ?? T.TIME_ZERO;
  const seekSource = (at: T.Time): void => {
    const clamped = T.clamp(at, T.TIME_ZERO, sourceDuration);
    playback.set({ position: clamped });
    if (sourceMediaRef.current) sourceMediaRef.current.currentTime = T.toSeconds(clamped);
  };
  const toggleSourcePlay = (): void => {
    const media = sourceMediaRef.current;
    if (!media) return;
    if (media.paused) void media.play();
    else media.pause();
  };
  const sourceTransport: SourceTransport | null = sourceAsset
    ? {
        duration: sourceDuration,
        frameRate: sourceAsset.video?.frameRate ?? null,
        playable: sourceAsset.kind !== 'image' && sourceUrl !== null,
        hasPicture: sourceAsset.video !== null,
        seek: seekSource,
        togglePlay: toggleSourcePlay,
        marks: sourceMarks.get(sourceAsset.id) ?? { inPoint: null, outPoint: null },
      }
    : null;

  const mediaEvents = {
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      event.currentTarget.volume = monitorVolume;
      event.currentTarget.muted = monitorMuted;
      event.currentTarget.currentTime = T.toSeconds(playback.get().position);
    },
    onTimeUpdate: (event: React.SyntheticEvent<HTMLMediaElement>) =>
      playback.set({ position: T.fromSeconds(event.currentTarget.currentTime, 1_000_000) }),
    onPlay: () => playback.set({ playing: true }),
    onPause: () => playback.set({ playing: false }),
    onEnded: () => playback.set({ playing: false }),
  };

  /*
   * Dragging a clip about in the monitor.
   *
   * Position was reachable only as two numbers in the inspector, which is a poor way
   * to say "a bit left of that" — and alignment had been standing in for it, which is
   * why it had to stop. Every editor lets you take hold of the picture itself.
   *
   * Anywhere in the frame grabs it, rather than only the clip's own bounds. There is
   * no geometry here to hit-test against, and the gesture is unambiguous without one:
   * it moves the selection, and it does nothing at all when nothing movable is
   * selected.
   */
  const drag = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    scale: number;
    at: Time;
    origins: readonly { clipId: ClipId; x: number; y: number }[];
  } | null>(null);

  /** The selected clips that can be moved, and where each stands right now. */
  const positionable = useMemo((): readonly PositionableClip[] => {
    return selection
      .map((id) => project.clips[id])
      .filter((clip): clip is PositionableClip => clip !== undefined && isPositionable(clip));
  }, [selection, project]);

  const startPositionDrag = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      if (event.button !== 0 || positionable.length === 0) return;
      // The element's box includes the letterbox bars; the picture inside it is what
      // a screen pixel has to be measured against.
      const picture = pictureRect(sequence.size, event.currentTarget.getBoundingClientRect());
      const scale = monitorScale(sequence.size.width, picture.width);
      const playheadNow = useStudio.getState().playhead();

      drag.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        scale,
        // Params are timed from the clip's own start, not the sequence's.
        at: playheadNow,
        origins: positionable.map((clip) => ({
          clipId: clip.id,
          x: paramOrigin(clip.transform.x, T.sub(playheadNow, clip.start)),
          y: paramOrigin(clip.transform.y, T.sub(playheadNow, clip.start)),
        })),
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    },
    [positionable, sequence.size],
  );

  const movePositionDrag = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): void => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;

      const dx = (event.clientX - active.clientX) * active.scale;
      const dy = (event.clientY - active.clientY) * active.scale;
      const latest = useStudio.getState().project();

      const commands = active.origins.flatMap((origin) => {
        const clip = latest.clips[origin.clipId];
        if (!clip || !isPositionable(clip)) return [];
        const at = T.sub(active.at, clip.start);
        return [
          {
            type: 'setClipParam' as const,
            clipId: origin.clipId,
            key: 'transform.x' as const,
            param: draggedParam(clip.transform.x, at, Math.round(origin.x + dx)),
          },
          {
            type: 'setClipParam' as const,
            clipId: origin.clipId,
            key: 'transform.y' as const,
            param: draggedParam(clip.transform.y, at, Math.round(origin.y + dy)),
          },
        ];
      });
      if (commands.length === 0) return;

      // One coalesce key for the gesture, so the whole drag is a single undo step.
      runMany(commands, 'Move in frame', `frame:${active.origins[0]!.clipId}`);
    },
    [runMany],
  );

  const endPositionDrag = useCallback((): void => {
    setDragging(false);
    if (!drag.current) return;
    drag.current = null;
    endGesture();
  }, [endGesture]);

  /*
   * What the monitor can do to what is in it.
   *
   * It became a surface you manipulate the moment a clip could be dragged in it, and
   * a surface you can put something wrong on needs a way to put it back. Undo covers
   * a mistake; these cover a decision — a clip nudged over five separate drags takes
   * five undos to centre, and none to reset.
   */
  const menu = useContextMenu();
  const captureFrame = useStudio((s) => s.captureFrame);

  const openMonitorMenu = useCallback(
    (event: React.MouseEvent): void => {
      const clipIds = positionable.map((clip) => clip.id);
      const none = clipIds.length === 0;

      // Only media has a size of its own to be fitted; a title or a colour is drawn
      // at the frame's size already, so there is nothing for it to meet.
      const fittable = positionable.flatMap((clip) => {
        if (clip.kind !== 'video' && clip.kind !== 'image') return [];
        const asset = project.assets[clip.assetId];
        const size = asset?.video?.size ?? asset?.image?.size ?? null;
        return size ? [{ clipId: clip.id, size }] : [];
      });

      menu.open(event, [
        {
          label: 'Reset position',
          disabled: none,
          onSelect: () => {
            runMany(resetPositionCommands(clipIds), 'Reset position');
            endGesture();
          },
        },
        {
          label: 'Fit to frame',
          icon: <IconFullscreen />,
          disabled: fittable.length === 0,
          onSelect: () => {
            runMany(
              fittable.flatMap((entry) => fitToFrameCommands(entry.clipId, entry.size, sequence.size)),
              'Fit to frame',
            );
            endGesture();
          },
        },
        {
          label: 'Reset all transform',
          icon: <IconTrash />,
          disabled: none,
          onSelect: () => {
            runMany(resetTransformCommands(clipIds), 'Reset transform');
            endGesture();
          },
        },
        'separator',
        {
          label: 'Capture frame to library',
          icon: <IconCamera />,
          onSelect: () => void captureFrame(),
        },
      ]);
    },
    [menu, positionable, project.assets, sequence.size, runMany, endGesture, captureFrame],
  );
  // The source monitor's scrub rail uses the same one-per-asset picture the bin does.
  /*
   * Outlines for whatever can be dragged in the monitor.
   *
   * Drawn in frame pixels and left to the SVG to scale, which is why nothing here
   * measures the panel. The transform is read live from the document rather than
   * from the engine so the outline moves with the pointer instead of trailing a
   * rendered frame behind it; the picture's size comes from the engine, because only
   * the render knows how big a decoded frame or a rasterised title actually was.
   */
  const outlines = useMemo(() => {
    const bounds = engine?.lastLayerBounds();
    if (!bounds || positionable.length === 0) return [];
    return positionable.flatMap((clip) => {
      const measured = bounds.get(clip.id);
      // A clip not under the play head was never drawn, so there is nothing to point
      // at — the same as every editor, which shows a box only for what is on screen.
      if (!measured) return [];
      const transform = evalTransform(clip.transform, T.sub(programPosition, clip.start));
      const corners = layerCorners(
        transform,
        sequence.size,
        measured.imageSize,
        measured.contentRect,
      );

      return [{
        clipId: clip.id,
        points: corners.map((corner) => `${corner.x.toFixed(1)},${corner.y.toFixed(1)}`).join(' '),
        x: Math.round(transform.x),
        y: Math.round(transform.y),
      }];
    });
  }, [engine, positionable, programPosition, sequence.size, project]);

  const wave = sourceAsset ? previews?.getPosterUrl(sourceAsset.id) : null;

  return (
    <div className="preview-panel">
      <div
        className={`preview${sourceAsset ? ' source-open' : ''}`}
        style={
          {
            '--frame-aspect': sequence.size.width / sequence.size.height,
          } as React.CSSProperties
        }
      >
        <canvas
          ref={canvasRef}
          className={positionable.length > 0 ? "draggable" : undefined}
          width={sequence.size.width}
          height={sequence.size.height}
          onPointerDown={startPositionDrag}
          onPointerMove={movePositionDrag}
          onPointerUp={endPositionDrag}
          onPointerCancel={endPositionDrag}
          onLostPointerCapture={endPositionDrag}
          onContextMenu={openMonitorMenu}
        />

        {/*
          Sized to the picture rather than to the panel, so frame coordinates can be
          used directly and a box that runs off the frame runs into the letterbox
          instead of being clipped at the frame's edge — which is the whole point.
        */}
        {outlines.length > 0 && !sourceAsset && (
          <svg
            className="monitor-outline"
            viewBox={`0 0 ${sequence.size.width} ${sequence.size.height}`}
            aria-hidden="true"
          >
            {outlines.map((outline) => (
              <polygon key={outline.clipId} points={outline.points} vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
        )}

        {dragging && outlines[0] && (
          <p className="monitor-readout">
            X {outlines[0].x}  Y {outlines[0].y}
          </p>
        )}

        {sourceAsset && (
          <div className="source-monitor">
            {sourceAsset.kind === 'image' && sourceUrl ? (
              <div
                className="source-still checkered"
                style={
                  {
                    '--still-aspect': stillAspect(sourceAsset),
                  } as React.CSSProperties
                }
              >
                <img src={sourceUrl} alt={sourceAsset.name} />
              </div>
            ) : sourceAsset.video && sourceUrl ? (
              <video
                key={sourceAsset.id}
                ref={(element) => {
                  sourceMediaRef.current = element;
                }}
                className="source-media"
                src={sourceUrl}
                playsInline
                {...mediaEvents}
              />
            ) : sourceAsset.audio && sourceUrl ? (
              <>
                <audio
                  key={sourceAsset.id}
                  ref={(element) => {
                    sourceMediaRef.current = element;
                  }}
                  src={sourceUrl}
                  {...mediaEvents}
                />
                <div
                  className="source-audio"
                  style={wave ? { backgroundImage: `url(${wave})` } : undefined}
                >
                  <IconAudio size={38} />
                  <span>{sourceAsset.name}</span>
                </div>
              </>
            ) : (
              <div className="source-unavailable">This source media is not available.</div>
            )}

            <div className="source-monitor-label">
              <span className="source-badge">Source</span>
              <span className="source-name">{sourceAsset.name}</span>
              <button className="icon" {...tip('Return to program preview')} onClick={showProgramPreview}>
                <IconClose />
              </button>
            </div>
          </div>
        )}

        {/*
          The whole job in three lines, in the largest empty space the window has.
          Both the library and the status bar already say "import media"; what was
          missing was what comes after it, and where the person is in the sequence.
        */}
        {!sourceAsset && !hasClips && (
          <div className="empty">
            <ol className="first-steps">
              {firstStepStates({ hasMedia, hasClips }).map(({ step, state }, index) => (
                <li key={step.key} className={`first-step ${state}`}>
                  <span className="first-step-mark" aria-hidden="true">
                    {state === 'done' ? <IconCheck size={13} /> : index + 1}
                  </span>
                  <span className="first-step-copy">
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                  </span>
                  {/* Screen readers get the state as words; sighted users get the tick. */}
                  <span className="sr-only">
                    {state === 'done' ? ' — done' : state === 'now' ? ' — do this next' : ''}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {!sourceAsset && showTelemetry && (
          <TelemetryPanel telemetry={telemetry} exportProgress={exportProgress} />
        )}
      </div>
      <Transport source={sourceTransport} />
    </div>
  );
}

type TelemetryProps = {
  telemetry: ReturnType<typeof useStudio.getState>['telemetry'];
  exportProgress: ReturnType<typeof useStudio.getState>['exportProgress'];
};

function TelemetryPanel({ telemetry, exportProgress }: TelemetryProps): React.JSX.Element | null {
  if (exportProgress) {
    const { stage, overall, framesEncoded, totalFrames, fps, audioDone, elapsedMs } = exportProgress;
    return (
      <div className="telemetry">
        <h4>Exporting</h4>
        <Bar label="Audio mix" value={audioDone ? 1 : stage === 'audio' ? 0.5 : 0} />
        <Bar label="Decode + composite + encode" value={totalFrames ? framesEncoded / totalFrames : 0} />
        <Bar label="Mux" value={stage === 'finalising' || stage === 'done' ? 1 : 0} />
        <div className="row"><span>Frames</span><span>{framesEncoded} / {totalFrames}</span></div>
        <div className="row"><span>Encode rate</span><span>{fps.toFixed(1)} fps</span></div>
        <div className="row"><span>Elapsed</span><span>{(elapsedMs / 1000).toFixed(1)} s</span></div>
        <div className="row"><span>Overall</span><span>{Math.round(overall * 100)}%</span></div>
      </div>
    );
  }

  if (!telemetry) return null;
  return (
    <div className="telemetry">
      <h4>Pipeline</h4>
      <div className="row"><span>State</span><span>{telemetry.playing ? 'playing' : 'idle'}</span></div>
      <div className="row"><span>Preview fps</span><span>{telemetry.fps}</span></div>
      <div className="row"><span>Decode</span><span>{telemetry.decodeMs.toFixed(1)} ms</span></div>
      <div className="row"><span>Composite</span><span>{telemetry.compositeMs.toFixed(1)} ms</span></div>
      <div className="row"><span>Layers</span><span>{telemetry.layerCount}</span></div>
      <div className="row"><span>Coalesced</span><span>{telemetry.droppedFrames}</span></div>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <>
      <div className="row"><span>{label}</span><span>{Math.round(Math.max(0, Math.min(1, value)) * 100)}%</span></div>
      <div className="bar"><div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>
    </>
  );
}
