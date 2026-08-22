/**
 * How wide the timeline lays its content out.
 *
 * The property under test is not really a width: it is that the browser can never
 * be forced to clamp `scrollLeft`, because a clamp moves the view nobody asked to
 * move, and a drag reads that movement as the user's own.
 */

import { describe, expect, it } from 'vitest';
import { timelineContentWidth } from './timelineWidth';

const VIEW = 800;

/** What the browser would do to a scroll offset given a laid-out width. */
function clampedScroll(scrolledTo: number, content: number, header = 216): number {
  const maxScroll = Math.max(0, header + content - (header + VIEW));
  return Math.min(scrolledTo, maxScroll);
}

describe('the width itself', () => {
  it('follows the material when the view is at the start', () => {
    expect(timelineContentWidth(5000, VIEW, 0)).toBe(5000);
  });

  it('fills the window when there is barely any material', () => {
    expect(timelineContentWidth(120, VIEW, 0)).toBe(VIEW);
  });

  it('rounds up, so a fractional view can never leave it a pixel short', () => {
    expect(timelineContentWidth(0, 800.4, 100.2)).toBe(901);
  });

  it('ignores a negative scroll offset rather than shrinking on one', () => {
    expect(timelineContentWidth(5000, VIEW, -50)).toBe(5000);
  });
});

describe('an edit that shortens the material', () => {
  it('does not pull the view back with it', () => {
    // Scrolled deep into a long sequence, then most of the material is deleted.
    const scrolledTo = 4200;
    const after = timelineContentWidth(1000, VIEW, scrolledTo);

    expect(clampedScroll(scrolledTo, after)).toBe(scrolledTo);
  });

  it('would have pulled it back without the floor', () => {
    // The old rule, kept as the thing being fixed rather than assumed.
    const scrolledTo = 4200;
    const oldWidth = Math.max(Math.ceil(1000), Math.ceil(VIEW));

    expect(clampedScroll(scrolledTo, oldWidth)).toBeLessThan(scrolledTo);
  });

  it('holds however far the material collapses', () => {
    const scrolledTo = 4200;
    for (const material of [4000, 2000, 500, 0]) {
      const width = timelineContentWidth(material, VIEW, scrolledTo);
      expect(clampedScroll(scrolledTo, width)).toBe(scrolledTo);
    }
  });
});

describe('a drag that shortens the material on every pointer event', () => {
  it('never once moves the view, so the feedback loop cannot start', () => {
    // The measured bug: each clamp fed the drag, which shrank the material further.
    let scrolledTo = 4200;
    let material = 5000;

    for (let event = 0; event < 40; event++) {
      material -= 25;
      const width = timelineContentWidth(material, VIEW, scrolledTo);
      const next = clampedScroll(scrolledTo, width);
      expect(next).toBe(scrolledTo);
      scrolledTo = next;
    }

    expect(scrolledTo).toBe(4200);
  });
});

describe('the surplus it leaves behind', () => {
  it('comes back down as the view is scrolled towards the start', () => {
    const material = 1000;
    const deep = timelineContentWidth(material, VIEW, 4200);
    const nearer = timelineContentWidth(material, VIEW, 2000);
    const home = timelineContentWidth(material, VIEW, 0);

    expect(deep).toBeGreaterThan(nearer);
    expect(nearer).toBeGreaterThan(home);
    // All the way back is the material again, with nothing left over.
    expect(home).toBe(material);
  });

  it('leaves the view exactly at its limit rather than past it', () => {
    // Tight by construction: the floor grants what the scroll needs and no more, so
    // scrolling right into empty space is no more possible than it was before.
    const scrolledTo = 4200;
    const width = timelineContentWidth(0, VIEW, scrolledTo);
    const maxScroll = Math.max(0, 216 + width - (216 + VIEW));

    expect(maxScroll).toBe(scrolledTo);
  });
});
