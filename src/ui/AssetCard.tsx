/**
 * One asset in the media library.
 *
 * Carries its own context menu and the drag that takes it to the timeline; the
 * panel above only says which are selected and hands back the hover card.
 */

import * as T from '../model/time';
import type { Asset } from '../model/types';
import { useContextMenu } from './ContextMenu';
import { setDragChip } from './dragChip';
import {
  IconAlert,
  IconAudio,
  IconDownload,
  IconFile,
  IconLink,
  IconPlus,
  IconTrash,
  IconVideo,
} from './Icons';
import { useStudio } from './store';
import { ASSET_DRAG_TYPE } from './Timeline';
const ASSET_KIND_LABELS: Record<string, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Still',
  sequence: 'Sequence',
};


export function AssetCard({
  asset,
  selected,
  onSelect,
  onDelete,
  onHoverStart,
  onHoverEnd,
}: {
  asset: Asset;
  selected: boolean;
  onSelect: (modifier: 'replace' | 'toggle' | 'range') => void;
  onDelete: () => void;
  onHoverStart: (
    event: React.PointerEvent,
    asset: Asset,
    rows: readonly { label: string; value: string }[],
  ) => void;
  onHoverEnd: () => void;
}): React.JSX.Element {
  const addAssetToTimeline = useStudio((s) => s.addAssetToTimeline);
  const previewAsset = useStudio((s) => s.previewAsset);
  const downloadAsset = useStudio((s) => s.downloadAsset);
  const relinkAsset = useStudio((s) => s.relinkAsset);
  const generateProxy = useStudio((s) => s.generateProxy);
  const removeProxy = useStudio((s) => s.removeProxy);
  const proxyProgress = useStudio((s) => s.proxyProgress.get(asset.id));
  const setDraggingAsset = useStudio((s) => s.setDraggingAsset);
  const previews = useStudio((s) => s.previews);
  // Previews land asynchronously; this re-renders the card when one does, and again
  // on every step of its progress.
  useStudio((s) => s.previewVersion);
  const menu = useContextMenu();

  const duration = asset.video?.duration ?? asset.audio?.duration;
  // One picture per card, made once and kept: a video's first frame, or a whole-file
  // waveform for a sound. Unlike the lanes, a card never changes with zoom.
  const poster = previews?.getPosterUrl(asset.id) ?? null;
  const progress = previews?.getPeaksProgress(asset.id) ?? null;
  const missing = asset.status.state === 'missing';

  /*
   * Every detail the meta line used to carry, and several it did not.
   *
   * The line under each card is gone — it repeated what the thumbnail already showed
   * and cost a row on every card in the grid. Resting on the card gives all of it,
   * with room for the things that never fitted.
   */
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: 'Kind', value: ASSET_KIND_LABELS[asset.kind] ?? asset.kind });
  if (duration) rows.push({ label: 'Duration', value: T.formatDuration(duration, { decimals: 2 }) });
  if (asset.video) {
    // Stills carry a nominal video stream for timeline placement, but their image
    // metadata below is the authoritative size. Reporting both produces duplicate
    // rows (and duplicate React keys) for every captured frame.
    if (!asset.image) {
      rows.push({ label: 'Size', value: `${asset.video.size.width}×${asset.video.size.height}` });
    }
    if (asset.video.frameRate) {
      rows.push({ label: 'Frame rate', value: `${T.fpsToNumber(asset.video.frameRate).toFixed(2)} fps` });
    }
    if (asset.video.codec) rows.push({ label: 'Codec', value: asset.video.codec });
  }
  if (asset.image) rows.push({ label: 'Size', value: `${asset.image.size.width}×${asset.image.size.height}` });
  if (asset.audio) {
    rows.push({
      label: 'Audio',
      value: `${asset.audio.channels} ch · ${asset.audio.sampleRate / 1000} kHz`,
    });
  }
  if (asset.source) {
    rows.push({ label: 'Size on disk', value: `${(asset.source.byteLength / 1e6).toFixed(1)} MB` });
  }
  rows.push({ label: 'Folder', value: asset.folder || 'Library' });
  if (missing) rows.push({ label: 'Media', value: 'Missing — relink the source file' });
  if (progress !== null) rows.push({ label: 'Preview', value: `${Math.round(progress * 100)}%` });
  if (proxyProgress !== undefined) rows.push({ label: 'Proxy', value: `${Math.round(proxyProgress * 100)}%` });
  else if (asset.derived.proxySize) {
    rows.push({ label: 'Proxy', value: `${asset.derived.proxySize.width}×${asset.derived.proxySize.height} · active for playback` });
  }

  const onContextMenu = (event: React.MouseEvent): void => {
    // Right-clicking outside the selection acts on what was clicked, which is what
    // every file manager does and what stops a stray delete taking the wrong thing.
    if (!selected) onSelect('replace');
    const count = useStudio.getState().selectedAssetIds.length;

    menu.open(event, [
      ...(missing
        ? [{
            label: 'Relink media…',
            icon: <IconLink />,
            onSelect: () => void relinkAsset(asset.id),
          }]
        : []),
      {
        label: 'Add to timeline',
        icon: <IconPlus />,
        disabled: missing,
        onSelect: () => void addAssetToTimeline(asset.id),
      },
      {
        label: 'Download original…',
        icon: <IconDownload />,
        disabled: missing || count > 1,
        onSelect: () => void downloadAsset(asset.id),
      },
      ...(asset.kind === 'video' && !missing
        ? [{
            label: proxyProgress !== undefined
              ? 'Cancel proxy generation'
              : asset.derived.proxyPath
                ? 'Remove proxy'
                : 'Generate editing proxy',
            icon: <IconVideo />,
            onSelect: () => void (
              proxyProgress !== undefined || asset.derived.proxyPath
                ? removeProxy(asset.id)
                : generateProxy(asset.id)
            ),
          }]
        : []),
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
        setDragChip(event, asset.name);
        // dragover cannot read dataTransfer, so the timeline ghost needs this to
        // know the asset's duration while the drag is in flight.
        setDraggingAsset(asset.id);
      }}
      onDragEnd={() => {
        setDraggingAsset(null);
        onHoverEnd();
      }}
      onPointerDown={(event) =>
        onSelect(
          event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace',
        )
      }
      onPointerEnter={(event) => onHoverStart(event, asset, rows)}
      // As on the timeline: the wait is for the pointer to settle, not merely to
      // have arrived.
      onPointerMove={(event) => onHoverStart(event, asset, rows)}
      onPointerLeave={onHoverEnd}
      onContextMenu={onContextMenu}
      onDoubleClick={() => previewAsset(asset.id)}
      // No `title`: the hover card replaces it, and both at once shows a styled card
      // with the browser's own tooltip appearing on top a moment later.
    >
      {/* Only stills can carry alpha; a video or a waveform would just be hidden by
          its own opaque poster, so the checker would be decoration rather than fact. */}
      <div className={`bin-thumb${asset.kind === 'image' ? ' checkered' : ''}`}>
        {poster ? (
          <div
            className={`bin-thumb-image${asset.video ? '' : ' wave'}`}
            style={{
              backgroundImage: `url(${poster})`,
              backgroundSize: asset.video ? 'cover' : '100% 70%',
            }}
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
        {asset.derived.proxyPath && !missing && (
          <span className="bin-badge-proxy">Proxy</span>
        )}
        {/* Only while it is actually being built; a bar left at full reads as stuck. */}
        {progress !== null && (
          <div className="bin-progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {proxyProgress !== undefined && (
          <div className="bin-progress proxy">
            <div style={{ width: `${Math.round(proxyProgress * 100)}%` }} />
          </div>
        )}
      </div>

      {/* The meta line is gone; resting on the card gives all of it and more. */}
      <span className="name">{asset.name}</span>
    </div>
  );
}
