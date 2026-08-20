/**
 * Scrolling a view because a gesture has reached its edge.
 *
 * Dragging the play head, a clip, a trim handle or a marquee to the side of the
 * timeline used to simply stop: measured at 200 px/s on a twenty-second clip, one
 * gesture could reach 4.3 s of 20 s before the pointer ran out of window, and the
 * rest of the timeline needed a release, a scroll and a fresh grab.
 *
 * The maths is here, away from the DOM, because the two axes and the four gestures
 * that need it should agree about what "near the edge" means.
 */

/** One axis of a scrollable view, as a gesture sees it. */
export interface EdgeScrollAxis {
  /** Pointer position along the axis, in client coordinates. */
  readonly pointer: number;
  /** The view's leading and trailing edges, in client coordinates. */
  readonly start: number;
  readonly end: number;
  /** Current scroll offset, and the largest it may become. */
  readonly scroll: number;
  readonly maxScroll: number;
  /**
   * Room at the leading edge that is not content — the timeline's track headers sit
   * over the first stretch of the view, so a pointer there is already past the edge
   * of what can be scrolled to rather than approaching it.
   */
  readonly inset?: number;
}

export interface EdgeScrollTuning {
  /** How near an edge the pointer must come before the view starts to move. */
  readonly band: number;
  /** Pixels per frame at the very edge, easing to zero at the band's inner side. */
  readonly maxStep: number;
}

export const EDGE_SCROLL: EdgeScrollTuning = { band: 32, maxStep: 18 };

/**
 * How far to scroll this frame: negative towards the start, positive towards the end.
 *
 * Zero when the pointer is comfortably inside, or when the view is already against
 * the stop it is being pushed towards — so a gesture at the left edge of a timeline
 * already scrolled to zero costs nothing and, more importantly, reports nothing, and
 * callers can use the result to decide whether anything needs redoing.
 */
export function edgeScrollDelta(axis: EdgeScrollAxis, tuning: EdgeScrollTuning = EDGE_SCROLL): number {
  const { band, maxStep } = tuning;
  if (band <= 0 || maxStep <= 0) return 0;

  const start = axis.start + (axis.inset ?? 0);
  const fromStart = axis.pointer - start;
  const fromEnd = axis.end - axis.pointer;

  // Past the edge entirely — dragged beyond the window — runs at full speed rather
  // than wrapping round to nothing, which is what a negative distance would do.
  const speed = (distance: number): number =>
    Math.ceil(maxStep * Math.min(1, Math.max(0, 1 - distance / band)));

  if (fromStart < band) {
    // Never negative zero: callers compare the result against zero to decide whether
    // anything moved, and `-0` is a value that looks like motion and is not.
    const room = Math.min(speed(fromStart), axis.scroll);
    return room <= 0 ? 0 : -room;
  }
  if (fromEnd < band) {
    const step = speed(fromEnd);
    return step === 0 ? 0 : Math.min(step, Math.max(0, axis.maxScroll - axis.scroll));
  }
  return 0;
}

/**
 * Where to scroll so a position stays visible, or null when it already is.
 *
 * Used to follow the play head during playback. It pages rather than centres: the
 * head jumps to a hand's breadth from the leading edge and the view then stays put
 * for a whole screen, which is far easier to read than a picture that slides
 * continuously under a stationary line.
 */
export function pageScrollTo(
  position: number,
  view: { readonly scroll: number; readonly length: number; readonly maxScroll: number },
  lead = 0.05,
): number | null {
  if (view.length <= 0) return null;
  const margin = view.length * lead;
  const visibleStart = view.scroll;
  const visibleEnd = view.scroll + view.length;
  if (position >= visibleStart && position <= visibleEnd) return null;

  const wanted = Math.max(0, Math.min(view.maxScroll, position - margin));
  return wanted === view.scroll ? null : wanted;
}
