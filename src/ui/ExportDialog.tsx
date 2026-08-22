/**
 * Export.
 *
 * The dialog asks the one question a person can answer — where is this file going —
 * and derives the seven it cannot from it. Container, codec, resolution, frame rate,
 * quality, bitrate and audio rate all follow from a preset, and all of them are
 * still there underneath, pre-filled, behind a disclosure. Someone who wants to nudge
 * the bitrate is one click away; someone who does not should never learn that H.265
 * exists.
 *
 * Quality, not bitrate, is the control the eye should land on when they do open it.
 * Bits per second is a number whose meaning depends on frame size, frame rate and
 * codec all at once, so the same 8 Mbps is generous at 720p and thin at 4K; a quality
 * level holds still across all three and the bitrate follows from it. The slider is
 * still there for anyone who wants it, and taking hold of it is what switches the
 * derivation off.
 *
 * The estimate and the progress bar sit in a head that does not scroll, and the
 * buttons in a foot that does not either. A dialog this tall does not fit a laptop
 * screen, and the two things a person needs while it is open — how big will this be,
 * and how do I stop it — are exactly the two that must never be below the fold.
 */

import { useEffect, useState } from 'react';
import {
  AUDIO_BITRATES,
  CONTAINERS,
  defaultVideoCodec,
  detectExportSupport,
  estimateExportBytes,
  EXPORT_QUALITIES,
  suggestBitrate,
  videoCodecChoice,
  type ContainerKey,
  type ExportQuality,
  type ExportSettings,
  type ExportSupport,
} from '../engine/export';
import { markedRange, sequenceDuration } from '../model/selectors';
import * as T from '../model/time';
import type { FrameRate } from '../model/types';
import {
  EXPORT_PRESETS,
  exportPreset,
  presetFor,
  presetSettings,
  PRESET_CONTAINER,
  resolutionActive,
  type ExportPresetKey,
} from './exportPresets';
import { useModalShell } from './modalShell';
import { Fader } from './Fader';
import { IconDisclosure } from './Icons';
import { defaultExportSettings, formatBytes, useStudio } from './store';

const RESOLUTIONS = [
  { label: 'Match sequence', height: null },
  { label: '2160p', height: 2160 },
  { label: '1080p', height: 1080 },
  { label: '720p', height: 720 },
  { label: '480p', height: 480 },
] as const;

/** The rates worth offering, including the broadcast fractions the model can express. */
const FRAME_RATES: readonly { readonly key: string; readonly label: string; readonly rate: FrameRate }[] = [
  { key: '23.976', label: '23.976', rate: T.FPS_23_976 },
  { key: '24', label: '24', rate: T.FPS_24 },
  { key: '25', label: '25', rate: T.FPS_25 },
  { key: '29.97', label: '29.97', rate: T.FPS_29_97 },
  { key: '30', label: '30', rate: T.FPS_30 },
  { key: '50', label: '50', rate: T.FPS_50 },
  { key: '59.94', label: '59.94', rate: T.FPS_59_94 },
  { key: '60', label: '60', rate: T.FPS_60 },
];

/** Cross-multiplied, so 30/1 and 60/2 are one rate rather than two. */
function sameRate(a: FrameRate, b: FrameRate): boolean {
  return a.num * b.den === b.num * a.den;
}

/** Rates below a megabit read as "0.7 Mbps", which is a worse answer than "746 kbps". */
function formatBitrate(bitsPerSecond: number): string {
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1e6).toFixed(1)} Mbps`
    : `${Math.round(bitsPerSecond / 1000)} kbps`;
}

export function ExportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const runExport = useStudio((s) => s.runExport);
  const cancelExport = useStudio((s) => s.cancelExport);
  const exportProgress = useStudio((s) => s.exportProgress);
  const exportBusy = useStudio((s) => s.exportBusy);

  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;
  const [settings, setSettings] = useState<ExportSettings>(() =>
    defaultExportSettings(project, sequenceId),
  );
  /** 'custom' once the slider has been moved: the derivation below then stands aside. */
  const [quality, setQuality] = useState<ExportQuality | 'custom'>('medium');
  const [support, setSupport] = useState<ExportSupport | null>(null);
  /** Closed until asked for, or until Custom is chosen — which is the same request. */
  const [showSettings, setShowSettings] = useState(false);

  const marked = markedRange(project, sequenceId);
  /*
   * Marks win when they exist.
   *
   * Setting In and Out on the program timeline is a deliberate act with exactly one
   * purpose — scoping something — so honouring them is what was asked for, and it is
   * what the other editors do. The choice is never silent: the range sits above the
   * controls and the duration in the summary is the ranged one.
   */
  const [useMarks, setUseMarks] = useState(marked !== null);

  const busy = exportBusy;
  const whole = sequenceDuration(project, sequenceId);
  const range = useMarks ? marked : null;
  const duration = range ? T.sub(range.end, range.start) : whole;
  const empty = !T.isPositive(duration);
  const container = CONTAINERS[settings.container];
  const codec = videoCodecChoice(settings.container, settings.videoCodec);

  /*
   * One place owns "the bitrate follows the quality", so every control that feeds it —
   * resolution, frame rate, codec, the quality buttons themselves, and the automatic
   * fallbacks below — gets the right rate without each having to remember to ask.
   */
  useEffect(() => {
    if (quality === 'custom') return;
    setSettings((s) => {
      const bitrate = suggestBitrate(s.size, s.frameRate, s.videoCodec, quality);
      return s.bitrate === bitrate ? s : { ...s, bitrate };
    });
  }, [quality, settings.size, settings.frameRate, settings.videoCodec]);

  /*
   * Encoder support is a property of the exact configuration, so it is re-probed
   * whenever the shape of the job changes. Deliberately not on bitrate: it almost
   * never decides encodability, and including it would fire a probe — and blank this
   * panel to "checking…" — on every frame of a slider drag.
   */
  useEffect(() => {
    let current = true;
    setSupport(null);
    void detectExportSupport(settings).then((result) => {
      if (!current) return;
      setSupport(result);
      setSettings((value) => {
        let next = value;
        if (!result[next.container]) {
          const fallback: ContainerKey = next.container === 'mp4' ? 'webm' : 'mp4';
          if (result[fallback]) {
            next = { ...next, container: fallback, videoCodec: defaultVideoCodec(fallback) };
          }
        }
        // A codec with no encoder behind it is not a choice. Fall back to the most
        // compatible one this container offers that the machine can actually write.
        if (result.videoCodecs[next.videoCodec] === false) {
          const usable = CONTAINERS[next.container].video.find(
            (choice) => result.videoCodecs[choice.codec] !== false,
          );
          if (usable) next = { ...next, videoCodec: usable.codec };
        }
        return next;
      });
    });
    return () => {
      current = false;
    };
  }, [
    settings.container,
    settings.size.width,
    settings.size.height,
    settings.frameRate.num,
    settings.frameRate.den,
    settings.includeAudio,
    settings.audioBitrate,
  ]);

  /*
   * The format the presets speak in.
   *
   * MP4 unless this browser cannot write one, in which case the presets are expressed
   * in whatever it can — a machine without an MP4 encoder should still be offered
   * "Share online", not three buttons that never light up.
   */
  const presetContainer: ContainerKey =
    support && !support[PRESET_CONTAINER] && support.webm ? 'webm' : PRESET_CONTAINER;

  /*
   * Derived, not remembered. Anything moved underneath — a codec, a resolution, the
   * bitrate slider — drops the highlight to Custom on its own, so the selected button
   * cannot go on claiming something the settings no longer say.
   */
  const derivedPreset = presetFor(
    settings,
    quality,
    sequence.size,
    sequence.frameRate,
    presetContainer,
  );

  /*
   * Except when Custom was asked for outright.
   *
   * Pressing Custom changes no setting — it opens the panel and hands over — so the
   * derivation went on reporting whichever preset the untouched settings still matched,
   * and the button that had just been pressed stayed dark. A control that does not
   * light when pressed reads as broken, and the person presses it again.
   *
   * "I will take it from here" is a real answer to "what is it for", and this is the
   * state that remembers it until another preset is chosen.
   */
  const [choseCustom, setChoseCustom] = useState(false);
  const activePreset: ExportPresetKey = choseCustom ? 'custom' : derivedPreset;

  const applyPreset = (key: ExportPresetKey): void => {
    if (key === 'custom') {
      setChoseCustom(true);
      setShowSettings(true);
      return;
    }
    const preset = exportPreset(key);
    if (!preset) return;
    // Naming a destination is the opposite of taking it over by hand.
    setChoseCustom(false);
    setQuality(preset.quality);
    setSettings((s) => ({
      ...presetSettings(preset, sequence.size, sequence.frameRate, presetContainer),
      ...(s.range ? { range: s.range } : {}),
    }));
  };

  const applyHeight = (height: number | null): void => {
    if (height === null) {
      setSettings((s) => ({ ...s, size: sequence.size }));
      return;
    }
    const aspect = sequence.size.width / sequence.size.height;
    // Encoders reject odd dimensions for most codecs, so round to even.
    const width = Math.round((height * aspect) / 2) * 2;
    setSettings((s) => ({ ...s, size: { width, height } }));
  };

  const setContainer = (key: ContainerKey): void => {
    setSettings((s) => ({
      ...s,
      container: key,
      // Containers do not carry the same codecs; keep the one chosen where it fits.
      videoCodec: videoCodecChoice(key, s.videoCodec) ? s.videoCodec : defaultVideoCodec(key),
    }));
  };

  const frameRateKey = sameRate(settings.frameRate, sequence.frameRate)
    ? 'match'
    : (FRAME_RATES.find((option) => sameRate(option.rate, settings.frameRate))?.key ?? 'match');

  // The slider works around the recommendation rather than across every legal rate:
  // a fixed 0.5–40 Mbps scale puts a 360p sequence's entire useful range inside the
  // first three percent of the track, where it cannot be aimed.
  const reference = suggestBitrate(settings.size, settings.frameRate, settings.videoCodec, 'medium');
  const bitrateMin = Math.max(100_000, Math.round(reference / 8 / 100_000) * 100_000);
  const bitrateMax = Math.max(bitrateMin + 100_000, Math.round((reference * 4) / 100_000) * 100_000);
  const neutralBitrate = suggestBitrate(
    settings.size,
    settings.frameRate,
    settings.videoCodec,
    quality === 'custom' ? 'medium' : quality,
  );

  const containerOk = support === null ? null : support[settings.container];
  const codecOk = support === null ? null : support.videoCodecs[settings.videoCodec] !== false;
  const problem =
    containerOk === false
      ? (support?.[`${settings.container}Reason`] ?? 'These settings cannot be encoded here')
      : codecOk === false
        ? `This browser cannot encode ${codec?.label ?? settings.videoCodec} at this size`
        : null;

  const estimate = estimateExportBytes(settings, T.toSeconds(duration));
  const presetNote = exportPreset(activePreset)?.note;

  /*
   * Escape and the focus trap. Refused while an encode is running, exactly as the
   * backdrop is: stopping halfway has to go through Cancel export, which ends the
   * work rather than abandoning it behind a closed dialog.
   */
  const shell = useModalShell<HTMLDivElement>({ onClose: busy ? null : onClose });

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        ref={shell}
        className="modal export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        {/*
          The head stays put. The estimate is the one consequence that cannot be
          worked out in one's head from the controls, and the progress bar is the
          only live thing on screen once an encode starts; both belong where
          scrolling cannot take them away.
        */}
        <div className="export-head">
          <h3 id="export-dialog-title">Export</h3>

          <div className="export-summary">
            <div className="export-summary-main">
              <strong>{empty ? '—' : `~${formatBytes(estimate)}`}</strong>
              <span>
                {container.label}
                {showSettings ? ` · ${codec?.label ?? settings.videoCodec}` : ''} ·{' '}
                {settings.size.width} × {settings.size.height} ·{' '}
                {T.fpsToNumber(settings.frameRate).toFixed(2)} fps
              </span>
            </div>
            <p className="export-summary-sub">
              {empty
                ? 'The timeline is empty.'
                : `${range ? 'In–Out ' : ''}${T.formatDuration(duration, { decimals: 1 })} · ${T.ceilFrames(
                    duration,
                    settings.frameRate,
                  )} frames · ${formatBitrate(settings.bitrate)} video${
                    settings.includeAudio
                      ? ` · ${Math.round(settings.audioBitrate / 1000)} kbps ${container.audioLabel}`
                      : ' · no audio'
                  }`}
            </p>
          </div>

          {exportProgress && (
            <div className="export-progress">
              <div className="progress">
                <div style={{ width: `${exportProgress.overall * 100}%` }} />
              </div>
              <p className="hint">
                {exportProgress.stage} · {exportProgress.framesEncoded}/
                {exportProgress.totalFrames} frames · {exportProgress.fps.toFixed(1)} fps
              </p>
            </div>
          )}
        </div>

        <div className="export-body">
          {/*
            The whole dialog in one question. Everything below the disclosure is an
            answer to it that has already been filled in.
          */}
          <div className="field">
            <label id="export-preset-label">What is it for?</label>
            <div className="export-choices" role="group" aria-labelledby="export-preset-label">
              {EXPORT_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  disabled={busy}
                  className={activePreset === preset.key ? 'on' : ''}
                  aria-pressed={activePreset === preset.key}
                  onClick={() => applyPreset(preset.key)}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                className={activePreset === 'custom' ? 'on' : ''}
                aria-pressed={activePreset === 'custom'}
                title="Choose the format, size and quality yourself"
                onClick={() => applyPreset('custom')}
              >
                Custom
              </button>
            </div>
          </div>

          {/* What the preset means, or what is wrong — never both competing. */}
          <p className={problem ? 'hint export-problem' : 'hint export-note'}>
            {problem ??
              presetNote ??
              `${container.label} · ${codec?.note ?? ''} · ${container.audioLabel} audio`}
          </p>

          {/*
            What to encode, rather than how. Kept out of the disclosure because it is
            a question about the film, not about the file, and it is one a beginner
            both understands and may well want.
          */}
          <div className="field">
            <label id="export-range-label">Range</label>
            <div className="export-choices" role="group" aria-labelledby="export-range-label">
              <button
                type="button"
                disabled={busy}
                className={range ? '' : 'on'}
                aria-pressed={!range}
                onClick={() => setUseMarks(false)}
              >
                Whole sequence
              </button>
              <button
                type="button"
                disabled={busy || marked === null}
                className={range ? 'on' : ''}
                aria-pressed={range !== null}
                title={
                  marked
                    ? 'The span between the In and Out marks'
                    : 'Set In and Out on the timeline first — the I and O keys'
                }
                onClick={() => setUseMarks(true)}
              >
                In to Out
                {marked
                  ? ` (${T.formatDuration(T.sub(marked.end, marked.start), { decimals: 1 })})`
                  : ''}
              </button>
            </div>
          </div>

          <button
            type="button"
            className="export-disclosure"
            aria-expanded={showSettings}
            aria-controls="export-settings"
            onClick={() => setShowSettings((open) => !open)}
          >
            <span className={showSettings ? 'export-caret open' : 'export-caret'} aria-hidden="true">
              <IconDisclosure size={13} />
            </span>
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>

          {showSettings && (
            <div id="export-settings" className="export-settings">
              <p className="section-label">Output</p>

              <div className="export-row">
                <div className="field">
                  <label htmlFor="export-format">Format</label>
                  <select
                    id="export-format"
                    value={settings.container}
                    disabled={busy}
                    onChange={(event) => setContainer(event.target.value as ContainerKey)}
                  >
                    {(Object.keys(CONTAINERS) as ContainerKey[]).map((key) => (
                      <option key={key} value={key} disabled={support?.[key] === false}>
                        {CONTAINERS[key].label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="export-codec">Video codec</label>
                  <select
                    id="export-codec"
                    value={settings.videoCodec}
                    disabled={busy}
                    onChange={(event) =>
                      setSettings((s) => ({
                        ...s,
                        videoCodec: event.target.value as typeof s.videoCodec,
                      }))
                    }
                  >
                    {container.video.map((choice) => {
                      const unavailable = support?.videoCodecs[choice.codec] === false;
                      return (
                        <option key={choice.codec} value={choice.codec} disabled={unavailable}>
                          {choice.label}
                          {unavailable ? ' — unavailable' : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              <p className="hint">
                {support === null
                  ? 'Checking encoders for these settings…'
                  : `${codec?.note ?? ''} · ${container.audioLabel} audio`}
              </p>

              <div className="field">
                <label id="export-resolution-label">Resolution</label>
                <div
                  className="export-choices"
                  role="group"
                  aria-labelledby="export-resolution-label"
                >
                  {RESOLUTIONS.map((preset) => {
                    const active = resolutionActive(preset.height, settings.size, sequence.size);
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        disabled={busy}
                        className={active ? 'on' : ''}
                        aria-pressed={active}
                        onClick={() => applyHeight(preset.height)}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="field">
                <label htmlFor="export-fps">Frame rate</label>
                <select
                  id="export-fps"
                  value={frameRateKey}
                  disabled={busy}
                  onChange={(event) => {
                    const key = event.target.value;
                    const rate =
                      key === 'match'
                        ? sequence.frameRate
                        : (FRAME_RATES.find((option) => option.key === key)?.rate ??
                          sequence.frameRate);
                    setSettings((s) => ({ ...s, frameRate: rate }));
                  }}
                >
                  <option value="match">
                    Match sequence ({T.fpsToNumber(sequence.frameRate).toFixed(2)} fps)
                  </option>
                  {FRAME_RATES.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label} fps
                    </option>
                  ))}
                </select>
              </div>

              <p className="section-label">Video</p>

              <div className="field">
                <label id="export-quality-label">Quality</label>
                <div className="export-choices" role="group" aria-labelledby="export-quality-label">
                  {EXPORT_QUALITIES.map((level) => (
                    <button
                      key={level.key}
                      type="button"
                      disabled={busy}
                      className={quality === level.key ? 'on' : ''}
                      aria-pressed={quality === level.key}
                      onClick={() => setQuality(level.key)}
                      title={`${formatBitrate(
                        suggestBitrate(
                          settings.size,
                          settings.frameRate,
                          settings.videoCodec,
                          level.key,
                        ),
                      )} for this size, rate and codec`}
                    >
                      {level.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label htmlFor="export-bitrate">
                  Bitrate{quality === 'custom' ? ' (custom)' : ''}
                </label>
                <div className="value-row">
                  {/*
                    Marked at the rate suggested for this size, rate and codec — the
                    one value here that is a genuine recommendation rather than a
                    preference.
                  */}
                  <Fader
                    id="export-bitrate"
                    min={bitrateMin}
                    max={bitrateMax}
                    step={100_000}
                    value={Math.min(bitrateMax, Math.max(bitrateMin, settings.bitrate))}
                    disabled={busy}
                    neutral={neutralBitrate}
                    neutralSnapSteps={1}
                    ariaLabel="Export bitrate"
                    title={`Suggested here: ${formatBitrate(neutralBitrate)}`}
                    format={formatBitrate}
                    onChange={(bitrate) => {
                      setQuality('custom');
                      setSettings((s) => ({ ...s, bitrate }));
                    }}
                    // Back to the level's own suggestion, not to some other level's.
                    onReset={() => setQuality(quality === 'custom' ? 'medium' : quality)}
                  />
                  <output>{formatBitrate(settings.bitrate)}</output>
                </div>
              </div>

              <p className="section-label">Audio</p>

              <div className="export-audio-row">
                <label className="export-check">
                  <input
                    type="checkbox"
                    checked={settings.includeAudio}
                    disabled={busy}
                    onChange={(event) =>
                      setSettings((s) => ({ ...s, includeAudio: event.target.checked }))
                    }
                  />
                  Include audio
                </label>
                <select
                  aria-label="Audio bitrate"
                  value={settings.audioBitrate}
                  disabled={busy || !settings.includeAudio}
                  onChange={(event) =>
                    setSettings((s) => ({ ...s, audioBitrate: Number(event.target.value) }))
                  }
                >
                  {AUDIO_BITRATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {container.audioLabel} · {Math.round(rate / 1000)} kbps
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        <div className="actions">
          <button type="button" onClick={busy ? cancelExport : onClose}>
            {busy ? 'Cancel export' : 'Cancel'}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || empty || containerOk !== true || codecOk !== true}
            onClick={() => void runExport(range ? { ...settings, range } : settings)}
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
