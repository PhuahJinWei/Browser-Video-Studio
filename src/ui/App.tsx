import { useEffect, useRef, useState } from 'react';
import { canRun, detectCapabilities, type CapabilityResult } from '../capabilities';
import { formatGain } from './format';
import { useLayout } from './layout';
import { PanelDivider } from './PanelDivider';
import { staticParam } from '../model/params';
import * as T from '../model/time';
import { ContextMenuProvider } from './ContextMenu';
import { ExportDialog } from './ExportDialog';
import {
  IconCamera,
  IconExport,
  IconFit,
  IconGauge,
  IconInspector,
  IconMoon,
  IconRedo,
  IconSplit,
  IconSun,
  IconTrash,
  IconUndo,
  IconVolume,
  IconZoomIn,
  IconZoomOut,
} from './Icons';
import { Inspector } from './Inspector';
import { MediaBin } from './MediaBin';
import { MenuBar } from './MenuBar';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { flushAutosave, useStudio } from './store';

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
  const addTransitionNearPlayhead = useStudio((s) => s.addTransitionNearPlayhead);
  const splitAtPlayhead = useStudio((s) => s.splitAtPlayhead);
  const binWidth = useLayout((s) => s.binWidth);
  const inspectorWidth = useLayout((s) => s.inspectorWidth);
  const inspectorOpen = useLayout((s) => s.inspectorOpen);
  const setBinWidth = useLayout((s) => s.setBinWidth);
  const setInspectorWidth = useLayout((s) => s.setInspectorWidth);
  const toggleInspector = useLayout((s) => s.toggleInspector);
  const middleRef = useRef<HTMLDivElement>(null);
  const endGesture = useStudio((s) => s.endGesture);
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
  const grabScreenshot = useStudio((s) => s.grabScreenshot);
  const theme = useLayout((s) => s.theme);
  const toggleTheme = useLayout((s) => s.toggleTheme);

  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;
  const masterDb =
    sequence.masterGainDb.kind === 'static' ? sequence.masterGainDb.value : 0;

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
      if (mod && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        if (event.shiftKey) run({ type: 'ungroupClips', clipIds: selection }, 'Ungroup clips');
        else if (selection.length >= 2) run({ type: 'groupClips', clipIds: selection }, 'Group clips');
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

      // Final Cut's inspector key, and nothing else here claims a digit.
      if (mod && event.key === '4') {
        event.preventDefault();
        toggleInspector();
        return;
      }

      // The way most transitions actually get added, in every other editor.
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        addTransitionNearPlayhead();
        return;
      }

      /*
       * Bare-letter shortcuts, checked separately because they must not fire with a
       * modifier held. Ctrl+S belongs to the browser, and falling through to the
       * switch below would have it cut the timeline instead.
       */
      if (!mod) {
        switch (event.key) {
          case 's':
            splitAtPlayhead();
            return;
          case 'S':
            // Shift+S grabs the frame, next to the key that cuts it.
            event.preventDefault();
            void grabScreenshot();
            return;
          default:
            break;
        }
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
    toggleInspector,
    addTransitionNearPlayhead,
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
    grabScreenshot,
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
        <button className="icon" title="Split at the playhead (S)" onClick={splitAtPlayhead}>
          <IconSplit />
        </button>
        <button
          className="icon"
          title="Save the current frame as a PNG (Shift+S)"
          onClick={() => void grabScreenshot()}
        >
          <IconCamera />
        </button>
        <button
          className="icon tint-danger"
          disabled={selection.length === 0}
          title="Delete the selection (Del)"
          onClick={() => run({ type: 'removeClips', clipIds: selection, mode: 'lift' }, 'Delete clips')}
        >
          <IconTrash />
        </button>

        </div>

        {/*
          Master volume. The mixer has always applied `masterGainDb` and nothing could
          reach it; the header is the one strip that is always visible, where the
          transport bar under a narrow preview is not.
        */}
        <span
          className="master-volume"
          title={`Master volume ${formatGain(masterDb)} — double-click for 100%`}
        >
          <IconVolume size={14} />
          <input
            type="range"
            min={-60}
            max={12}
            step={0.5}
            value={masterDb}
            onChange={(event) =>
              run(
                {
                  type: 'setSequenceParam',
                  sequenceId,
                  key: 'masterGainDb',
                  param: staticParam(Number(event.target.value)),
                },
                'Set master volume',
                'master-gain',
              )
            }
            onPointerUp={endGesture}
            onDoubleClick={() =>
              run(
                { type: 'setSequenceParam', sequenceId, key: 'masterGainDb', param: staticParam(0) },
                'Reset master volume',
              )
            }
          />
        </span>

        <button
          className="icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
        <button
          className={`icon${inspectorOpen ? ' on' : ''}`}
          onClick={toggleInspector}
          title="Toggle the inspector (Ctrl+4)"
        >
          <IconInspector />
        </button>
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

      {/*
        Columns come from the layout store rather than the stylesheet so the
        dividers can move them. The centre keeps a floor of its own, so dragging
        a side panel wide cannot squeeze the preview away.
      */}
      <div
        className="middle"
        ref={middleRef}
        style={{
          gridTemplateColumns: inspectorOpen
            ? `${binWidth}px auto minmax(300px, 1fr) auto ${inspectorWidth}px`
            : `${binWidth}px auto minmax(300px, 1fr)`,
        }}
      >
        <MediaBin />
        <PanelDivider
          label="Resize the library"
          onDrag={(clientX) => {
            const left = middleRef.current?.getBoundingClientRect().left ?? 0;
            setBinWidth(clientX - left);
          }}
        />
        <div className="panel">
          <Preview />
        </div>
        {inspectorOpen && (
          <PanelDivider
            label="Resize the inspector"
            onDrag={(clientX) => {
              const right = middleRef.current?.getBoundingClientRect().right ?? 0;
              setInspectorWidth(right - clientX);
            }}
          />
        )}
        {inspectorOpen && <Inspector />}
      </div>

      <Timeline />

      <div className="statusbar">
        <span className="status-text">{status}</span>
        {error && <span className="err">{error}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="status-meta">
          {sequence.size.width}×{sequence.size.height} · {T.fpsToNumber(sequence.frameRate).toFixed(2)}{' '}
          fps · {sequence.sampleRate / 1000} kHz
        </span>
        <ZoomSlider zoom={sequence.view.zoom} />
      </div>

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
    </div>
  );
}

/** The zoom range the store clamps to, mirrored here so the slider cannot exceed it. */
const ZOOM_MIN = 4;
const ZOOM_MAX = 2000;

/**
 * Timeline zoom, at the far end of the status bar.
 *
 * Logarithmic. The range spans 4 to 2000 pixels per second, but nearly all editing
 * happens between about 20 and 200 — on a linear track that whole band would live in
 * the first tenth of the travel and be impossible to land on, while nine tenths of
 * the slider did nothing anyone wanted.
 */
function ZoomSlider({ zoom }: { zoom: number }): React.JSX.Element {
  const setZoom = useStudio((s) => s.setZoom);
  const duration = useStudio((s) => s.duration);

  const toSlider = (px: number): number =>
    (Math.log(px / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 1000;
  const fromSlider = (value: number): number =>
    ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, value / 1000);

  /** Fit the whole sequence in the pane — the one zoom level worth a shortcut. */
  const zoomToFit = (): void => {
    const seconds = T.toSeconds(duration());
    const pane = document.querySelector('.timeline')?.clientWidth ?? 0;
    // Nothing on the timeline yet, so there is nothing to fit to.
    if (seconds <= 0 || pane <= 0) return;
    setZoom((pane - 216 - 24) / seconds);
  };

  return (
    <span className="zoom-slider" title={`Timeline zoom — ${Math.round(zoom)} px/s`}>
      <button className="icon" title="Zoom out" onClick={() => setZoom(zoom / 1.4)}>
        <IconZoomOut />
      </button>
      <input
        type="range"
        min={0}
        max={1000}
        step={1}
        value={Math.round(toSlider(zoom))}
        aria-label="Timeline zoom"
        onChange={(event) => setZoom(fromSlider(Number(event.target.value)))}
        onDoubleClick={zoomToFit}
      />
      <button className="icon" title="Zoom in" onClick={() => setZoom(zoom * 1.4)}>
        <IconZoomIn />
      </button>
      <button className="icon" title="Zoom to fit the sequence" onClick={zoomToFit}>
        <IconFit />
      </button>
    </span>
  );
}
