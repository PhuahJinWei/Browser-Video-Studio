import { describe, expect, it } from 'vitest';
import { createTrack, DEFAULT_TRACK_HEIGHT, heightForNewTrack } from './factories';
import type { TrackId } from './types';

describe('track defaults', () => {
  it('starts audio and video tracks at the same readable height', () => {
    expect(DEFAULT_TRACK_HEIGHT).toBe(100);
    const id = 'track' as TrackId;
    expect(createTrack({ id, kind: 'video' }).height).toBe(DEFAULT_TRACK_HEIGHT);
    expect(createTrack({ id, kind: 'audio' }).height).toBe(DEFAULT_TRACK_HEIGHT);
  });

  it('preserves an explicitly requested compact height', () => {
    expect(createTrack({ id: 'track' as TrackId, kind: 'audio', height: 40 }).height).toBe(40);
  });
});

describe('how tall a new lane arrives', () => {
  it('takes the default when its kind has no lanes yet', () => {
    expect(heightForNewTrack([], 0)).toBe(DEFAULT_TRACK_HEIGHT);
  });

  /*
   * The case this exists for: every lane shortened with the height slider, then a new
   * one added. It used to arrive at the factory default, an odd one out to be dragged
   * back down by hand.
   */
  it('matches lanes that have all been resized together', () => {
    expect(heightForNewTrack([55, 55, 55], 3)).toBe(55);
    expect(heightForNewTrack([160, 160], 2)).toBe(160);
  });

  it('matches the lane it is inserted in front of', () => {
    expect(heightForNewTrack([40, 80, 120], 1)).toBe(80);
    expect(heightForNewTrack([40, 80, 120], 0)).toBe(40);
  });

  it('matches the last lane when appending past the end', () => {
    expect(heightForNewTrack([40, 80, 120], 3)).toBe(120);
    expect(heightForNewTrack([40, 80, 120], 99)).toBe(120);
  });

  it('is not thrown by a negative index', () => {
    expect(heightForNewTrack([40, 80], -5)).toBe(40);
  });

  it('always returns one of the heights it was given, or the default', () => {
    const heights = [36, 72, 144];
    for (let index = -2; index <= 5; index++) {
      expect(heights).toContain(heightForNewTrack(heights, index));
    }
  });
});
