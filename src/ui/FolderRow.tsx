/**
 * A folder in the media library, and the name it shows.
 *
 * Folders are a path stored on each asset rather than entities of their own, so a
 * row is a filter over the list and a drop target that rewrites that path.
 */

import { useState } from 'react';
import { useContextMenu } from './ContextMenu';
import { IconFolder } from './Icons';
import { useStudio } from './store';
import type { AssetId } from '../model/types';
import { ASSET_DRAG_TYPE } from './Timeline';
/** Last segment of a folder path — what the row is labelled with. */
export function folderName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** A folder in the list. Doubles as a drop target for filing media into it. */
export function FolderRow({
  path,
  count,
  onOpen,
  onDropAssets,
  onRename,
}: {
  path: string;
  count: number;
  onOpen: () => void;
  onDropAssets: (assetIds: readonly AssetId[]) => void;
  onRename: () => void;
}): React.JSX.Element {
  const [over, setOver] = useState(false);
  const menu = useContextMenu();

  return (
    <button
      className={`bin-folder${over ? ' drop-target' : ''}`}
      onClick={onOpen}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        const dropped = event.dataTransfer.getData(ASSET_DRAG_TYPE);
        setOver(false);
        if (!dropped) return;
        event.preventDefault();
        event.stopPropagation();

        // Dragging one of several selected cards files the whole selection; dragging
        // an unselected one files only itself.
        const selection = useStudio.getState().selectedAssetIds;
        onDropAssets(
          selection.includes(dropped as AssetId) ? selection : [dropped as AssetId],
        );
      }}
      onContextMenu={(event) =>
        menu.open(event, [
          { label: 'Open', icon: <IconFolder />, onSelect: onOpen },
          { label: 'Rename folder…', onSelect: onRename },
        ])
      }
      title={`${path} — ${count} item${count === 1 ? '' : 's'}`}
    >
      <IconFolder size={14} />
      <span className="name">{folderName(path)}</span>
      <span className="count">{count}</span>
    </button>
  );
}
