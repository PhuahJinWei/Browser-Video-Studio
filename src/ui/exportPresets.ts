/**
 * Export presets: what the file is for, rather than how it is made.
 *
 * The export settings ask nine questions, and someone opening a video editor for the
 * first time has an answer to two of them. The other seven — container, codec,
 * resolution, frame rate, quality, bitrate, audio rate — are not hard because there
 * are too many, but because nothing on screen says which answer is right, and every
 * control implies there is a wrong one.
 *
 * A preset answers all seven from the one question a person can actually answer:
 * where is this going. The full controls are still there behind a disclosure, with
 * the preset's choices already in them, so choosing "Best quality" and then nudging
 * the bitrate is one click rather than a different dialog.
 *
 * Deliberately only three, plus custom. A list of destinations long enough to cover
 * every case is a wall of buttons again, wearing different words.
 */

import {
  DEFAULT_AUDIO_BITRATE,
  defaultVideoCodec,
  suggestBitrate,
  type ContainerKey,
  type ExportQuality,
  type ExportSettings,
} from '../engine/export';
import type { FrameRate, Size } from '../model/types';

export type ExportPresetKey = 'share' | 'small' | 'best' | 'custom';

export interface ExportPreset {
  readonly key: Exclude<ExportPresetKey, 'custom'>;
  readonly label: string;
  /** What choosing it buys, in one sentence that names a place to put the file. */
  readonly note: string;
  /**
   * The tallest picture it will make, or null for the sequence's own height.
   *
   * A cap rather than a target: a 720p sequence exported for sharing should stay
   * 720p. Upscaling on the way out spends bitrate inventing pixels that were never
   * shot, which makes the file bigger and the picture no better.
   */
  readonly maxHeight: number | null;
  readonly quality: ExportQuality;
  readonly audioBitrate: number;
}

/*
 * All three stay on MP4 and its most compatible codec.
 *
 * The presets exist for people who do not want to think about codecs, and for them
 * the only wrong answer is a file that will not open. H.265 and AV1 are smaller and
 * both are a coin toss on someone else's machine; they belong under Custom, where
 * the person choosing them has said they know what they are doing.
 */
export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    key: 'share',
    label: 'Share online',
    note: 'Plays everywhere. Good for YouTube, Drive or sending to someone.',
    maxHeight: 1080,
    quality: 'medium',
    audioBitrate: DEFAULT_AUDIO_BITRATE,
  },
  {
    key: 'small',
    label: 'Small file',
    note: 'Lighter and quicker to upload, at 720p. For chat, email and slow connections.',
    maxHeight: 720,
    quality: 'low',
    audioBitrate: 128_000,
  },
  /*
   * 192 kbps rather than the 320 the audio menu goes up to.
   *
   * Chrome's AAC encoder refuses stereo above 192 kbps, and a rate MP4 cannot carry
   * takes MP4 down with it — the container falls back to WebM and "Best quality"
   * quietly stops being the one that plays everywhere. Nobody has ever heard the
   * difference between 192 and 320 under a finished picture; the quality this preset
   * is selling is all in the video bitrate, which is three times medium.
   */
  {
    key: 'best',
    label: 'Best quality',
    note: 'Full resolution and a high bitrate. A large file, for archiving or re-editing.',
    maxHeight: null,
    quality: 'best',
    audioBitrate: DEFAULT_AUDIO_BITRATE,
  },
];

export const PRESET_CONTAINER: ContainerKey = 'mp4';

/** What the dialog opens on. Sharing is what most exports are for. */
export const DEFAULT_EXPORT_PRESET: ExportPreset = EXPORT_PRESETS[0]!;

export function exportPreset(key: ExportPresetKey): ExportPreset | undefined {
  return EXPORT_PRESETS.find((preset) => preset.key === key);
}

/**
 * A size scaled to fit a height cap, keeping the aspect ratio.
 *
 * Returned unchanged when it already fits, so a cap never enlarges. Both edges are
 * rounded to even numbers because most encoders reject odd dimensions outright.
 */
export function fitHeight(size: Size, maxHeight: number | null): Size {
  if (maxHeight === null || size.height <= maxHeight) return size;
  const aspect = size.width / size.height;
  return {
    width: Math.max(2, Math.round((maxHeight * aspect) / 2) * 2),
    height: Math.max(2, Math.round(maxHeight / 2) * 2),
  };
}

/**
 * Whether a resolution button in the settings is the one currently chosen.
 *
 * The row is a single choice, so exactly one button may light. Comparing each height
 * against the export size independently lit two of them on a 1080p sequence — "Match
 * sequence" and "1080p" are the same picture, and both claimed it. "Match sequence"
 * wins that tie: it is the more informative label, and it stays right when the
 * sequence is later resized.
 */
export function resolutionActive(
  buttonHeight: number | null,
  exportSize: Size,
  sequenceSize: Size,
): boolean {
  const matched =
    exportSize.width === sequenceSize.width && exportSize.height === sequenceSize.height;
  return buttonHeight === null ? matched : !matched && exportSize.height === buttonHeight;
}

/**
 * The settings a preset stands for, against a given sequence.
 *
 * The container is a parameter only so that a browser with no MP4 encoder still gets
 * working presets: the dialog passes the format it has fallen back to, and the
 * preset is expressed in that instead of quietly becoming unselectable.
 */
export function presetSettings(
  preset: ExportPreset,
  sequenceSize: Size,
  sequenceFrameRate: FrameRate,
  container: ContainerKey = PRESET_CONTAINER,
): ExportSettings {
  const videoCodec = defaultVideoCodec(container);
  const size = fitHeight(sequenceSize, preset.maxHeight);
  return {
    container,
    videoCodec,
    size,
    // The sequence's rate is the rate the film was cut at; changing it on the way
    // out is a conversion, never something a destination asks for.
    frameRate: sequenceFrameRate,
    bitrate: suggestBitrate(size, sequenceFrameRate, videoCodec, preset.quality),
    includeAudio: true,
    audioBitrate: preset.audioBitrate,
  };
}

/**
 * Whether settings still say what the preset says.
 *
 * Used to drop the selection to Custom when a control underneath is moved, so the
 * highlighted button never claims something the settings no longer do. Bitrate is
 * compared through the quality level rather than directly: resolution and codec both
 * move the derived rate, and a preset that survives those is still that preset.
 */
export function matchesPreset(
  preset: ExportPreset,
  settings: ExportSettings,
  quality: ExportQuality | 'custom',
  sequenceSize: Size,
  sequenceFrameRate: FrameRate,
  container: ContainerKey = PRESET_CONTAINER,
): boolean {
  const want = presetSettings(preset, sequenceSize, sequenceFrameRate, container);
  return (
    quality === preset.quality &&
    settings.container === want.container &&
    settings.videoCodec === want.videoCodec &&
    settings.size.width === want.size.width &&
    settings.size.height === want.size.height &&
    settings.frameRate.num * want.frameRate.den === want.frameRate.num * settings.frameRate.den &&
    settings.includeAudio === want.includeAudio &&
    settings.audioBitrate === want.audioBitrate
  );
}

/** The preset these settings amount to, or 'custom' when they are nobody's. */
export function presetFor(
  settings: ExportSettings,
  quality: ExportQuality | 'custom',
  sequenceSize: Size,
  sequenceFrameRate: FrameRate,
  container: ContainerKey = PRESET_CONTAINER,
): ExportPresetKey {
  const hit = EXPORT_PRESETS.find((preset) =>
    matchesPreset(preset, settings, quality, sequenceSize, sequenceFrameRate, container),
  );
  return hit?.key ?? 'custom';
}
