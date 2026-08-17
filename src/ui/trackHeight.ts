/** Shared bounds for every timeline track-height interaction. */
export const TRACK_HEIGHT_MIN = 36;
export const TRACK_HEIGHT_MAX = 160;
export const TRACK_HEIGHT_STEP = 4;

/** At this height two full 24px control rows fit without crowding the resize seam. */
export const TRACK_HEADER_EXPANDED_HEIGHT = 56;

export function isExpandedTrackHeader(height: number): boolean {
  return height >= TRACK_HEADER_EXPANDED_HEIGHT;
}

export function clampTrackHeight(height: number): number {
  return Math.max(TRACK_HEIGHT_MIN, Math.min(TRACK_HEIGHT_MAX, Math.round(height)));
}

/** Largest common row height that fits every populated vertical pane. */
export function trackHeightToFit(
  panes: readonly { readonly height: number; readonly trackCount: number }[],
  reservedHeight = 22,
): number | null {
  const candidates = panes
    .filter((pane) => pane.trackCount > 0)
    .map((pane) => (pane.height - reservedHeight) / pane.trackCount);
  return candidates.length > 0 ? clampTrackHeight(Math.floor(Math.min(...candidates))) : null;
}
