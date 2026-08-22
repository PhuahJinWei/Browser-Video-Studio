/**
 * Media library.
 *
 * Assets are grouped into folders by a path stored on each one rather than by folder
 * entities. That makes renaming a string edit and deleting a reassignment, at the
 * cost that a folder exists only as long as something is in it — so a folder made
 * before anything is put in it is held here, in this session, until it earns a home.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assetsInFolderTree, childFolders } from '../model/selectors';
import type { Asset, AssetId } from '../model/types';
import { AssetCard } from './AssetCard';
import { useContextMenu } from './ContextMenu';
import { useDialog } from './Dialog';
import { FolderRow, folderName } from './FolderRow';
import {
  IconClose,
  IconFile,
  IconFolderPlus,
  IconFolderUp,
  IconGrid,
  IconList,
  IconPlus,
  IconSearch,
  IconTrash,
} from './Icons';
import { useLayout } from './layout';
import { useStudio } from './store';
import { PresetCard } from './PresetCard';
import { HOVER_DELAY_MS, HoverCard, type HoverCardState } from './Timeline';
import { usePresets } from './presets';
import { hint, tip } from './tooltip';

/**
 * Assets before the search field is worth a row of the panel.
 *
 * Below this everything is on screen already and a search box is just something
 * else to look at; above it, searching across folders is the only way to find
 * anything.
 */
const SEARCH_FROM = 8;

type MediaFilterId = 'all' | 'video' | 'audio' | 'stills';

/**
 * How the Media tab narrows itself. An asset counts as video when it has a video
 * stream, so a file with both appears under Video rather than twice.
 */
const MEDIA_FILTERS: readonly {
  id: MediaFilterId;
  label: string;
  matches: (asset: Asset) => boolean;
}[] = [
  { id: 'all', label: 'All', matches: () => true },
  { id: 'video', label: 'Video', matches: (a) => a.kind === 'video' },
  { id: 'audio', label: 'Audio', matches: (a) => a.kind === 'audio' },
  { id: 'stills', label: 'Stills', matches: (a) => a.kind === 'image' },
];


/**
 * Import surface and asset list. Nothing here uploads anything.
 *
 * The whole panel is the drop target rather than a dedicated box, so a file can be
 * let go anywhere over it.
 */
export function MediaBin(): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const importFiles = useStudio((s) => s.importFiles);
  const importViaPicker = useStudio((s) => s.importViaPicker);
  const selectedAssetIds = useStudio((s) => s.selectedAssetIds);
  const selectAssets = useStudio((s) => s.selectAssets);
  const toggleSelectAsset = useStudio((s) => s.toggleSelectAsset);
  const selectAssetRangeTo = useStudio((s) => s.selectAssetRangeTo);
  const removeAssets = useStudio((s) => s.removeAssets);
  const assetUsage = useStudio((s) => s.assetUsage);
  const moveAssetsToFolder = useStudio((s) => s.moveAssetsToFolder);
  const renameAssetFolder = useStudio((s) => s.renameAssetFolder);
  const previewAsset = useStudio((s) => s.previewAsset);
  const presets = usePresets((s) => s.presets);
  const removePreset = usePresets((s) => s.remove);
  const menu = useContextMenu();
  const dialog = useDialog();

  const [dragOver, setDragOver] = useState(false);
  const [filter, setFilter] = useState<MediaFilterId>('all');
  const [search, setSearch] = useState('');
  const [folder, setFolder] = useState('');
  /**
   * Folders made but not yet filled.
   *
   * A path-on-the-asset scheme cannot store an empty folder, and refusing to make one
   * until something is dropped in is a worse answer than remembering it for the
   * session. They vanish on reload unless something was put in them.
   */
  const [pendingFolders, setPendingFolders] = useState<readonly string[]>([]);

  // Global capture commands can create a still while this panel is filtered or in
  // another folder. Reveal the result so "captured to Library" is visible, not just
  // a status message about an item the user cannot see.
  useEffect(() => {
    const reveal = (): void => {
      setFolder('');
      setFilter('all');
      setSearch('');
    };
    window.addEventListener('bvs:reveal-asset', reveal);
    return () => window.removeEventListener('bvs:reveal-asset', reveal);
  }, []);

  const libraryView = useLayout((s) => s.libraryView);
  const setLibraryView = useLayout((s) => s.setLibraryView);
  // Drag events fire for every child crossed, so a plain leave handler flickers.
  // Counting enters and leaves is what keeps the highlight steady.
  const dragDepth = useRef(0);

  const project = history.present.project;
  const assets = useMemo(() => Object.values(project.assets), [project.assets]);

  const query = search.trim().toLowerCase();
  const folders = useMemo(
    () => childFolders(project, folder, pendingFolders),
    [project, folder, pendingFolders],
  );

  /**
   * What the list is showing, in the order it shows it.
   *
   * A search looks through every folder rather than only the open one — otherwise
   * finding a clip means remembering where you filed it, which is the thing the
   * search box exists to avoid. Folder rows are hidden while searching for the
   * same reason.
   */
  const visible = useMemo(() => {
    const matchesFilter = MEDIA_FILTERS.find((option) => option.id === filter)?.matches;
    return assets
      .filter((asset) => (matchesFilter ? matchesFilter(asset) : true))
      .filter((asset) => (query ? asset.name.toLowerCase().includes(query) : asset.folder === folder))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [assets, filter, query, folder]);

  const visibleIds = useMemo(() => visible.map((asset) => asset.id), [visible]);
  const selectedHere = selectedAssetIds.filter((id) => project.assets[id]);

  const carriesFiles = (event: React.DragEvent): boolean =>
    event.dataTransfer.types.includes('Files');

  /**
   * Delete the selection, taking its clips too once that is confirmed.
   *
   * `removeAsset` refuses an asset that is still cut into the timeline and one
   * refusal discards the whole batch, so the question has to be asked before the
   * command runs rather than reported after it fails.
   */
  const deleteSelected = async (): Promise<void> => {
    if (selectedHere.length === 0) return;

    const usage = assetUsage(selectedHere);
    const used = selectedHere.filter((id) => (usage.get(id) ?? 0) > 0);
    const clipCount = used.reduce((sum, id) => sum + (usage.get(id) ?? 0), 0);

    let withClips = false;
    if (used.length > 0) {
      const subject =
        used.length === selectedHere.length
          ? `${used.length === 1 ? 'That file is' : `All ${used.length} are`}`
          : `${used.length} of ${selectedHere.length} are`;
      withClips = await dialog.confirm({
        title: 'Remove media and timeline clips?',
        message: `${subject} used in the timeline by ${clipCount} clip${clipCount === 1 ? '' : 's'}. Removing the media also removes those clips.`,
        confirmLabel: 'Remove all',
        danger: true,
      });
      if (!withClips) return;
    }
    removeAssets(selectedHere, { withClips });
  };

  const newFolder = async (): Promise<void> => {
    const answer = await dialog.prompt({ title: 'New folder', inputLabel: 'Folder name', initialValue: 'New folder', confirmLabel: 'Create' });
    const name = answer?.trim().replace(/\//g, '-');
    if (!name) return;

    const path = folder ? `${folder}/${name}` : name;
    // Filling it straight away when something is selected is what makes the folder
    // real; otherwise it is remembered until something is dropped into it.
    if (selectedHere.length > 0) moveAssetsToFolder(selectedHere, path);
    else setPendingFolders((current) => [...current, path]);
    setFolder(path);
  };

  const crumbs = folder ? folder.split('/') : [];

  /**
   * The detail card, on the same delay the timeline uses.
   *
   * Dropped the moment a drag starts: a card following the pointer while media is
   * being dragged onto a track would sit over the very lane being aimed at.
   */
  const [hoverCard, setHoverCard] = useState<HoverCardState | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A card is on screen, so movement should not restart its clock. */
  const hoverShown = useRef(false);

  const cancelHover = useCallback((): void => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    hoverShown.current = false;
    setHoverCard(null);
  }, []);

  const startHover = (
    event: React.PointerEvent,
    asset: Asset,
    rows: readonly { label: string; value: string }[],
  ): void => {
    // Dragging media out of the library is a gesture like any other, and already
    // answered cards stay where they are rather than chasing the pointer.
    if (useStudio.getState().draggingAssetId || hoverShown.current) return;
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    const { clientX, clientY } = event;
    hoverTimer.current = setTimeout(() => {
      if (useStudio.getState().draggingAssetId) return;
      hoverShown.current = true;
      setHoverCard({
        subjectId: asset.id,
        clientX,
        clientY,
        title: asset.name,
        subtitle: asset.source?.fileName ?? null,
        rows: [...rows],
      });
    }, HOVER_DELAY_MS);
  };

  /*
   * Drop the card as soon as its card leaves the list.
   *
   * A card that is removed unmounts without ever sending `pointerleave`, so nothing
   * told the hover to end and it stayed on screen describing media that had just been
   * deleted. Watching the visible list rather than only the project catches every way
   * a card can vanish from under the pointer — deleted, filtered out, searched past,
   * or left behind by navigating into a folder.
   */
  useEffect(() => {
    if (hoverCard && !visibleIds.includes(hoverCard.subjectId as AssetId)) cancelHover();
  }, [visibleIds, hoverCard, cancelHover]);

  // A pending card must not land after the panel has gone.
  useEffect(() => cancelHover, [cancelHover]);

  /**
   * Shortcuts, while this panel has focus.
   *
   * Handled here rather than in the global listener because only this component
   * knows what is actually on screen — the folder, the type filter and the search box
   * all narrow the list, and "select all" has to mean the visible ones. Selecting
   * things you cannot see and then deleting them is how work gets lost.
   *
   * Stopping propagation matters as much as handling: Delete used to reach the window
   * listener and remove timeline *clips* while media was selected here, which is the
   * wrong target entirely. Keys this panel does not claim still bubble, so Space keeps
   * playing and the arrows keep stepping.
   */
  const onPanelKeyDown = (event: React.KeyboardEvent): void => {
    // The search field owns its own keys.
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      event.stopPropagation();
      selectAssets(visibleIds);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedHere.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      deleteSelected();
      return;
    }
    if (event.key === 'Escape') {
      if (search) setSearch('');
      else if (selectedHere.length > 0) selectAssets([]);
      else return;
      event.stopPropagation();
      return;
    }
    if (event.key === 'Enter' && selectedHere.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      previewAsset(selectedHere[0]!);
    }
  };

  return (
    <div
      className={`panel media-bin${dragOver ? ' drag-over' : ''}`}
      // Focusable so its shortcuts can be scoped to it. -1 rather than 0: it should
      // be reachable by clicking, not another stop on the way round the Tab order.
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
      onPointerDownCapture={(event) => {
        // Clicking anywhere in the panel makes it the keyboard target, except where
        // a field wants the caret.
        if ((event.target as HTMLElement).tagName !== 'INPUT') {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return;
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        const files = [...event.dataTransfer.files];
        if (files.length > 0) void importFiles(files);
      }}
      onContextMenu={(event) => {
        if (event.target !== event.currentTarget && !(event.target as HTMLElement).closest('.bin-empty')) {
          return;
        }
        menu.open(event, [
          { label: 'Import media…', icon: <IconPlus />, onSelect: () => void importViaPicker() },
          { label: 'New folder…', icon: <IconFolderPlus />, onSelect: newFolder },
        ]);
      }}
    >
      {/*
        No panel head. It cost a row of height to repeat what the tabs below it
        already say, and vertical space in this column is the scarce thing.
      */}
      {/*
        Two tabs rather than one per media type: the panel is too narrow to keep
        five labels legible, and transitions are a library rather than something
        you imported. Within Media the type filter does the narrowing.
      */}
      {/*
        No tab bar. It cost a row of height to switch between a media list and a
        transitions list, and the transitions one has been superseded: every bare cut
        in the timeline carries its own button now, which acts on the cut you are
        pointing at rather than the one nearest where a dragged chip happened to land.
        With that gone a single remaining tab was labelling the obvious.
      */}
      <>
          <div className="bin-header">
            {assets.length > 0 && !query ? (
              <div className="bin-crumbs">
                <button
                  className={`bin-crumb${folder === '' ? ' on' : ''}`}
                  onClick={() => setFolder('')}
                >
                  Library
                </button>
                {crumbs.map((segment, index) => {
                  const path = crumbs.slice(0, index + 1).join('/');
                  return (
                    <span key={path} style={{ display: 'contents' }}>
                      <span className="sep">/</span>
                      <button
                        className={`bin-crumb${path === folder ? ' on' : ''}`}
                        onClick={() => setFolder(path)}
                        onDoubleClick={() => void (async () => {
                          const answer = await dialog.prompt({ title: 'Rename folder', inputLabel: 'Folder name', initialValue: folderName(path), confirmLabel: 'Rename' });
                          const name = answer?.trim().replace(/\//g, '-');
                          if (!name || name === folderName(path)) return;
                          const parent = path.slice(0, path.lastIndexOf('/'));
                          const next = parent ? `${parent}/${name}` : name;
                          renameAssetFolder(path, next);
                          setFolder(next);
                        })()}
                        {...hint('Double-click to rename')}
                      >
                        {segment}
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : (
              <span className="bin-header-title">{query ? 'Search results' : 'Library'}</span>
            )}

          {/*
            One row for the things done *to* the library, rather than a mix of
            per-card buttons and a menu nobody finds. Delete is here because it acts
            on a selection, which nothing in this panel could express before.
          */}
          <div className="bin-actions">
            <button className="icon" {...tip('Import media… (Ctrl+I)')} onClick={() => void importViaPicker()}>
              <IconPlus />
            </button>
            <button className="icon tint-folder" {...tip('New folder…')} onClick={newFolder}>
              <IconFolderPlus />
            </button>
            <button
              className="icon tint-danger"
              {...tip(selectedHere.length > 0
                  ? `Remove ${selectedHere.length} selected from the project`
                  : 'Select media to remove it')}
              disabled={selectedHere.length === 0}
              onClick={deleteSelected}
            >
              <IconTrash />
            </button>
            {selectedHere.length > 0 && <span className="count">{selectedHere.length} selected</span>}
            <button
              className="icon"
              {...tip(libraryView === 'grid' ? 'Show as a list' : 'Show as a grid')}
              onClick={() => setLibraryView(libraryView === 'grid' ? 'list' : 'grid')}
            >
              {libraryView === 'grid' ? <IconList /> : <IconGrid />}
            </button>
          </div>
          </div>

          {/* Kept while a search is live, or deleting assets would hide the field
              with the list still filtered by it and no way to clear it. */}
          {(assets.length >= SEARCH_FROM || search !== '') && (
            <div className="bin-search">
              <IconSearch size={12} />
              <input
                type="text"
                value={search}
                placeholder="Search all folders…"
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setSearch('');
                  event.stopPropagation();
                }}
              />
              {search && (
                <button className="icon clear" {...tip('Clear the search')} onClick={() => setSearch('')}>
                  <IconClose size={11} />
                </button>
              )}
            </div>
          )}

          {assets.length > 0 && (
            <div className="bin-filters">
              {MEDIA_FILTERS.map((option) => {
                const count = assets.filter((asset) => option.matches(asset)).length;
                return (
                  <button
                    key={option.id}
                    className={`bin-filter${filter === option.id ? ' on' : ''}`}
                    // Nothing of that kind imported, so the filter would only ever
                    // show an empty list.
                    disabled={count === 0 && option.id !== 'all'}
                    onClick={() => setFilter(option.id)}
                  >
                    {option.label}
                    {count > 0 && <span className="count">{count}</span>}
                  </button>
                );
              })}
            </div>
          )}
      </>

      <div
        className={`panel-body bin-list ${libraryView}`}
          // Clicking the empty space below the cards drops the selection, the way
          // clicking bare lane does on the timeline.
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) selectAssets([]);
          }}
        >
          {assets.length === 0 ? (
            <button className="bin-empty" onClick={() => void importViaPicker()}>
              <IconFile size={22} />
              <strong>Drop media anywhere here</strong>
              <span>or click to browse</span>
            </button>
          ) : (
            <>
              {/* Up one level, then the folders, then the media itself. */}
              {!query && folder && (
                <button
                  className="bin-folder"
                  onClick={() => setFolder(folder.slice(0, Math.max(0, folder.lastIndexOf('/'))))}
                >
                  <IconFolderUp size={14} />
                  <span className="name">Up one level</span>
                </button>
              )}
              {!query &&
                folders.map((name) => {
                  const path = folder ? `${folder}/${name}` : name;
                  return (
                    <FolderRow
                      key={path}
                      path={path}
                      count={assetsInFolderTree(project, path).length}
                      onOpen={() => setFolder(path)}
                      onDropAssets={(ids) => {
                        moveAssetsToFolder(ids, path);
                        setPendingFolders((current) => current.filter((p) => p !== path));
                      }}
                      onRename={() => void (async () => {
                        const answer = await dialog.prompt({ title: 'Rename folder', inputLabel: 'Folder name', initialValue: name, confirmLabel: 'Rename' });
                        const next = answer?.trim().replace(/\//g, '-');
                        if (!next || next === name) return;
                        renameAssetFolder(path, folder ? `${folder}/${next}` : next);
                        setPendingFolders((current) =>
                          current.map((p) => (p === path ? (folder ? `${folder}/${next}` : next) : p)),
                        );
                      })()}
                    />
                  );
                })}

              {visible.length === 0 ? (
                <p className="hint">
                  {query ? `Nothing matching “${search.trim()}”.` : 'Nothing here yet.'}
                </p>
              ) : (
                visible.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    selected={selectedAssetIds.includes(asset.id)}
                    onHoverStart={startHover}
                    onHoverEnd={cancelHover}
                    onSelect={(modifier) => {
                      if (modifier === 'toggle') toggleSelectAsset(asset.id);
                      else if (modifier === 'range') selectAssetRangeTo(asset.id, visibleIds);
                      else if (!selectedAssetIds.includes(asset.id)) selectAssets([asset.id]);
                    }}
                    onDelete={deleteSelected}
                  />
                ))
              )}
            </>
          )}
      </div>

      {/*
        Presets: looks saved off clips, kept below the media rather than among it.

        They are not media — no file, no duration of their own until placed, nothing
        to relink — so they do not belong in a list that counts, filters and searches
        imported footage. They live outside the project too: a preset is part of a
        person's kit and should still be here in the next project.
      */}
      {presets.length > 0 && (
        <div className="bin-presets">
          <span className="bin-presets-title">Presets</span>
          <div className="bin-preset-row">
            {presets.map((preset) => (
              <PresetCard key={preset.id} preset={preset} onRemove={() => removePreset(preset.id)} />
            ))}
          </div>
        </div>
      )}
      {dragOver && (
        <div className="bin-drop-overlay">
          <IconPlus size={20} />
          Drop to import
        </div>
      )}

      {hoverCard && <HoverCard state={hoverCard} />}
    </div>
  );
}
