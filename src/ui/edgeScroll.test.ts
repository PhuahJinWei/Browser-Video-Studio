/**
 * Scrolling because a gesture reached the edge, and following the play head.
 */

import { describe, expect, it } from 'vitest';
import { EDGE_SCROLL, edgeScrollDelta, pageScrollTo } from './edgeScroll';

/** A 1000px-wide view, scrolled to 500 of a possible 4000. */
const view = { start: 0, end: 1000, scroll: 500, maxScroll: 4000 };

describe('deciding to scroll at an edge', () => {
  it('stays still while the pointer is comfortably inside', () => {
    expect(edgeScrollDelta({ ...view, pointer: 500 })).toBe(0);
  });

  it('moves towards the end as the pointer nears it, faster the closer it gets', () => {
    const near = edgeScrollDelta({ ...view, pointer: 990 });
    const nearer = edgeScrollDelta({ ...view, pointer: 999 });

    expect(near).toBeGreaterThan(0);
    expect(nearer).toBeGreaterThan(near);
    expect(nearer).toBeLessThanOrEqual(EDGE_SCROLL.maxStep);
  });

  it('moves towards the start at the other edge', () => {
    expect(edgeScrollDelta({ ...view, pointer: 5 })).toBeLessThan(0);
  });

  it('runs at full speed once the pointer is past the edge entirely', () => {
    // Dragged beyond the window: a distance that has gone negative must not wrap
    // round into a larger step, or a slow drag off-screen would scroll wildly.
    expect(edgeScrollDelta({ ...view, pointer: 1400 })).toBe(EDGE_SCROLL.maxStep);
    expect(edgeScrollDelta({ ...view, pointer: -400 })).toBe(-EDGE_SCROLL.maxStep);
  });

  it('will not scroll past the start', () => {
    expect(edgeScrollDelta({ ...view, scroll: 0, pointer: -400 })).toBe(0);
    expect(edgeScrollDelta({ ...view, scroll: 4, pointer: -400 })).toBe(-4);
  });

  it('will not scroll past the end', () => {
    expect(edgeScrollDelta({ ...view, scroll: 4000, pointer: 1400 })).toBe(0);
    expect(edgeScrollDelta({ ...view, scroll: 3995, pointer: 1400 })).toBe(5);
  });

  it('measures the leading edge from the content, not from the view', () => {
    // The track headers cover the first 216px; a pointer at 220 is a few pixels into
    // the content and should be scrolling, not sitting in the middle of nowhere.
    const withHeaders = { ...view, inset: 216, pointer: 220 };
    expect(edgeScrollDelta(withHeaders)).toBeLessThan(0);
    expect(edgeScrollDelta({ ...withHeaders, pointer: 400 })).toBe(0);
  });

  it('eases across the headers rather than hitting full speed at their inner edge', () => {
    // A leftward drag crosses the 216px header column constantly, so reaching
    // maximum speed on touching it made the view bolt. Grazing it should barely
    // move; the window's own edge is what full speed is for.
    const headers = { ...view, inset: 216 };
    const graze = -edgeScrollDelta({ ...headers, pointer: 216 });
    const halfway = -edgeScrollDelta({ ...headers, pointer: 108 });
    const atEdge = -edgeScrollDelta({ ...headers, pointer: 0 });

    expect(graze).toBeGreaterThan(0);
    expect(graze).toBeLessThanOrEqual(3);
    expect(halfway).toBeGreaterThan(graze);
    expect(halfway).toBeLessThan(atEdge);
    expect(atEdge).toBe(EDGE_SCROLL.maxStep);
  });

  it('offers the leading and trailing edges the same bargain', () => {
    // Full speed at the window's edge on both sides, having started from nothing a
    // band's width in — the asymmetry was the inset being spent on the trigger
    // rather than on the ramp.
    const headers = { ...view, inset: 216 };
    expect(-edgeScrollDelta({ ...headers, pointer: 0 })).toBe(EDGE_SCROLL.maxStep);
    expect(edgeScrollDelta({ ...headers, pointer: 1000 })).toBe(EDGE_SCROLL.maxStep);
  });

  it('still runs at full speed once dragged off the window entirely', () => {
    expect(edgeScrollDelta({ ...view, inset: 216, pointer: -400 })).toBe(-EDGE_SCROLL.maxStep);
  });

  it('leaves a view with nothing in front of it exactly as it was', () => {
    // The vertical panes pass no inset, and must not be retuned by this.
    for (const pointer of [0, 8, 16, 24, 31, 40]) {
      expect(edgeScrollDelta({ ...view, pointer })).toBe(
        edgeScrollDelta({ ...view, inset: 0, pointer }),
      );
    }
  });
});

describe('following the play head', () => {
  const window = { scroll: 1000, length: 800, maxScroll: 5000 };

  it('says nothing while the head is on screen', () => {
    expect(pageScrollTo(1400, window)).toBeNull();
    expect(pageScrollTo(1000, window)).toBeNull();
    expect(pageScrollTo(1800, window)).toBeNull();
  });

  it('pages forward when the head runs off the end, landing it near the edge', () => {
    const next = pageScrollTo(1900, window);
    expect(next).not.toBeNull();
    // A screen's worth ahead, with the head just inside the leading edge rather than
    // centred: the view then stays put for a whole screen instead of sliding.
    expect(1900 - next!).toBeCloseTo(800 * 0.05, 6);
  });

  it('pages back when the head is behind the view, after a jump to the start', () => {
    const next = pageScrollTo(0, window);
    expect(next).toBe(0);
  });

  it('never scrolls past either stop', () => {
    expect(pageScrollTo(10, window)).toBe(0);
    expect(pageScrollTo(9999, { ...window, maxScroll: 5000 })).toBe(5000);
  });

  it('says nothing when the scroll it wants is where it already is', () => {
    expect(pageScrollTo(9999, { scroll: 5000, length: 800, maxScroll: 5000 })).toBeNull();
  });
});

