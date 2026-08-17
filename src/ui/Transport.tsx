/**
 * Transport bar — sits directly under the preview canvas, where playback controls
 * belong in every editor.
 */

import { useEffect, useState } from 'react';
import { snapPoints } from '../model/selectors';
import * as T from '../model/time';
import type { FrameRate, Time } from '../model/types';
import { Fader } from './Fader';
import { formatPercent } from './format';
import {
  IconCamera,
  IconExitFullscreen,
  IconFullscreen,
  IconNextEdit,
  IconMuted,
  IconPause,
  IconPlay,
  IconPrevEdit,
  IconSkipEnd,
  IconSkipStart,
  IconStepBack,
  IconStepForward,
  IconVolume,
} from './Icons';
import { useLayout } from './layout';
import { Scrubber } from './Scrubber';
import { useStudio } from './store';

export interface SourceTransport {
  readonly at: Time;
  readonly duration: Time;
  readonly frameRate: FrameRate | null;
  readonly playing: boolean;
  readonly playable: boolean;
  readonly hasPicture: boolean;
  readonly seek: (at: Time) => void;
  readonly togglePlay: () => void;
  readonly marks: { readonly inPoint: Time | null; readonly outPoint: Time | null };
  readonly markIn: () => void;
  readonly markOut: () => void;
  readonly clearMarks: () => void;
  readonly editToTimeline: (mode: 'insert' | 'overwrite') => void;
}

export function Transport({ source = null }: { source?: SourceTransport | null }): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const playing = useStudio((s) => s.telemetry?.playing ?? false);
  const toggleProgramPlay = useStudio((s) => s.togglePlay);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const duration = useStudio((s) => s.duration);
  const captureFrame = useStudio((s) => s.captureFrame);
  const engine = useStudio((s) => s.engine);
  const monitorVolume = useLayout((s) => s.monitorVolume);
  const monitorMuted = useLayout((s) => s.monitorMuted);
  const setMonitorVolume = useLayout((s) => s.setMonitorVolume);
  const setMonitorMuted = useLayout((s) => s.setMonitorMuted);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    engine?.setMonitorGain(monitorMuted ? 0 : monitorVolume);
  }, [engine, monitorMuted, monitorVolume]);

  // The browser owns native fullscreen state (Escape, F11, the window chrome), so
  // mirror it from the event rather than assuming our button is the only way out.
  useEffect(() => {
    const sync = (): void => {
      if (document.fullscreenElement) setExpanded(true);
      else if (!document.body.classList.contains('focus-mode')) setExpanded(false);
    };
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // Escape leaves focus mode, matching what Escape does in native fullscreen.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || document.fullscreenElement) return;
      document.body.classList.remove('focus-mode');
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  /**
   * Native fullscreen where it is allowed, otherwise a focus mode that expands the
   * preview to fill the window. `requestFullscreen` throws in an embedded frame that
   * was not granted the permission, so the fallback is what actually runs there.
   */
  const toggleFullscreen = (): void => {
    const panel = document.querySelector<HTMLElement>('.preview-panel');
    if (!panel) return;

    const leaveFocusMode = (): void => {
      document.body.classList.remove('focus-mode');
      setExpanded(false);
    };

    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (document.body.classList.contains('focus-mode')) {
      leaveFocusMode();
      return;
    }

    try {
      const request = panel.requestFullscreen();
      setExpanded(true);
      void request.catch(() => {
        document.body.classList.add('focus-mode');
        setExpanded(true);
      });
    } catch {
      document.body.classList.add('focus-mode');
      setExpanded(true);
    }
  };

  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;
  const frameRate = source?.frameRate ?? sequence.frameRate;
  const frame = T.frameDuration(frameRate);
  const total = source?.duration ?? duration();
  const at = source?.at ?? sequence.view.playhead;
  const transportPlaying = source?.playing ?? playing;
  const seek = (next: Time): void => {
    if (source) source.seek(next);
    else setPlayhead(next);
  };

  /** Clip edges are the edit points; markers and the playhead itself are not. */
  const editPoints = (): readonly T.Time[] =>
    snapPoints(project, sequenceId, {
      includeMarkers: false,
      includePlayhead: false,
      includeInOut: false,
    });

  const goPrevEdit = (): void => {
    const before = editPoints().filter((p) => T.lt(p, at));
    seek(before[before.length - 1] ?? T.TIME_ZERO);
  };

  const goNextEdit = (): void => {
    const after = editPoints().find((p) => T.gt(p, at));
    seek(after ?? total);
  };

  const step = (frames: number): void =>
    seek(T.clamp(T.add(at, T.mulInt(frame, frames)), T.TIME_ZERO, total));

  const progress = T.isPositive(total) ? Math.min(1, T.ratio(at, total)) : 0;
  const setProgress = (ratio: number): void => {
    if (!T.isPositive(total)) return;
    seek(T.mulRational(total, T.fromSeconds(ratio, 100_000)));
  };
  const sourceRange = source && T.isPositive(total)
    ? {
        start: T.ratio(source.marks.inPoint ?? T.TIME_ZERO, total),
        end: T.ratio(source.marks.outPoint ?? total, total),
      }
    : undefined;

  return (
    <div className="transport">
      <Scrubber
        value={progress}
        onChange={setProgress}
        step={T.isPositive(total) ? T.ratio(frame, total) : 0.01}
        ariaLabel="Preview position"
        ariaValueText={`${T.toTimecode(at, frameRate)} of ${T.toTimecode(total, frameRate)}`}
        title="Click to seek"
        {...(sourceRange ? { range: sourceRange } : {})}
      />

      <div className="transport-buttons">
        <span className="transport-time">
          {T.toTimecode(at, frameRate)}
          <span className="dim"> / {T.toTimecode(total, frameRate)}</span>
        </span>

        <div className="transport-playback" role="group" aria-label="Playback controls">
          <button className="icon" title="Go to start (Home)" onClick={() => seek(T.TIME_ZERO)}>
            <IconSkipStart />
          </button>
          {!source && (
            <button className="icon" title="Previous edit point" onClick={goPrevEdit}>
              <IconPrevEdit />
            </button>
          )}
          <button className="icon" title="Previous frame (←)" onClick={() => step(-1)}>
            <IconStepBack />
          </button>

          <button
            className="icon"
            disabled={source ? !source.playable : false}
            title={transportPlaying ? 'Pause (Space)' : 'Play (Space)'}
            onClick={() => (source ? source.togglePlay() : void toggleProgramPlay())}
          >
            {transportPlaying ? <IconPause size={16} /> : <IconPlay size={16} />}
          </button>

          <button className="icon" title="Next frame (→)" onClick={() => step(1)}>
            <IconStepForward />
          </button>
          {!source && (
            <button className="icon" title="Next edit point" onClick={goNextEdit}>
              <IconNextEdit />
            </button>
          )}
          <button className="icon" title="Go to end (End)" onClick={() => seek(total)}>
            <IconSkipEnd />
          </button>
        </div>

        <div className="transport-utilities" role="group" aria-label="Preview utilities">
          {source && (
            <div className="source-edit-tools" role="group" aria-label="Source editing">
              <button title="Mark source In (I)" onClick={source.markIn}>In</button>
              <button title="Mark source Out (O)" onClick={source.markOut}>Out</button>
              <button
                className="icon"
                title="Clear source In and Out"
                disabled={!source.marks.inPoint && !source.marks.outPoint}
                onClick={source.clearMarks}
              >
                ×
              </button>
              <button title="Insert source at playhead" onClick={() => source.editToTimeline('insert')}>
                Insert
              </button>
              <button title="Overwrite source at playhead" onClick={() => source.editToTimeline('overwrite')}>
                Overwrite
              </button>
            </div>
          )}
          <span
            className="preview-volume"
            title={`Preview volume ${monitorMuted ? 'muted' : `${Math.round(monitorVolume * 100)}%`}`}
          >
            <button
              className={`icon${monitorMuted ? ' on' : ''}`}
              title={monitorMuted ? 'Unmute preview' : 'Mute preview'}
              onClick={() => setMonitorMuted(!monitorMuted)}
            >
              {monitorMuted ? <IconMuted /> : <IconVolume />}
            </button>
            <Fader
              min={0}
              max={100}
              step={1}
              value={Math.round(monitorVolume * 100)}
              neutral={100}
              thumb={10}
              format={formatPercent}
              ariaLabel="Preview volume"
              onChange={(value) => {
                setMonitorVolume(value / 100);
                if (value > 0 && monitorMuted) setMonitorMuted(false);
              }}
              onReset={() => {
                setMonitorVolume(1);
                setMonitorMuted(false);
              }}
            />
          </span>
          <button
            className="icon"
            disabled={source ? !source.hasPicture : false}
            title="Capture this frame to the Library (Shift+S)"
            onClick={() => void captureFrame()}
          >
            <IconCamera />
          </button>
          <button
            className="icon"
            title={expanded ? 'Exit fullscreen (Esc)' : 'Fullscreen preview'}
            onClick={toggleFullscreen}
          >
            {expanded ? <IconExitFullscreen /> : <IconFullscreen />}
          </button>
        </div>
      </div>
    </div>
  );
}
