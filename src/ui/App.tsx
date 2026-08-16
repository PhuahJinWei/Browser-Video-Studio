import { useEffect, useState } from 'react';
import { canRun, detectCapabilities, type CapabilityResult } from '../capabilities';
import * as T from '../model/time';
import { ContextMenuProvider } from './ContextMenu';
import { ExportDialog } from './ExportDialog';
import {
  IconExport,
  IconFile,
  IconGauge,
  IconRedo,
  IconRipple,
  IconSplit,
  IconText,
  IconTrash,
  IconUndo,
} from './Icons';
import { Inspector } from './Inspector';
import { MediaBin } from './MediaBin';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { flushAutosave, orderedTrackIds, useStudio } from './store';

export function App(): React.JSX.Element {
  const [capabilities, setCapabilities] = useState<readonly CapabilityResult[] | null>(null);

  useEffect(() => {
    void detectCapabilities().then(setCapabilities);
  }, []);

  if (!capabilities) return <div className="unsupported">Checking browser capabilities…</div>;
  if (!canRun(capabilities)) return <Unsupported capabilities={capabilities} />;
  return (
    <ContextMenuProvider>
      <Studio />
    </ContextMenuProvider>
  );
}

function Unsupported({ capabilities }: { capabilities: readonly CapabilityResult[] }): React.JSX.Element {
  const missing = capabilities.filter((c) => !c.optional && c.level === 'missing');
  return (
    <div className="unsupported">
      <h1>This browser can’t run the editor</h1>
      <p className="hint">
        Browser Video Studio needs WebCodecs and WebGPU. Chromium 121 or newer (Chrome, Edge) works
        today; Firefox and Safari do not yet expose everything required.
      </p>
      <ul>
        {missing.map((c) => (
          <li key={c.id}>
            <strong>{c.label}</strong> — {c.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Studio(): React.JSX.Element {
  const [showExport, setShowExport] = useState(false);

  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const selection = useStudio((s) => s.selection);
  const status = useStudio((s) => s.status);
  const error = useStudio((s) => s.error);
  const showTelemetry = useStudio((s) => s.showTelemetry);
  const toggleTelemetry = useStudio((s) => s.toggleTelemetry);

  const run = useStudio((s) => s.run);
  const undoEdit = useStudio((s) => s.undoEdit);
  const redoEdit = useStudio((s) => s.redoEdit);
  const canUndoEdit = useStudio((s) => s.canUndoEdit);
  const canRedoEdit = useStudio((s) => s.canRedoEdit);
  const togglePlay = useStudio((s) => s.togglePlay);
  const addTitle = useStudio((s) => s.addTitle);
  const newProject = useStudio((s) => s.newProject);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const playhead = useStudio((s) => s.playhead);
  const duration = useStudio((s) => s.duration);

  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;

  // Save anything still inside the autosave debounce before the page goes away.
  useEffect(() => {
    const onHide = (): void => flushAutosave();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onHide();
    });
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  // ---------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoEdit();
        else undoEdit();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoEdit();
        return;
      }

      const frame = T.frameDuration(sequence.frameRate);
      switch (event.key) {
        case ' ':
          event.preventDefault();
          void togglePlay();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          setPlayhead(T.sub(playhead(), event.shiftKey ? T.mulInt(frame, 10) : frame));
          break;
        case 'ArrowRight':
          event.preventDefault();
          setPlayhead(T.add(playhead(), event.shiftKey ? T.mulInt(frame, 10) : frame));
          break;
        case 'Home':
          event.preventDefault();
          setPlayhead(T.TIME_ZERO);
          break;
        case 'End':
          event.preventDefault();
          setPlayhead(duration());
          break;
        case 's':
        case 'S':
          run(
            { type: 'splitClips', trackIds: orderedTrackIds(project, sequenceId), at: playhead() },
            'Split at playhead',
          );
          break;
        case 'Delete':
        case 'Backspace':
          if (selection.length > 0) {
            event.preventDefault();
            run({ type: 'removeClips', clipIds: selection, mode: 'lift' }, 'Delete clips');
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    duration,
    playhead,
    project,
    redoEdit,
    run,
    selection,
    sequence.frameRate,
    sequenceId,
    setPlayhead,
    togglePlay,
    undoEdit,
  ]);

  return (
    <div className="app">
      <header className="header">
        <h1>Browser Video Studio</h1>

        {/* Scrollable so a narrow window can never put a control out of reach. */}
        <div className="toolbar">
          <button
            onClick={() => {
              if (confirm('Start a new project? Unsaved work in this one is kept on disk.')) {
                newProject();
              }
            }}
            title="New project"
          >
            <IconFile /> New
          </button>
          <button
            onClick={() => {
              const text = prompt('Title text', 'Hello');
              if (text) addTitle(text);
            }}
            title="Add a title clip at the playhead"
          >
            <IconText /> Title
          </button>

          <span className="header-divider" />

          <button
            className="icon"
            title="Split all tracks at the playhead (S)"
            onClick={() =>
              run(
                { type: 'splitClips', trackIds: orderedTrackIds(project, sequenceId), at: playhead() },
                'Split at playhead',
              )
            }
          >
            <IconSplit />
          </button>
          <button
            className="icon"
            disabled={selection.length === 0}
            title="Ripple delete: remove the selection and close the gap"
            onClick={() =>
              run({ type: 'removeClips', clipIds: selection, mode: 'ripple' }, 'Ripple delete')
            }
          >
            <IconRipple />
          </button>
          <button
            className="icon"
            disabled={selection.length === 0}
            title="Delete the selection (Del)"
            onClick={() =>
              run({ type: 'removeClips', clipIds: selection, mode: 'lift' }, 'Delete clips')
            }
          >
            <IconTrash />
          </button>

          <span className="header-divider" />

          <button className="icon" disabled={!canUndoEdit()} onClick={undoEdit} title="Undo (Ctrl+Z)">
            <IconUndo />
          </button>
          <button className="icon" disabled={!canRedoEdit()} onClick={redoEdit} title="Redo (Ctrl+Shift+Z)">
            <IconRedo />
          </button>
        </div>

        {/* Pinned: these must stay reachable at any width. */}
        <button
          className={`icon${showTelemetry ? ' on' : ''}`}
          onClick={toggleTelemetry}
          title="Toggle the pipeline panel"
        >
          <IconGauge />
        </button>
        <button className="primary" onClick={() => setShowExport(true)} title="Export the sequence">
          <IconExport /> Export
        </button>
      </header>

      <div className="middle">
        <MediaBin />
        <div className="panel">
          <Preview />
        </div>
        <Inspector />
      </div>

      <Timeline />

      <div className="statusbar">
        <span>{status}</span>
        {error && <span className="err">{error}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <span>
          {sequence.size.width}×{sequence.size.height} · {T.fpsToNumber(sequence.frameRate).toFixed(2)}{' '}
          fps · {sequence.sampleRate / 1000} kHz
        </span>
      </div>

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
    </div>
  );
}
