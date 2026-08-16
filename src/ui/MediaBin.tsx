import { useRef, useState } from 'react';
import * as T from '../model/time';
import { TRANSITION_TYPES } from '../model/types';
import type { Asset } from '../model/types';
import { useContextMenu } from './ContextMenu';
import { IconAudio, IconFile, IconPlus, IconTransition, IconTrash, IconVideo } from './Icons';
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
  const menu = useContextMenu();
  const [dragOver, setDragOver] = useState(false);
  const [tab, setTab] = useState<'media' | 'transitions'>('media');
  const [filter, setFilter] = useState<MediaFilterId>('all');
  // Drag events fire for every child crossed, so a plain leave handler flickers.
  // Counting enters and leaves is what keeps the highlight steady.
  const dragDepth = useRef(0);

  const assets = Object.values(history.present.project.assets);
  const visible = assets.filter(
    (asset) => MEDIA_FILTERS.find((option) => option.id === filter)?.matches(asset) ?? true,
  );

  const carriesFiles = (event: React.DragEvent): boolean =>
    event.dataTransfer.types.includes('Files');

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
        ]);
      }}
    >
      <div className="panel-head">
        <span>Library</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="icon" title="Import media…" onClick={() => void importViaPicker()}>
          <IconPlus />
        </button>
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

      {tab === 'media' && assets.length > 0 && (
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

      {tab === 'media' ? (
        <div className="panel-body">
          {assets.length === 0 ? (
            <button className="bin-empty" onClick={() => void importViaPicker()}>
              <IconFile size={22} />
              <strong>Drop media anywhere here</strong>
              <span>or click to browse</span>
            </button>
          ) : visible.length === 0 ? (
            <p className="hint">Nothing of that kind yet.</p>
          ) : (
            visible.map((asset) => <AssetCard key={asset.id} asset={asset} />)
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

function AssetCard({ asset }: { asset: Asset }): React.JSX.Element {
  const addAssetToTimeline = useStudio((s) => s.addAssetToTimeline);
  const setDraggingAsset = useStudio((s) => s.setDraggingAsset);
  const run = useStudio((s) => s.run);
  const previews = useStudio((s) => s.previews);
  // Previews land asynchronously; this re-renders the card when one does.
  useStudio((s) => s.previewVersion);
  const menu = useContextMenu();

  const duration = asset.video?.duration ?? asset.audio?.duration;
  const film = previews?.getFilmstrip(asset.id);
  const wave = previews?.getWaveform(asset.id);

  const details: string[] = [];
  if (asset.video) details.push(`${asset.video.size.width}×${asset.video.size.height}`);
  if (asset.video?.frameRate) details.push(`${T.fpsToNumber(asset.video.frameRate).toFixed(2)} fps`);
  if (asset.audio) details.push(`${asset.audio.channels}ch`);
  if (asset.kind === 'image') details.push('still');

  const onContextMenu = (event: React.MouseEvent): void =>
    menu.open(event, [
      {
        label: 'Add to timeline',
        icon: <IconPlus />,
        onSelect: () => void addAssetToTimeline(asset.id),
      },
      'separator',
      {
        label: 'Remove from project',
        icon: <IconTrash />,
        danger: true,
        onSelect: () => run({ type: 'removeAsset', assetId: asset.id }, 'Remove asset'),
      },
    ]);

  return (
    <div
      className="bin-item"
      // Native drag-and-drop rather than pointer events: the gesture crosses from
      // this panel into the timeline, and the browser's own drag image and drop
      // handling deal with that cleanly.
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
        event.dataTransfer.effectAllowed = 'copy';
        // dragover cannot read dataTransfer, so the timeline ghost needs this to
        // know the asset's duration while the drag is in flight.
        setDraggingAsset(asset.id);
      }}
      onDragEnd={() => setDraggingAsset(null)}
      onContextMenu={onContextMenu}
      onDoubleClick={() => void addAssetToTimeline(asset.id)}
      title={`${asset.name}\nDrag onto a track, or double-click to append`}
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
          <div className="bin-thumb-placeholder">
            {asset.video ? <IconVideo size={20} /> : asset.audio ? <IconAudio size={20} /> : <IconFile size={20} />}
          </div>
        )}
        {duration && <span className="bin-duration">{T.formatDuration(duration, { decimals: 0 })}</span>}
        <span className="bin-kind">{asset.video ? <IconVideo size={11} /> : <IconAudio size={11} />}</span>
      </div>

      <span className="name" title={asset.name}>
        {asset.name}
      </span>
      <span className="meta">{details.join(' · ')}</span>
    </div>
  );
}
