import { useEffect, useMemo, useRef } from 'react';
import * as T from '../model/time';
import { IconAudio, IconClose } from './Icons';
import { useLayout } from './layout';
import { playback, usePlayback } from './playback';
import { useStudio } from './store';
import { Transport, type SourceTransport } from './Transport';

/** The program/source monitor: picture, telemetry overlay, and transport beneath. */
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
  const previews = useStudio((s) => s.previews);
  useStudio((s) => s.previewVersion);
  const monitorVolume = useLayout((s) => s.monitorVolume);
  const monitorMuted = useLayout((s) => s.monitorMuted);
  // Whether it is playing is the one part of the transport a render cares about,
  // and it changes when someone presses a button rather than sixty times a second.
  const sourcePlaying = usePlayback((state) => state.mode === 'source' && state.playing);

  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;
  const sourceAsset = previewAssetId ? project.assets[previewAssetId] ?? null : null;
  const sourceFile = previewAssetId ? mediaFiles.get(previewAssetId) ?? null : null;
  const hasClips = Object.keys(project.clips).length > 0;

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

  // The source monitor's scrub rail uses the same one-per-asset picture the bin does.
  const wave = sourceAsset ? previews?.getPosterUrl(sourceAsset.id) : null;

  return (
    <div className="preview-panel">
      <div className={`preview${sourceAsset ? ' source-open' : ''}`}>
        <canvas ref={canvasRef} width={sequence.size.width} height={sequence.size.height} />

        {sourceAsset && (
          <div className="source-monitor">
            {sourceAsset.kind === 'image' && sourceUrl ? (
              <img className="source-media" src={sourceUrl} alt={sourceAsset.name} />
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
              <button className="icon" title="Return to program preview" onClick={showProgramPreview}>
                <IconClose />
              </button>
            </div>
          </div>
        )}

        {!sourceAsset && !hasClips && (
          <div className="empty">
            Import a file, then drag it to the timeline or use <strong>Add to timeline</strong>.
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
