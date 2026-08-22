/**
 * Export presets: the destination answers the settings.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_AUDIO_BITRATE, suggestBitrate } from '../engine/export';
import * as T from '../model/time';
import type { Size } from '../model/types';
import {
  EXPORT_PRESETS,
  exportPreset,
  fitHeight,
  matchesPreset,
  presetFor,
  presetSettings,
  resolutionActive,
} from './exportPresets';

const hd: Size = { width: 1920, height: 1080 };
const uhd: Size = { width: 3840, height: 2160 };
const sd: Size = { width: 854, height: 480 };
const vertical: Size = { width: 1080, height: 1920 };

const share = exportPreset('share')!;
const small = exportPreset('small')!;
const best = exportPreset('best')!;

describe('fitting a height cap', () => {
  it('leaves a size that already fits alone', () => {
    expect(fitHeight(sd, 1080)).toBe(sd);
    expect(fitHeight(hd, 1080)).toBe(hd);
  });

  it('never enlarges, so sharing a 480p sequence keeps it 480p', () => {
    expect(fitHeight(sd, 2160)).toEqual(sd);
  });

  it('scales down keeping the aspect ratio', () => {
    expect(fitHeight(uhd, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitHeight(uhd, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('keeps a vertical sequence vertical', () => {
    expect(fitHeight(vertical, 1080)).toEqual({ width: 608, height: 1080 });
  });

  it('rounds both edges to even, since encoders reject odd dimensions', () => {
    // 1440×1080 (4:3) down to 720 is 960×720; a 3:2 case exercises the rounding.
    const three2 = { width: 1620, height: 1080 };
    const fitted = fitHeight(three2, 719);
    expect(fitted.width % 2).toBe(0);
    expect(fitted.height % 2).toBe(0);
  });

  it('treats a null cap as no cap', () => {
    expect(fitHeight(uhd, null)).toBe(uhd);
  });
});

describe('what a preset stands for', () => {
  it('caps 4K at 1080p for sharing but leaves it whole for best quality', () => {
    expect(presetSettings(share, uhd, T.FPS_30).size).toEqual({ width: 1920, height: 1080 });
    expect(presetSettings(best, uhd, T.FPS_30).size).toEqual(uhd);
  });

  it('always picks MP4 and its most compatible codec', () => {
    for (const preset of EXPORT_PRESETS) {
      const settings = presetSettings(preset, uhd, T.FPS_30);
      expect(settings.container).toBe('mp4');
      expect(settings.videoCodec).toBe('avc');
    }
  });

  it('keeps the sequence frame rate rather than converting', () => {
    expect(presetSettings(share, hd, T.FPS_23_976).frameRate).toEqual(T.FPS_23_976);
  });

  it('derives the bitrate from the capped size, not the original', () => {
    const settings = presetSettings(small, uhd, T.FPS_30);
    expect(settings.bitrate).toBe(
      suggestBitrate({ width: 1280, height: 720 }, T.FPS_30, 'avc', 'low'),
    );
  });

  it('orders the three by the size of the file they make', () => {
    const bitrates = EXPORT_PRESETS.map((p) => presetSettings(p, uhd, T.FPS_30).bitrate);
    expect(bitrates[0]!).toBeGreaterThan(bitrates[1]!);
    expect(bitrates[2]!).toBeGreaterThan(bitrates[0]!);
  });

  it('turns audio on for all three', () => {
    for (const preset of EXPORT_PRESETS) {
      expect(presetSettings(preset, hd, T.FPS_30).includeAudio).toBe(true);
    }
  });

  /*
   * Chrome's AAC encoder refuses stereo above 192 kbps, and an audio rate the
   * container cannot carry takes the container down with it: asking for 320 made
   * "Best quality" fall back to WebM, so the one preset a person picks for a safe
   * archive was the one that stopped being an MP4. Presets stay inside what MP4 can
   * always write; the higher rates remain in the menu, for someone who chose them.
   */
  it('never asks for an audio rate that would cost it the MP4 container', () => {
    for (const preset of EXPORT_PRESETS) {
      expect(presetSettings(preset, hd, T.FPS_30).audioBitrate).toBeLessThanOrEqual(
        DEFAULT_AUDIO_BITRATE,
      );
    }
  });
});

describe('which resolution button is lit', () => {
  it('lights only Match sequence when the export is the sequence size', () => {
    expect(resolutionActive(null, hd, hd)).toBe(true);
    expect(resolutionActive(1080, hd, hd)).toBe(false);
    expect(resolutionActive(720, hd, hd)).toBe(false);
  });

  it('lights the height once it differs from the sequence', () => {
    const seven20 = { width: 1280, height: 720 };
    expect(resolutionActive(null, seven20, hd)).toBe(false);
    expect(resolutionActive(720, seven20, hd)).toBe(true);
    expect(resolutionActive(1080, seven20, hd)).toBe(false);
  });

  it('lights exactly one button for every offered height', () => {
    const heights = [null, 2160, 1080, 720, 480];
    for (const size of [hd, uhd, sd, { width: 1280, height: 720 }]) {
      for (const sequenceSize of [hd, uhd, vertical]) {
        const lit = heights.filter((h) => resolutionActive(h, size, sequenceSize));
        expect(lit.length).toBeLessThanOrEqual(1);
      }
    }
  });

  /*
   * A vertical 1080×1920 sequence has height 1920, which is no offered preset — but
   * it is the sequence's own size, so Match sequence must still be the lit one.
   */
  it('lights Match sequence for a size no preset button names', () => {
    expect(resolutionActive(null, vertical, vertical)).toBe(true);
  });
});

describe('recognising a preset in the settings', () => {
  it('recognises its own output', () => {
    for (const preset of EXPORT_PRESETS) {
      const settings = presetSettings(preset, uhd, T.FPS_30);
      expect(matchesPreset(preset, settings, preset.quality, uhd, T.FPS_30)).toBe(true);
      expect(presetFor(settings, preset.quality, uhd, T.FPS_30)).toBe(preset.key);
    }
  });

  it('drops to custom once the codec is changed underneath', () => {
    const settings = { ...presetSettings(share, hd, T.FPS_30), videoCodec: 'hevc' as const };
    expect(presetFor(settings, 'medium', hd, T.FPS_30)).toBe('custom');
  });

  it('drops to custom once the resolution is changed underneath', () => {
    const settings = { ...presetSettings(share, hd, T.FPS_30), size: { width: 1280, height: 720 } };
    expect(presetFor(settings, 'medium', hd, T.FPS_30)).toBe('custom');
  });

  it('drops to custom once the bitrate slider has been taken hold of', () => {
    const settings = presetSettings(share, hd, T.FPS_30);
    expect(presetFor(settings, 'custom', hd, T.FPS_30)).toBe('custom');
  });

  it('drops to custom when audio is switched off', () => {
    const settings = { ...presetSettings(share, hd, T.FPS_30), includeAudio: false };
    expect(presetFor(settings, 'medium', hd, T.FPS_30)).toBe('custom');
  });

  it('expresses itself in a fallback container where MP4 cannot be written', () => {
    const settings = presetSettings(share, hd, T.FPS_30, 'webm');
    expect(settings.container).toBe('webm');
    expect(settings.videoCodec).toBe('vp9');
    expect(presetFor(settings, 'medium', hd, T.FPS_30, 'webm')).toBe('share');
    // And is not mistaken for the MP4 one it is standing in for.
    expect(presetFor(settings, 'medium', hd, T.FPS_30)).toBe('custom');
  });

  it('holds the preset when a rate is expressed as an equivalent fraction', () => {
    const settings = { ...presetSettings(share, hd, T.FPS_30), frameRate: { num: 60, den: 2 } };
    expect(presetFor(settings, 'medium', hd, T.FPS_30)).toBe('share');
  });

  /*
   * On a 720p sequence, sharing and small both cap to 720p and differ only in
   * quality — so the settings alone are ambiguous and the quality level is what
   * separates them. Guards against a match that ignores it.
   */
  it('still tells the presets apart where their sizes coincide', () => {
    const source: Size = { width: 1280, height: 720 };
    expect(presetFor(presetSettings(share, source, T.FPS_30), 'medium', source, T.FPS_30)).toBe(
      'share',
    );
    expect(presetFor(presetSettings(small, source, T.FPS_30), 'low', source, T.FPS_30)).toBe(
      'small',
    );
  });
});
