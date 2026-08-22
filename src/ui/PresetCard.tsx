/**
 * One saved preset in the media library.
 *
 * A swatch rather than a thumbnail: a colour shows its fill, and a title shows the
 * colour it writes in, which is as much of its look as a chip this size can carry.
 *
 * Two ways to place it, matching the toolbar's generators: drag it where you want
 * it, or take it from the menu to put it in at the play head. A preset that could
 * only be dragged was harder to place than the plain title it was saved from.
 */

import { useContextMenu } from './ContextMenu';
import { useDialog } from './Dialog';
import { IconClose, IconPlus, IconText, IconTrash } from './Icons';
import { setDragChip } from './dragChip';
import { PRESET_DRAG_TYPE, usePresets, type ClipPreset } from './presets';
import { useStudio } from './store';

export function PresetCard({
  preset,
  onRemove,
}: {
  preset: ClipPreset;
  onRemove: () => void;
}): React.JSX.Element {
  const setDraggingPreset = useStudio((s) => s.setDraggingPreset);
  const addPresetAtPlayhead = useStudio((s) => s.addPresetAtPlayhead);
  const renamePreset = usePresets((s) => s.rename);
  const menu = useContextMenu();
  const dialog = useDialog();
  const swatch = preset.kind === 'solid' ? preset.fill : preset.style.color;

  const rename = (): void => void (async () => {
    const name = await dialog.prompt({
      title: 'Rename preset',
      inputLabel: 'Preset name',
      initialValue: preset.name,
      confirmLabel: 'Rename',
    });
    const trimmed = name?.trim();
    if (trimmed && trimmed !== preset.name) renamePreset(preset.id, trimmed);
  })();

  const openMenu = (event: React.MouseEvent): void => {
    menu.open(event, [
      {
        label: 'Add at playhead',
        icon: <IconPlus />,
        onSelect: () => addPresetAtPlayhead(preset.id),
      },
      { label: 'Rename…', icon: <IconText />, onSelect: rename },
      'separator',
      {
        // No confirmation, matching the card's own button. Nothing depends on a
        // preset — clips made from one are copies — so losing it costs a re-save
        // rather than any work.
        label: 'Remove',
        icon: <IconTrash />,
        danger: true,
        onSelect: onRemove,
      },
    ]);
  };

  return (
    <div
      className="bin-preset"
      draggable
      title={`${preset.name} — drag onto a video track`}
      onDragStart={(event) => {
        event.dataTransfer.setData(PRESET_DRAG_TYPE, preset.id);
        event.dataTransfer.effectAllowed = 'copy';
        setDragChip(event, preset.name);
        setDraggingPreset(preset.id);
      }}
      onDragEnd={() => setDraggingPreset(null)}
      onContextMenu={openMenu}
      onDoubleClick={() => addPresetAtPlayhead(preset.id)}
    >
      <span className="bin-preset-swatch" style={{ background: swatch }} />
      <span className="bin-preset-name">{preset.name}</span>
      <button
        className="bin-preset-remove"
        title={`Remove "${preset.name}"`}
        aria-label={`Remove ${preset.name}`}
        // The card owns the drag; this must not start one of its own.
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onClick={onRemove}
      >
        <IconClose size={11} />
      </button>
    </div>
  );
}
