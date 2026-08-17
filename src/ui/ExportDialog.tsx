import { useState } from 'react';
import { suggestBitrate, type ExportSettings } from '../engine/export';
import { sequenceDuration } from '../model/selectors';
import * as T from '../model/time';
import { Fader } from './Fader';
import { defaultExportSettings, useStudio } from './store';

const PRESETS = [
  { label: 'Match sequence', scale: 1 },
  { label: '1080p', height: 1080 },
  { label: '720p', height: 720 },
  { label: '480p', height: 480 },
] as const;

export function ExportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const runExport = useStudio((s) => s.runExport);
  const exportProgress = useStudio((s) => s.exportProgress);

  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;
  const [settings, setSettings] = useState<ExportSettings>(() =>
    defaultExportSettings(project, sequenceId),
  );

  const duration = sequenceDuration(project, sequenceId);
  const busy = exportProgress !== null;
  const empty = !T.isPositive(duration);

  const applyHeight = (height: number): void => {
    const aspect = sequence.size.width / sequence.size.height;
    // Encoders reject odd dimensions for most codecs, so round to even.
    const width = Math.round((height * aspect) / 2) * 2;
    const size = { width, height };
    setSettings((s) => ({ ...s, size, bitrate: suggestBitrate(size, s.frameRate) }));
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>Export</h3>

        <div className="field">
          <label>Format</label>
          <select
            value={settings.container}
            disabled={busy}
            onChange={(event) =>
              setSettings((s) => ({ ...s, container: event.target.value as 'mp4' | 'webm' }))
            }
          >
            <option value="mp4">MP4 · H.264 + AAC</option>
            <option value="webm">WebM · VP9 + Opus</option>
          </select>
        </div>

        <div className="field">
          <label>Resolution</label>
          <div className="value-row">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                disabled={busy}
                className={
                  ('height' in preset ? preset.height : sequence.size.height) === settings.size.height
                    ? 'primary'
                    : ''
                }
                onClick={() =>
                  'height' in preset
                    ? applyHeight(preset.height)
                    : setSettings((s) => ({
                        ...s,
                        size: sequence.size,
                        bitrate: suggestBitrate(sequence.size, s.frameRate),
                      }))
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 4 }}>
            {settings.size.width} × {settings.size.height} ·{' '}
            {T.fpsToNumber(settings.frameRate).toFixed(2)} fps ·{' '}
            {(settings.bitrate / 1e6).toFixed(1)} Mbps
          </p>
        </div>

        <div className="field">
          <label>Bitrate</label>
          <div className="value-row">
            {/*
              Marked at the rate suggested for this size and frame rate — the one
              value here that is a genuine recommendation rather than a preference.
            */}
            <Fader
              min={500_000}
              max={40_000_000}
              step={500_000}
              value={settings.bitrate}
              disabled={busy}
              neutral={suggestBitrate(settings.size, settings.frameRate)}
              neutralSnapSteps={1}
              ariaLabel="Export bitrate"
              title={`Suggested for this format: ${(
                suggestBitrate(settings.size, settings.frameRate) / 1e6
              ).toFixed(1)} Mbps`}
              format={(value) => `${(value / 1e6).toFixed(1)} Mbps`}
              onChange={(bitrate) => setSettings((s) => ({ ...s, bitrate }))}
              onReset={() =>
                setSettings((s) => ({ ...s, bitrate: suggestBitrate(s.size, s.frameRate) }))
              }
            />
            <output>{(settings.bitrate / 1e6).toFixed(1)}M</output>
          </div>
        </div>

        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={settings.includeAudio}
              disabled={busy}
              onChange={(event) =>
                setSettings((s) => ({ ...s, includeAudio: event.target.checked }))
              }
              style={{ width: 'auto', marginRight: 6 }}
            />
            Include audio
          </label>
        </div>

        <p className="hint">
          {empty
            ? 'The timeline is empty.'
            : `${T.formatDuration(duration, { decimals: 1 })} · about ${T.ceilFrames(
                duration,
                settings.frameRate,
              )} frames. Everything is encoded on this machine.`}
        </p>

        {exportProgress && (
          <>
            <div className="progress">
              <div style={{ width: `${exportProgress.overall * 100}%` }} />
            </div>
            <p className="hint">
              {exportProgress.stage} · {exportProgress.framesEncoded}/{exportProgress.totalFrames}{' '}
              frames · {exportProgress.fps.toFixed(1)} fps
            </p>
          </>
        )}

        <div className="actions">
          <button onClick={onClose} disabled={busy}>
            {busy ? 'Working…' : 'Cancel'}
          </button>
          <button
            className="primary"
            disabled={busy || empty}
            onClick={() => void runExport(settings)}
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
