/**
 * Transport bar — sits directly under the preview canvas, where playback controls
 * belong in every editor.
 */

import { useEffect, useState } from 'react';
import { snapPoints } from '../model/selectors';
import * as T from '../model/time';
import {
  IconExitFullscreen,
  IconFullscreen,
  IconNextEdit,
  IconPause,
  IconPlay,
  IconPrevEdit,
  IconSkipEnd,
  IconSkipStart,
  IconSplit,
  IconStepBack,
  IconStepForward,
} from './Icons';
import { useStudio } from './store';

export function Transport(): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const playing = useStudio((s) => s.telemetry?.playing ?? false);
  const togglePlay = useStudio((s) => s.togglePlay);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const duration = useStudio((s) => s.duration);
  const splitAtPlayhead = useStudio((s) => s.splitAtPlayhead);
  const [expanded, setExpanded] = useState(false);

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
  const frame = T.frameDuration(sequence.frameRate);
  const total = duration();
  const at = sequence.view.playhead;

  /** Clip edges are the edit points; markers and the playhead itself are not. */
  const editPoints = (): readonly T.Time[] =>
    snapPoints(project, sequenceId, {
      includeMarkers: false,
      includePlayhead: false,
      includeInOut: false,
    });

  const goPrevEdit = (): void => {
    const before = editPoints().filter((p) => T.lt(p, at));
    setPlayhead(before[before.length - 1] ?? T.TIME_ZERO);
  };

  const goNextEdit = (): void => {
    const after = editPoints().find((p) => T.gt(p, at));
    setPlayhead(after ?? total);
  };

  const step = (frames: number): void =>
    setPlayhead(T.clamp(T.add(at, T.mulInt(frame, frames)), T.TIME_ZERO, total));

  const splitHere = (): void =>
    splitAtPlayhead();

  const progress = T.isPositive(total) ? Math.min(1, T.ratio(at, total)) : 0;

  return (
    <div className="transport">
      <div
        className="scrub"
        title="Click to seek"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromEvent(event, total, setPlayhead);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) seekFromEvent(event, total, setPlayhead);
        }}
      >
        <div className="scrub-fill" style={{ width: `${progress * 100}%` }} />
        <div className="scrub-knob" style={{ left: `${progress * 100}%` }} />
      </div>

      <div className="transport-buttons">
        <button className="icon" title="Go to start (Home)" onClick={() => setPlayhead(T.TIME_ZERO)}>
          <IconSkipStart />
        </button>
        <button className="icon" title="Previous edit point" onClick={goPrevEdit}>
          <IconPrevEdit />
        </button>
        <button className="icon" title="Previous frame (←)" onClick={() => step(-1)}>
          <IconStepBack />
        </button>

        <button
          className="icon play"
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => void togglePlay()}
        >
          {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
        </button>

        <button className="icon" title="Next frame (→)" onClick={() => step(1)}>
          <IconStepForward />
        </button>
        <button className="icon" title="Next edit point" onClick={goNextEdit}>
          <IconNextEdit />
        </button>
        <button className="icon" title="Go to end (End)" onClick={() => setPlayhead(total)}>
          <IconSkipEnd />
        </button>

        <span className="transport-gap" />

        <button className="icon" title="Split at the playhead (S)" onClick={splitHere}>
          <IconSplit />
        </button>
        <button
          className="icon"
          title={expanded ? 'Exit fullscreen (Esc)' : 'Fullscreen preview'}
          onClick={toggleFullscreen}
        >
          {expanded ? <IconExitFullscreen /> : <IconFullscreen />}
        </button>

        <span className="transport-time">
          {T.toTimecode(at, sequence.frameRate)}
          <span className="dim"> / {T.toTimecode(total, sequence.frameRate)}</span>
        </span>
      </div>
    </div>
  );
}

function seekFromEvent(
  event: React.PointerEvent<HTMLDivElement>,
  total: T.Time,
  setPlayhead: (at: T.Time) => void,
): void {
  if (!T.isPositive(total)) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  setPlayhead(T.mulRational(total, T.fromSeconds(ratio, 100_000)));
}
