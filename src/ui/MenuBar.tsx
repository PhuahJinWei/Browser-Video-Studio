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
  IconExport,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFullscreen,
  IconGauge,
  IconLink,
  IconLock,
  IconMarker,
  IconPlus,
  IconRedo,
  IconRipple,
  IconSkipEnd,
  IconSkipStart,
  IconSplit,
  IconText,
  IconTrash,
  IconUndo,
  IconUnlink,
  IconUnlocked,
  IconVideo,
} from './Icons';
import * as T from '../model/time';
import { orderedTrackIds, useStudio } from './store';

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

export function MenuBar({ onExport }: { onExport: () => void }): React.JSX.Element {
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
  const addTitle = useStudio((s) => s.addTitle);
  const importViaPicker = useStudio((s) => s.importViaPicker);
  const toggleTelemetry = useStudio((s) => s.toggleTelemetry);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const playhead = useStudio((s) => s.playhead);
  const duration = useStudio((s) => s.duration);
  const setZoom = useStudio((s) => s.setZoom);
  const select = useStudio((s) => s.select);

  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;
  const trackIds = orderedTrackIds(project, sequenceId);
  const hasSelection = selection.length > 0;

  // The first selected clip drives the Clip menu's toggles.
  const clip = selection.length > 0 ? project.clips[selection[0]!] : undefined;
  const linkedCount = clip?.linkGroupId
    ? Object.values(project.clips).filter((c) => c.linkGroupId === clip.linkGroupId).length
    : 0;

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

  const splitAtPlayhead = (): void =>
    run({ type: 'splitClips', trackIds, at: playhead() }, 'Split at playhead');

  const menus: readonly MenuDefinition[] = [
    {
      title: 'File',
      entries: [
        { label: 'New project', icon: <IconFile />, onSelect: () => {
            if (confirm('Start a new project? Unsaved work in this one is kept on disk.')) newProject();
          } },
        { label: 'Import media…', icon: <IconPlus />, hint: 'Ctrl+I', onSelect: () => void importViaPicker() },
        'separator',
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
          label: 'Delete',
          icon: <IconTrash />,
          hint: 'Del',
          danger: true,
          disabled: !hasSelection,
          onSelect: () => run({ type: 'removeClips', clipIds: selection, mode: 'lift' }, 'Delete clips'),
        },
        {
          label: 'Ripple delete',
          icon: <IconRipple />,
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
          label: 'Link selected clips',
          icon: <IconLink />,
          disabled: selection.length < 2,
          onSelect: () => run({ type: 'linkClips', clipIds: selection }, 'Link clips'),
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
        {
          label: 'Add title at playhead',
          icon: <IconText />,
          onSelect: () => {
            const text = prompt('Title text', 'Hello');
            if (text) addTitle(text);
          },
        },
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
          label: 'Pipeline panel',
          icon: <IconGauge />,
          checked: showTelemetry,
          onSelect: toggleTelemetry,
        },
        {
          label: 'Fullscreen preview',
          icon: <IconFullscreen />,
          onSelect: () => {
            document.querySelector<HTMLButtonElement>('.transport-buttons button[title*="ullscreen"]')?.click();
          },
        },
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
          onSelect: () =>
            alert(
              [
                'Space — play / pause',
                '← / → — step one frame (Shift for ten)',
                'Home / End — go to start / end',
                'S — split all tracks at the playhead',
                'Del — delete selected clips',
                'Ctrl+Z / Ctrl+Shift+Z — undo / redo',
                'Ctrl+A — select all clips',
                'Ctrl+I — import media',
                'Ctrl+E — export',
                'Ctrl+Wheel — zoom the timeline',
                'Right-click — context menus on clips, lanes, the ruler and the bin',
              ].join('\n'),
            ),
        },
        {
          label: 'About Browser Video Studio',
          onSelect: () =>
            alert(
              'Browser Video Studio\n\n' +
                'A video editor that runs entirely in your browser on WebCodecs and WebGPU.\n' +
                'Nothing is uploaded — media never leaves this machine.',
            ),
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
