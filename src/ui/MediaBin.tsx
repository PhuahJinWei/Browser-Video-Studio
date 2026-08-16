import { useRef, useState } from 'react';
import * as T from '../model/time';
import type { Asset } from '../model/types';
import { useStudio } from './store';

/** Import surface and asset list. Nothing here uploads anything. */
export function MediaBin(): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const importFiles = useStudio((s) => s.importFiles);
  const addAssetToTimeline = useStudio((s) => s.addAssetToTimeline);
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
            <AssetCard key={asset.id} asset={asset} onAdd={() => void addAssetToTimeline(asset.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AssetCard({ asset, onAdd }: { asset: Asset; onAdd: () => void }): React.JSX.Element {
  const duration = asset.video?.duration ?? asset.audio?.duration;
  const details: string[] = [];
  if (asset.video) details.push(`${asset.video.size.width}×${asset.video.size.height}`);
  if (asset.video?.frameRate) details.push(`${T.fpsToNumber(asset.video.frameRate).toFixed(2)} fps`);
  if (asset.audio) details.push(`${asset.audio.channels}ch ${asset.audio.sampleRate / 1000} kHz`);
  if (duration) details.push(T.formatDuration(duration, { decimals: 1 }));

  return (
    <div className="bin-item">
      <span className="name">{asset.name}</span>
      <span className="meta">{details.join(' · ')}</span>
      <span className="meta">
        {asset.video ? asset.video.codec : ''} {asset.audio ? asset.audio.codec : ''}
      </span>
      <div className="row">
        <button onClick={onAdd}>Add to timeline</button>
      </div>
    </div>
  );
}
