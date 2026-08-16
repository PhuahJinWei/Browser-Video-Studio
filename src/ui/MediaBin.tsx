/**
 * Media library.
 *
 * Assets are grouped into folders by a path stored on each one rather than by folder
 * entities. That makes renaming a string edit and deleting a reassignment, at the
 * cost that a folder exists only as long as something is in it — so a folder made
 * before anything is put in it is held here, in this session, until it earns a home.
 */

import { useMemo, useRef, useState } from 'react';
import { assetsInFolderTree, childFolders } from '../model/selectors';
import * as T from '../model/time';
import { TRANSITION_TYPES } from '../model/types';
import type { Asset, AssetId } from '../model/types';
import { useContextMenu } from './ContextMenu';
import {
  IconAlert,
  IconAudio,
  IconClose,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconFolderUp,
  IconGrid,
  IconList,
  IconPlus,
  IconSearch,
  IconTransition,
  IconTrash,
  IconVideo,
} from './Icons';
import { useLayout } from './layout';
import { useStudio } from './store';
import { ASSET_DRAG_TYPE } from './Timeline';
import { TRANSITION_DRAG_TYPE, TRANSITION_LABELS } from './transitions';

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

/** Last segment of a folder path — what the row is labelled with. */
function folderName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

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
  const menu = useContextMenu();

  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab] = useState<'media' | 'transitions'>('media');
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
  const deleteSelected = (): void => {
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
      withClips = confirm(
        `${subject} used in the timeline by ${clipCount} clip${clipCount === 1 ? '' : 's'}.\n\n` +
          `OK removes those clips as well. Cancel leaves everything alone.`,
      );
      if (!withClips) return;
    }
    removeAssets(selectedHere, { withClips });
  };

  const newFolder = (): void => {
    const answer = prompt('Folder name', 'New folder');
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

  return (
    <div
      className={`panel media-bin${dragOver ? ' drag-over' : ''}`}
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
      <div className="panel-head">
        <span>Library</span>
        <span className="spacer" style={{ flex: 1 }} />
      </div>

      {/*
        Two tabs rather than one per media type: the panel is too narrow to keep
        five labels legible, and transitions are a library rather than something
        you imported. Within Media the type filter does the narrowing.
      */}
      <div className="panel-tabs">
        {(['media', 'transitions'] as const).map((name) => (
          <button
            key={name}
            className={`panel-tab${tab === name ? ' on' : ''}`}
            onClick={() => setTab(name)}
          >
            {name === 'media' ? `Media${assets.length > 0 ? ` (${assets.length})` : ''}` : 'Transitions'}
          </button>
        ))}
      </div>

      {tab === 'media' && (
        <>
          {/*
            One row for the things done *to* the library, rather than a mix of
            per-card buttons and a menu nobody finds. Delete is here because it acts
            on a selection, which nothing in this panel could express before.
          */}
          <div className="bin-actions">
            <button className="icon" title="Import media… (Ctrl+I)" onClick={() => void importViaPicker()}>
              <IconPlus />
            </button>
            <button className="icon" title="New folder…" onClick={newFolder}>
              <IconFolderPlus />
            </button>
            <button
              className="icon"
              title={
                selectedHere.length > 0
                  ? `Remove ${selectedHere.length} selected from the project`
                  : 'Select media to remove it'
              }
              disabled={selectedHere.length === 0}
              onClick={deleteSelected}
            >
              <IconTrash />
            </button>
            {selectedHere.length > 0 && <span className="count">{selectedHere.length} selected</span>}
            <span className="spacer" />
            <button
              className="icon"
              title={libraryView === 'grid' ? 'Show as a list' : 'Show as a grid'}
              onClick={() => setLibraryView(libraryView === 'grid' ? 'list' : 'grid')}
            >
              {libraryView === 'grid' ? <IconList /> : <IconGrid />}
            </button>
          </div>

          {assets.length > 0 && (
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
                <button className="icon clear" title="Clear the search" onClick={() => setSearch('')}>
                  <IconClose size={11} />
                </button>
              )}
            </div>
          )}

          {assets.length > 0 && !query && (
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
                      onDoubleClick={() => {
                        const answer = prompt('Rename folder', folderName(path));
                        const name = answer?.trim().replace(/\//g, '-');
                        if (!name || name === folderName(path)) return;
                        const parent = path.slice(0, path.lastIndexOf('/'));
                        const next = parent ? `${parent}/${name}` : name;
                        renameAssetFolder(path, next);
                        setFolder(next);
                      }}
                      title="Double-click to rename"
                    >
                      {segment}
                    </button>
                  </span>
                );
              })}
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
      )}

      {tab === 'media' ? (
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
                      onRename={() => {
                        const answer = prompt('Rename folder', name);
                        const next = answer?.trim().replace(/\//g, '-');
                        if (!next || next === name) return;
                        renameAssetFolder(path, folder ? `${folder}/${next}` : next);
                        setPendingFolders((current) =>
                          current.map((p) => (p === path ? (folder ? `${folder}/${next}` : next) : p)),
                        );
                      }}
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
                    // Search results span folders, so the path is worth showing.
                    showFolder={Boolean(query) && asset.folder !== ''}
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
      ) : (
        <div className="panel-body">
          <TransitionLibrary />
        </div>
      )}

      {dragOver && (
        <div className="bin-drop-overlay">
          <IconPlus size={20} />
          Drop to import
        </div>
      )}
    </div>
  );
}

/** A folder in the list. Doubles as a drop target for filing media into it. */
function FolderRow({
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

/**
 * The transition styles, draggable onto a cut.
 *
 * Right-clicking a clip is quicker once you know it is there, but nothing on
 * screen said transitions existed at all — which is the usual reason a feature
 * goes unused.
 */
function TransitionLibrary(): React.JSX.Element {
  const addTransitionNearPlayhead = useStudio((s) => s.addTransitionNearPlayhead);

  return (
    <div className="transition-library open">
      <p className="hint">
        Drag one onto a cut, or double-click to use the cut nearest the playhead.
      </p>

      {(
        <div className="library-body">
          {TRANSITION_TYPES.map((type) => (
            <div
              key={type}
              className="transition-chip"
              draggable
              title={`Drag onto a cut, or double-click to use the cut nearest the playhead`}
              onDragStart={(event) => {
                event.dataTransfer.setData(TRANSITION_DRAG_TYPE, type);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onDoubleClick={() => addTransitionNearPlayhead(type)}
            >
              <IconTransition size={13} />
              <span>{TRANSITION_LABELS[type]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssetCard({
  asset,
  selected,
  showFolder,
  onSelect,
  onDelete,
}: {
  asset: Asset;
  selected: boolean;
  showFolder: boolean;
  onSelect: (modifier: 'replace' | 'toggle' | 'range') => void;
  onDelete: () => void;
}): React.JSX.Element {
  const addAssetToTimeline = useStudio((s) => s.addAssetToTimeline);
  const setDraggingAsset = useStudio((s) => s.setDraggingAsset);
  const previews = useStudio((s) => s.previews);
  // Previews land asynchronously; this re-renders the card when one does, and again
  // on every step of its progress.
  useStudio((s) => s.previewVersion);
  const menu = useContextMenu();

  const duration = asset.video?.duration ?? asset.audio?.duration;
  const film = previews?.getFilmstrip(asset.id);
  const wave = previews?.getWaveform(asset.id);
  const progress = previews?.getProgress(asset.id) ?? null;
  const missing = asset.status.state === 'missing';

  const details: string[] = [];
  if (asset.video) details.push(`${asset.video.size.width}×${asset.video.size.height}`);
  if (asset.video?.frameRate) details.push(`${T.fpsToNumber(asset.video.frameRate).toFixed(2)} fps`);
  if (asset.audio) details.push(`${asset.audio.channels}ch`);
  if (asset.kind === 'image') details.push('still');
  if (showFolder) details.push(asset.folder);

  const onContextMenu = (event: React.MouseEvent): void => {
    // Right-clicking outside the selection acts on what was clicked, which is what
    // every file manager does and what stops a stray delete taking the wrong thing.
    if (!selected) onSelect('replace');
    const count = useStudio.getState().selectedAssetIds.length;

    menu.open(event, [
      {
        label: 'Add to timeline',
        icon: <IconPlus />,
        disabled: missing,
        onSelect: () => void addAssetToTimeline(asset.id),
      },
      'separator',
      {
        label: count > 1 ? `Remove ${count} from project` : 'Remove from project',
        icon: <IconTrash />,
        danger: true,
        onSelect: onDelete,
      },
    ]);
  };

  return (
    <div
      className={`bin-item${selected ? ' selected' : ''}`}
      // Native drag-and-drop rather than pointer events: the gesture crosses from
      // this panel into the timeline, and the browser's own drag image and drop
      // handling deal with that cleanly.
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
        event.dataTransfer.effectAllowed = 'copyMove';
        // dragover cannot read dataTransfer, so the timeline ghost needs this to
        // know the asset's duration while the drag is in flight.
        setDraggingAsset(asset.id);
      }}
      onDragEnd={() => setDraggingAsset(null)}
      onPointerDown={(event) =>
        onSelect(
          event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace',
        )
      }
      onContextMenu={onContextMenu}
      onDoubleClick={() => void addAssetToTimeline(asset.id)}
      title={
        missing
          ? `${asset.name}\nThe file could not be found — re-import it`
          : `${asset.name}\nDrag onto a track, or double-click to append`
      }
    >
      <div className="bin-thumb">
        {film ? (
          // A dedicated poster rendered in the same decode pass as the filmstrip:
          // the strip's own frames are ~78px wide and look soft blown up to card size.
          <div
            className="bin-thumb-image"
            style={{ backgroundImage: `url(${film.posterUrl})`, backgroundSize: 'cover' }}
          />
        ) : wave ? (
          <div
            className="bin-thumb-image wave"
            style={{ backgroundImage: `url(${wave.url})`, backgroundSize: '100% 70%' }}
          />
        ) : (
          <div className={`bin-thumb-placeholder${progress !== null ? ' pending' : ''}`}>
            {asset.video ? <IconVideo size={20} /> : asset.audio ? <IconAudio size={20} /> : <IconFile size={20} />}
          </div>
        )}
        {duration && <span className="bin-duration">{T.formatDuration(duration, { decimals: 0 })}</span>}
        <span className="bin-kind">{asset.video ? <IconVideo size={11} /> : <IconAudio size={11} />}</span>
        {missing && (
          <span className="bin-badge-missing">
            <IconAlert size={9} /> Missing
          </span>
        )}
        {/* Only while it is actually being built; a bar left at full reads as stuck. */}
        {progress !== null && (
          <div className="bin-progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>

      <span className="name" title={asset.name}>
        {asset.name}
      </span>
      <span className="meta">{details.join(' · ')}</span>
    </div>
  );
}
