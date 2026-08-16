import { useEffect, useRef } from 'react';
import * as T from '../model/time';
import { useStudio } from './store';

/** The program monitor. Owns the canvas the compositor draws into. */
export function Preview(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const attachEngine = useStudio((s) => s.attachEngine);
  const showTelemetry = useStudio((s) => s.showTelemetry);
  const telemetry = useStudio((s) => s.telemetry);
  const exportProgress = useStudio((s) => s.exportProgress);
  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);

  const sequence = history.present.project.sequences[sequenceId]!;
  const hasClips = Object.keys(history.present.project.clips).length > 0;

  useEffect(() => {
    if (canvasRef.current) void attachEngine(canvasRef.current);
  }, [attachEngine]);

  return (
    <div className="preview">
      <canvas ref={canvasRef} width={sequence.size.width} height={sequence.size.height} />
      {!hasClips && (
        <div className="empty" style={{ position: 'absolute' }}>
          Import a file, then click <strong>Add</strong> to place it on the timeline.
        </div>
      )}
      {showTelemetry && <TelemetryPanel telemetry={telemetry} exportProgress={exportProgress} />}
    </div>
  );
}

type TelemetryProps = {
  telemetry: ReturnType<typeof useStudio.getState>['telemetry'];
  exportProgress: ReturnType<typeof useStudio.getState>['exportProgress'];
};

/**
 * "Show me what the browser is doing" — the pipeline made visible.
 * During export the stage breakdown replaces the playback counters.
 */
function TelemetryPanel({ telemetry, exportProgress }: TelemetryProps): React.JSX.Element | null {
  if (exportProgress) {
    const { stage, overall, framesEncoded, totalFrames, fps, audioDone, elapsedMs } = exportProgress;
    return (
      <div className="telemetry">
        <h4>Exporting</h4>
        <Bar label="Audio mix" value={audioDone ? 1 : stage === 'audio' ? 0.5 : 0} />
        <Bar label="Decode + composite + encode" value={totalFrames ? framesEncoded / totalFrames : 0} />
        <Bar label="Mux" value={stage === 'finalising' || stage === 'done' ? 1 : 0} />
        <div className="row">
          <span>Frames</span>
          <span>
            {framesEncoded} / {totalFrames}
          </span>
        </div>
        <div className="row">
          <span>Encode rate</span>
          <span>{fps.toFixed(1)} fps</span>
        </div>
        <div className="row">
          <span>Elapsed</span>
          <span>{(elapsedMs / 1000).toFixed(1)} s</span>
        </div>
        <div className="row">
          <span>Overall</span>
          <span>{Math.round(overall * 100)}%</span>
        </div>
      </div>
    );
  }

  if (!telemetry) return null;
  return (
    <div className="telemetry">
      <h4>Pipeline</h4>
      <div className="row">
        <span>State</span>
        <span>{telemetry.playing ? 'playing' : 'idle'}</span>
      </div>
      <div className="row">
        <span>Preview fps</span>
        <span>{telemetry.fps}</span>
      </div>
      <div className="row">
        <span>Decode</span>
        <span>{telemetry.decodeMs.toFixed(1)} ms</span>
      </div>
      <div className="row">
        <span>Composite</span>
        <span>{telemetry.compositeMs.toFixed(1)} ms</span>
      </div>
      <div className="row">
        <span>Layers</span>
        <span>{telemetry.layerCount}</span>
      </div>
      <div className="row">
        <span>Coalesced</span>
        <span>{telemetry.droppedFrames}</span>
      </div>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <>
      <div className="row">
        <span>{label}</span>
        <span>{Math.round(Math.max(0, Math.min(1, value)) * 100)}%</span>
      </div>
      <div className="bar">
        <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </div>
    </>
  );
}

/** Timecode readout for the header. */
export function Timecode(): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const sequence = history.present.project.sequences[sequenceId]!;
  return (
    <span className="timecode">
      {T.toTimecode(sequence.view.playhead, sequence.frameRate)}
    </span>
  );
}
