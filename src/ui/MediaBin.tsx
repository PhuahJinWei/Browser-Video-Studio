import { useRef, useState } from 'react';
import * as T from '../model/time';
import type { Asset } from '../model/types';
import { useContextMenu } from './ContextMenu';
import { IconAudio, IconFile, IconPlus, IconTrash, IconVideo } from './Icons';
import { useStudio } from './store';
import { ASSET_DRAG_TYPE } from './Timeline';

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
  // Drag events fire for every child crossed, so a plain leave handler flickers.
  // Counting enters and leaves is what keeps the highlight steady.
  const dragDepth = useRef(0);

  const assets = Object.values(history.present.project.assets);

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
        <span>Media</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="icon" title="Import media…" onClick={() => void importViaPicker()}>
          <IconPlus />
        </button>
      </div>

      <div className="panel-body">
        {assets.length === 0 ? (
          <button className="bin-empty" onClick={() => void importViaPicker()}>
            <IconFile size={22} />
            <strong>Drop media anywhere here</strong>
            <span>or click to browse</span>
          </button>
        ) : (
          assets.map((asset) => <AssetCard key={asset.id} asset={asset} />)
        )}
      </div>

      {dragOver && (
        <div className="bin-drop-overlay">
          <IconPlus size={20} />
          Drop to import
        </div>
      )}
    </div>
  );
}

function AssetCard({ asset }: { asset: Asset }): React.JSX.Element {
  const addAssetToTimeline = useStudio((s) => s.addAssetToTimeline);
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
      }}
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
