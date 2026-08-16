import { useRef, useState } from 'react';
import * as T from '../model/time';
import type { Asset } from '../model/types';
import { useContextMenu } from './ContextMenu';
import { IconAudio, IconFile, IconPlus, IconTrash, IconVideo } from './Icons';
import { useStudio } from './store';

/** Import surface and asset list. Nothing here uploads anything. */
export function MediaBin(): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const importFiles = useStudio((s) => s.importFiles);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const assets = Object.values(history.present.project.assets);

  const handleFiles = (list: FileList | null): void => {
    if (!list || list.length === 0) return;
    void importFiles([...list]);
  };

  return (
    <div className="panel">
      <div className="panel-head">Media</div>
      <div className="panel-body">
        <div
          className={`dropzone${dragOver ? ' over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            handleFiles(event.dataTransfer.files);
          }}
        >
          Drop media here
          <br />
          or click to browse
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="video/*,audio/*"
          multiple
          hidden
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <div style={{ marginTop: 10 }}>
          {assets.length === 0 && <p className="hint">No media imported yet.</p>}
          {assets.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      </div>
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
      onContextMenu={onContextMenu}
      onDoubleClick={() => void addAssetToTimeline(asset.id)}
      title={`${asset.name}\nDouble-click to add · right-click for options`}
    >
      <div className="bin-thumb">
        {film ? (
          // Show the strip's first frame: the filmstrip is already in memory, so a
          // separate poster image would be a second decode for no benefit.
          <div
            className="bin-thumb-image"
            style={{
              backgroundImage: `url(${film.url})`,
              backgroundSize: `${film.frameCount * 100}% 100%`,
              backgroundPosition: 'left center',
            }}
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

      <div className="row">
        <button onClick={() => void addAssetToTimeline(asset.id)}>
          <IconPlus /> Add to timeline
        </button>
      </div>
    </div>
  );
}
