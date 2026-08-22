/**
 * Application menu bar.
 *
 * Behaves like a desktop menu bar: click a title to open it, then moving across the
 * other titles switches menus without another click. It shares `renderMenuEntries`
 * with the right-click menus so both look and act the same, and every entry shows
 * the keyboard shortcut that does the same job.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderMenuEntries, type MenuEntry } from './ContextMenu';
import {
  IconAudio,
  IconCamera,
  IconExport,
  IconEye,
  IconEyeOff,
  IconDownload,
  IconFile,
  IconFolder,
  IconFullscreen,
  IconGauge,
  IconGroup,
  IconInspector,
  IconLink,
  IconLock,
  IconMarker,
  IconPlus,
  IconRedo,
  IconRipple,
  IconSkipEnd,
  IconSkipStart,
  IconSplit,
  IconSwatch,
  IconText,
  IconTrash,
  IconUndo,
  IconUngroup,
  IconUnlink,
  IconUnlocked,
  IconVideo,
} from './Icons';
import { linkability } from '../model/selectors';
import * as T from '../model/time';
import { useLayout } from './layout';
import { GENERATORS } from './generators';
import { emptyTracksToRemove, useStudio } from './store';
import { useDialog } from './Dialog';

/**
 * A dropdown anchored under its title.
 *
 * Rendered into a portal on `document.body` rather than inside the bar. Ancestors
 * clip it otherwise — `.app` and `body` are `overflow: hidden`, and the toolbar
 * strip scrolls sideways, which silently forces its *vertical* overflow to `auto`
 * too (CSS computes a `visible` value to `auto` when the other axis is not
 * visible). The result was a menu hidden behind the panels below the header.
 *
 * A portal also escapes the header's stacking context, so no z-index race with the
 * middle section.
 */
function Dropdown({
  anchor,
  entries,
  onClose,
}: {
  anchor: HTMLElement | null;
  entries: readonly MenuEntry[];
  onClose: () => void;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const button = anchor.getBoundingClientRect();
    const menu = el.getBoundingClientRect();

    // Keep it inside the window: shift left if it overhangs, flip above if it
    // would run off the bottom.
    const left = Math.max(6, Math.min(button.left, window.innerWidth - menu.width - 6));
    const below = button.bottom + 4;
    const top = below + menu.height > window.innerHeight - 6
      ? Math.max(6, button.top - menu.height - 4)
      : below;
    setPosition({ left, top });
  }, [anchor]);

  if (!anchor) return null;

  return createPortal(
    <div
      className="menubar-dropdown"
      role="menu"
      ref={ref}
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        // Hidden for the first paint, before it has been measured and placed.
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {renderMenuEntries(entries, onClose)}
    </div>,
    document.body,
  );
}

interface MenuDefinition {
  readonly title: string;
  readonly entries: readonly MenuEntry[];
}

export function MenuBar({
  onExport,
  onOpenProject,
}: {
  onExport: () => void;
  onOpenProject: () => void;
}): React.JSX.Element {
  const dialog = useDialog();
  const [open, setOpen] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const selection = useStudio((s) => s.selection);
  const showTelemetry = useStudio((s) => s.showTelemetry);

  const run = useStudio((s) => s.run);
  const undoEdit = useStudio((s) => s.undoEdit);
  const redoEdit = useStudio((s) => s.redoEdit);
  const canUndoEdit = useStudio((s) => s.canUndoEdit);
  const canRedoEdit = useStudio((s) => s.canRedoEdit);
  const newProject = useStudio((s) => s.newProject);
  const saveProjectToFile = useStudio((s) => s.saveProjectToFile);
  const openProjectFileViaPicker = useStudio((s) => s.openProjectFileViaPicker);
  const addGeneratorAtPlayhead = useStudio((s) => s.addGeneratorAtPlayhead);
  const splitAtPlayhead = useStudio((s) => s.splitAtPlayhead);
  const removeEmptyTracks = useStudio((s) => s.removeEmptyTracks);
  const captureFrame = useStudio((s) => s.captureFrame);
  const inspectorOpen = useLayout((s) => s.inspectorOpen);
  const toggleInspector = useLayout((s) => s.toggleInspector);
  const resetWorkspace = useLayout((s) => s.resetWorkspace);
  const transparencyGrid = useLayout((s) => s.transparencyGrid);
  const toggleTransparencyGrid = useLayout((s) => s.toggleTransparencyGrid);
  const importViaPicker = useStudio((s) => s.importViaPicker);
  const toggleTelemetry = useStudio((s) => s.toggleTelemetry);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const playhead = useStudio((s) => s.playhead);
  const setSequenceMark = useStudio((s) => s.setSequenceMark);
  const clearSequenceMarks = useStudio((s) => s.clearSequenceMarks);
  const goToSequenceMark = useStudio((s) => s.goToSequenceMark);
  const duration = useStudio((s) => s.duration);
  const setZoom = useStudio((s) => s.setZoom);
  const select = useStudio((s) => s.select);

  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;
  const hasSelection = selection.length > 0;
  const emptyTrackCount = emptyTracksToRemove(project, sequenceId).length;

  // The first selected clip drives the Clip menu's toggles.
  const clip = selection.length > 0 ? project.clips[selection[0]!] : undefined;
  const selectionHasGroup = selection.some((id) => project.clips[id]?.groupId);
  const linkedCount = clip?.linkGroupId
    ? Object.values(project.clips).filter((c) => c.linkGroupId === clip.linkGroupId).length
    : 0;
  // Says why, rather than only whether: a greyed entry with no reason is a dead end,
  // and "they are already linked" is a state a person will otherwise keep retrying.
  const link = linkability(project, selection);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null;
      // The dropdown is portalled out of the bar, so containment alone would treat
      // a click on a menu item as "outside" and unmount it before the click landed.
      if (barRef.current?.contains(target) || target?.closest('.menubar-dropdown')) return;
      setOpen(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(null);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', () => setOpen(null));
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const menus: readonly MenuDefinition[] = [
    {
      title: 'File',
      entries: [
        { label: 'New project', icon: <IconFile />, onSelect: () => void (async () => {
            if (await dialog.confirm({
              title: 'Start a new project?',
              message: 'Your current project is kept safely on this device.',
              confirmLabel: 'New project',
            })) newProject();
          })() },
        {
          label: 'Open project…',
          icon: <IconFolder />,
          hint: 'Ctrl+O',
          onSelect: onOpenProject,
        },
        {
          label: 'Open a project file…',
          icon: <IconFolder />,
          onSelect: () => void openProjectFileViaPicker(),
        },
        {
          label: 'Save this project to a file…',
          icon: <IconDownload />,
          onSelect: () => void saveProjectToFile(project.id),
        },
        'separator',
        { label: 'Import media…', icon: <IconPlus />, hint: 'Ctrl+I', onSelect: () => void importViaPicker() },
        'separator',
        {
          label: 'Capture frame',
          icon: <IconCamera />,
          hint: 'Shift+S',
          onSelect: () => void captureFrame(),
        },
        { label: 'Export…', icon: <IconExport />, hint: 'Ctrl+E', onSelect: onExport },
      ],
    },
    {
      title: 'Edit',
      entries: [
        { label: 'Undo', icon: <IconUndo />, hint: 'Ctrl+Z', disabled: !canUndoEdit(), onSelect: undoEdit },
        { label: 'Redo', icon: <IconRedo />, hint: 'Ctrl+Shift+Z', disabled: !canRedoEdit(), onSelect: redoEdit },
        'separator',
        {
          label: 'Select all clips',
          hint: 'Ctrl+A',
          onSelect: () => select(Object.keys(project.clips) as never),
        },
        { label: 'Deselect', disabled: !hasSelection, onSelect: () => select([]) },
        'separator',
        {
          // Both entries count what they will take, matching the timeline's own
          // clip menu — the pair differs in whether the gap closes, nothing else.
          label: selection.length > 1 ? `Delete ${selection.length} clips` : 'Delete',
          icon: <IconTrash />,
          hint: 'Del',
          danger: true,
          disabled: !hasSelection,
          onSelect: () => run({ type: 'removeClips', clipIds: selection, mode: 'lift' }, 'Delete clips'),
        },
        {
          label:
            selection.length > 1 ? `Ripple delete ${selection.length} clips` : 'Ripple delete',
          icon: <IconRipple />,
          hint: 'Shift+Del',
          danger: true,
          disabled: !hasSelection,
          onSelect: () => run({ type: 'removeClips', clipIds: selection, mode: 'ripple' }, 'Ripple delete'),
        },
      ],
    },
    {
      title: 'Clip',
      entries: [
        { label: 'Split at playhead', icon: <IconSplit />, hint: 'S', onSelect: splitAtPlayhead },
        'separator',
        {
          label: 'Detach audio from video',
          icon: <IconUnlink />,
          disabled: linkedCount < 2,
          onSelect: () => run({ type: 'unlinkClips', clipIds: selection }, 'Detach audio'),
        },
        {
          label: link.ok ? 'Link selected clips' : `Link selected clips (${link.reason})`,
          icon: <IconLink />,
          disabled: !link.ok,
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
          disabled: !selectionHasGroup,
          onSelect: () => run({ type: 'ungroupClips', clipIds: selection }, 'Ungroup clips'),
        },
        'separator',
        {
          label: clip?.enabled === false ? 'Enable' : 'Disable',
          icon: clip?.enabled === false ? <IconEye /> : <IconEyeOff />,
          disabled: !clip,
          onSelect: () =>
            clip &&
            run(
              { type: 'setClipProps', clipId: clip.id, props: { enabled: !clip.enabled } },
              clip.enabled ? 'Disable clip' : 'Enable clip',
            ),
        },
        {
          label: clip?.locked ? 'Unlock' : 'Lock',
          icon: clip?.locked ? <IconUnlocked /> : <IconLock />,
          disabled: !clip,
          onSelect: () =>
            clip &&
            run(
              { type: 'setClipProps', clipId: clip.id, props: { locked: !clip.locked } },
              clip.locked ? 'Unlock clip' : 'Lock clip',
            ),
        },
        'separator',
        // Same action the toolbar's own controls run, so the menu cannot drift from
        // them — and no dialog here either, for the same reason.
        ...GENERATORS.map((generator) => ({
          label: `Add ${generator.label.toLowerCase()} at playhead`,
          icon: generator.id === 'title' ? <IconText /> : <IconSwatch />,
          onSelect: () => addGeneratorAtPlayhead(generator.id),
        })),
      ],
    },
    {
      title: 'Track',
      entries: [
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
          label:
            emptyTrackCount > 0
              ? `Remove ${emptyTrackCount} empty track${emptyTrackCount === 1 ? '' : 's'}`
              : 'Remove empty tracks',
          icon: <IconTrash />,
          disabled: emptyTrackCount === 0,
          onSelect: removeEmptyTracks,
        },
      ],
    },
    /*
     * Marks annotate the sequence; the menus around them act on its contents. The
     * marker entry lived under Track only because it had nowhere better to be, and
     * putting In and Out beside it made that mismatch four entries wider rather than
     * fixing it — so the pair that belong together get their own menu.
     */
    {
      title: 'Mark',
      entries: [
        { label: 'Mark In', hint: 'I', onSelect: () => setSequenceMark('in') },
        { label: 'Mark Out', hint: 'O', onSelect: () => setSequenceMark('out') },
        'separator',
        {
          label: 'Go to In',
          hint: 'Shift+I',
          disabled: !sequence.view.inPoint,
          onSelect: () => goToSequenceMark('in'),
        },
        {
          label: 'Go to Out',
          hint: 'Shift+O',
          disabled: !sequence.view.outPoint,
          onSelect: () => goToSequenceMark('out'),
        },
        {
          label: 'Clear In and Out',
          hint: 'Ctrl+Shift+X',
          disabled: !sequence.view.inPoint && !sequence.view.outPoint,
          onSelect: clearSequenceMarks,
        },
        'separator',
        {
          label: 'Add marker at playhead',
          icon: <IconMarker />,
          onSelect: () => run({ type: 'addMarker', sequenceId, at: playhead() }, 'Add marker'),
        },
      ],
    },
    {
      title: 'View',
      entries: [
        {
          label: 'Inspector',
          icon: <IconInspector />,
          hint: 'Ctrl+4',
          checked: inspectorOpen,
          onSelect: toggleInspector,
        },
        {
          label: 'Pipeline panel',
          icon: <IconGauge />,
          checked: showTelemetry,
          onSelect: toggleTelemetry,
        },
        {
          // Named for what it shows rather than what it hides, and worded so it is
          // clear this is about the monitor and not about the file.
          label: 'Transparency grid',
          checked: transparencyGrid,
          onSelect: toggleTransparencyGrid,
        },
        {
          label: 'Fullscreen preview',
          icon: <IconFullscreen />,
          onSelect: () => {
            document.querySelector<HTMLButtonElement>('.transport-buttons button[title*="ullscreen"]')?.click();
          },
        },
        { label: 'Reset workspace layout', onSelect: resetWorkspace },
        'separator',
        { label: 'Zoom in', hint: 'Ctrl+Wheel', onSelect: () => setZoom(sequence.view.zoom * 1.4) },
        { label: 'Zoom out', onSelect: () => setZoom(sequence.view.zoom / 1.4) },
        {
          label: 'Zoom to fit',
          onSelect: () => {
            const seconds = T.toSeconds(duration());
            const width = document.querySelector('.timeline-scroll')?.clientWidth ?? 800;
            setZoom(seconds > 0 ? (width - 24) / seconds : 100);
          },
        },
        'separator',
        { label: 'Go to start', icon: <IconSkipStart />, hint: 'Home', onSelect: () => setPlayhead(T.TIME_ZERO) },
        { label: 'Go to end', icon: <IconSkipEnd />, hint: 'End', onSelect: () => setPlayhead(duration()) },
      ],
    },
    {
      title: 'Help',
      entries: [
        {
          label: 'Keyboard shortcuts',
          onSelect: () => void dialog.notice({
              title: 'Keyboard shortcuts',
              message: [
                'Space — play / pause',
                '← / → — step one frame (Shift for ten)',
                'Home / End — go to start / end',
                'S — split all tracks at the playhead',
                'I / O — mark In / Out at the playhead',
                'Shift+I / Shift+O — go to the In / Out mark',
                'Ctrl+Shift+X — clear In and Out',
                'Del — delete selected clips',
                'Ctrl+Z / Ctrl+Shift+Z — undo / redo',
                'Ctrl+A — select all clips',
                'Ctrl+I — import media',
                'Ctrl+E — export',
                'Ctrl+Wheel — zoom the timeline',
                'Right-click — context menus on clips, lanes, the ruler and the bin',
              ].join('\n'),
            }),
        },
        {
          label: 'About Browser Video Studio',
          onSelect: () => void dialog.notice({
            title: 'About Browser Video Studio',
            message: 'A video editor that runs entirely in your browser on WebCodecs and WebGPU.\nNothing is uploaded — media never leaves this machine.',
          }),
        },
      ],
    },
  ];

  return (
    <div className="menubar" ref={barRef}>
      {menus.map((menu) => (
        <div className="menubar-item" key={menu.title}>
          <button
            type="button"
            className={`menubar-title${open === menu.title ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open === menu.title}
            onClick={(event) => {
              setAnchor(event.currentTarget);
              setOpen(open === menu.title ? null : menu.title);
            }}
            // Once a menu is open, sliding across the bar switches between them.
            onPointerEnter={(event) => {
              if (!open) return;
              setAnchor(event.currentTarget);
              setOpen(menu.title);
            }}
          >
            {menu.title}
          </button>
          {open === menu.title && (
            <Dropdown anchor={anchor} entries={menu.entries} onClose={() => setOpen(null)} />
          )}
        </div>
      ))}
    </div>
  );
}
