/**
 * The pure maths behind the export dialog.
 *
 * Only the parts that can be reasoned about without an encoder: the bitrate a
 * quality level implies, the size that implies, and the container/codec tables that
 * both of those read from.
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIO_BITRATES,
  CONTAINERS,
  defaultVideoCodec,
  estimateExportBytes,
  EXPORT_QUALITIES,
  suggestBitrate,
  videoCodecChoice,
  type ContainerKey,
  type ExportSettings,
} from './export';
import * as T from '../model/time';

const HD = { width: 1920, height: 1080 };
const SD = { width: 640, height: 360 };

function settings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    container: 'mp4',
    videoCodec: 'avc',
    size: HD,
    frameRate: T.FPS_30,
    bitrate: 8_000_000,
    includeAudio: true,
    audioBitrate: 192_000,
    ...overrides,
  };
}

describe('suggestBitrate', () => {
  it('scales with pixels and with frame rate', () => {
    const hd = suggestBitrate(HD, T.FPS_30);
    expect(suggestBitrate(SD, T.FPS_30)).toBeLessThan(hd);
    // Twice the frames wants about twice the bits.
    expect(suggestBitrate(HD, T.FPS_60) / hd).toBeCloseTo(2, 1);
  });

  it('lands inside the rates the large services recommend for 1080p30', () => {
    const hd = suggestBitrate(HD, T.FPS_30);
    expect(hd).toBeGreaterThan(5_000_000);
    expect(hd).toBeLessThan(10_000_000);
  });

  it('orders the quality levels', () => {
    const rates = EXPORT_QUALITIES.map((level) => suggestBitrate(HD, T.FPS_30, 'avc', level.key));
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]!).toBeGreaterThan(rates[i - 1]!);
    }
  });

  it('asks less of the newer codecs, which is the whole reason to offer them', () => {
    const h264 = suggestBitrate(HD, T.FPS_30, 'avc');
    expect(suggestBitrate(HD, T.FPS_30, 'av1')).toBeLessThan(h264);
    expect(suggestBitrate(HD, T.FPS_30, 'hevc')).toBeLessThan(h264);
    expect(suggestBitrate(HD, T.FPS_30, 'vp9')).toBeLessThan(h264);
  });

  it('stays inside its floor and ceiling', () => {
    // A postage stamp at the lowest setting is not starved to nothing...
    expect(suggestBitrate({ width: 16, height: 16 }, T.FPS_24, 'av1', 'low')).toBe(200_000);
    // ...and 8K at the highest does not run away.
    expect(suggestBitrate({ width: 7680, height: 4320 }, T.FPS_60, 'avc', 'best')).toBe(100_000_000);
  });
});

describe('estimateExportBytes', () => {
  it('counts both tracks over the duration', () => {
    const bytes = estimateExportBytes(settings({ bitrate: 8_000_000 }), 10);
    // (8 Mbit + 192 kbit) / 8 × 10 s, plus a little container overhead.
    expect(bytes).toBeGreaterThan(10_200_000);
    expect(bytes).toBeLessThan(10_600_000);
  });

  it('drops the audio when audio is not being written', () => {
    const withAudio = estimateExportBytes(settings(), 30);
    const without = estimateExportBytes(settings({ includeAudio: false }), 30);
    expect(without).toBeLessThan(withAudio);
  });

  it('is zero for an empty timeline rather than a negative or a NaN', () => {
    expect(estimateExportBytes(settings(), 0)).toBe(0);
    expect(estimateExportBytes(settings(), -5)).toBe(0);
  });
});

describe('container tables', () => {
  const keys = Object.keys(CONTAINERS) as ContainerKey[];

  it('offers a default codec that its own container can carry', () => {
    for (const key of keys) {
      expect(videoCodecChoice(key, defaultVideoCodec(key))).toBeDefined();
    }
  });

  it('does not claim a container carries a codec it cannot', () => {
    // WebM has no H.264, and offering it would fail at the muxer rather than here.
    expect(videoCodecChoice('webm', 'avc')).toBeUndefined();
    expect(videoCodecChoice('mp4', 'avc')).toBeDefined();
  });

  it('lists the most compatible codec first, since that is what defaults to', () => {
    expect(defaultVideoCodec('mp4')).toBe('avc');
    expect(CONTAINERS.mp4.video[0]!.efficiency).toBe(1);
  });

  it('offers audio rates in ascending order', () => {
    expect([...AUDIO_BITRATES]).toEqual([...AUDIO_BITRATES].sort((a, b) => a - b));
  });
});
