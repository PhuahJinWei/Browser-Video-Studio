import { useEffect, useState } from 'react';
import { canRun, detectCapabilities, type CapabilityResult } from '../capabilities';
import * as T from '../model/time';
import { ContextMenuProvider } from './ContextMenu';
import { ExportDialog } from './ExportDialog';
import { IconExport, IconGauge, IconRedo, IconSplit, IconTrash, IconUndo } from './Icons';
import { Inspector } from './Inspector';
import { MediaBin } from './MediaBin';
import { MenuBar } from './MenuBar';
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
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const selectClips = useStudio((s) => s.select);
  const importViaPicker = useStudio((s) => s.importViaPicker);
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
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectClips(Object.keys(project.clips) as never);
        return;
      }
      if (mod && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        void importViaPicker();
        return;
      }
      if (mod && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        setShowExport(true);
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
    importViaPicker,
    playhead,
    project,
    redoEdit,
    run,
    selectClips,
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
        <span className="brand">Browser Video Studio</span>

        {/* Shrinkable strip so a narrow window never puts a control out of reach. */}
        <div className="toolbar">
        <MenuBar onExport={() => setShowExport(true)} />

        <span className="header-divider" />

        {/* The few actions worth reaching without opening a menu. */}
        <button className="icon" disabled={!canUndoEdit()} onClick={undoEdit} title="Undo (Ctrl+Z)">
          <IconUndo />
        </button>
        <button className="icon" disabled={!canRedoEdit()} onClick={redoEdit} title="Redo (Ctrl+Shift+Z)">
          <IconRedo />
        </button>
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
          title="Delete the selection (Del)"
          onClick={() => run({ type: 'removeClips', clipIds: selection, mode: 'lift' }, 'Delete clips')}
        >
          <IconTrash />
        </button>

        </div>

        <button
          className={`icon${showTelemetry ? ' on' : ''}`}
          onClick={toggleTelemetry}
          title="Toggle the pipeline panel"
        >
          <IconGauge />
        </button>
        <button className="primary" onClick={() => setShowExport(true)} title="Export the sequence (Ctrl+E)">
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
