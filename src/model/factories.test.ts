import { describe, expect, it } from 'vitest';
import { createTrack, DEFAULT_TRACK_HEIGHT } from './factories';
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
