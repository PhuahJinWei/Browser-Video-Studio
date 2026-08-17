import { describe, expect, it } from 'vitest';
import {
  clampTrackHeight,
  isExpandedTrackHeader,
  TRACK_HEIGHT_MAX,
  TRACK_HEIGHT_MIN,
  trackHeightToFit,
} from './trackHeight';

describe('track height controls', () => {
  it('rounds and clamps every resize path to the shared bounds', () => {
    expect(clampTrackHeight(71.6)).toBe(72);
    expect(clampTrackHeight(1)).toBe(TRACK_HEIGHT_MIN);
    expect(clampTrackHeight(999)).toBe(TRACK_HEIGHT_MAX);
  });

  it('fits one common height to the most constrained populated pane', () => {
    expect(
      trackHeightToFit([
        { height: 238, trackCount: 3 },
        { height: 210, trackCount: 2 },
      ]),
    ).toBe(72);
  });

  it('ignores empty panes and returns null when there are no tracks', () => {
    expect(trackHeightToFit([{ height: 200, trackCount: 0 }])).toBeNull();
    expect(
      trackHeightToFit([
        { height: 10, trackCount: 0 },
        { height: 166, trackCount: 2 },
      ]),
    ).toBe(72);
  });

  it('reveals a second header row only when two full controls fit', () => {
    expect(isExpandedTrackHeader(36)).toBe(false);
    expect(isExpandedTrackHeader(52)).toBe(false);
    expect(isExpandedTrackHeader(56)).toBe(true);
    expect(isExpandedTrackHeader(72)).toBe(true);
  });
});
