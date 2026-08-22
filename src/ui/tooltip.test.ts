/**
 * Placing a control's tooltip.
 */

import { describe, expect, it } from 'vitest';
import {
  placeTooltip,
  TOOLTIP_GAP,
  TOOLTIP_MARGIN,
  withinRect,
  type TipRect,
  type TipSize,
} from './tooltip';

const viewport: TipSize = { width: 1440, height: 900 };
const tip: TipSize = { width: 160, height: 26 };

/** A control in the middle of the window, clear of every edge. */
const middle: TipRect = { left: 700, top: 400, width: 24, height: 24 };

describe('which side it goes on', () => {
  it('goes below, clear of the control by the gap', () => {
    const at = placeTooltip(middle, tip, viewport);
    expect(at.side).toBe('below');
    expect(at.top).toBe(middle.top + middle.height + TOOLTIP_GAP);
  });

  it('flips above when below would fall off the bottom', () => {
    const low: TipRect = { left: 700, top: 880, width: 24, height: 24 };
    const at = placeTooltip(low, tip, viewport);
    expect(at.side).toBe('above');
    expect(at.top).toBe(low.top - tip.height - TOOLTIP_GAP);
  });

  it('stays below for a control at the very top', () => {
    const high: TipRect = { left: 700, top: 0, width: 24, height: 24 };
    expect(placeTooltip(high, tip, viewport).side).toBe('below');
  });

  /*
   * A window shorter than the tooltip has no good side. Flipping to one that is no
   * better only makes the choice unpredictable, so it stays below and is clamped.
   */
  it('stays below when neither side fits, and remains on screen', () => {
    const tiny: TipSize = { width: 1440, height: 40 };
    const cramped: TipRect = { left: 700, top: 8, width: 24, height: 24 };
    const at = placeTooltip(cramped, tip, tiny);
    expect(at.side).toBe('below');
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.top).toBeLessThanOrEqual(tiny.height);
  });
});

describe('where it sits across', () => {
  it('centres on the control', () => {
    const at = placeTooltip(middle, tip, viewport);
    expect(at.left + tip.width / 2).toBe(middle.left + middle.width / 2);
  });

  it('stops short of the right edge for a control in the corner', () => {
    const corner: TipRect = { left: 1420, top: 400, width: 20, height: 20 };
    const at = placeTooltip(corner, tip, viewport);
    expect(at.left + tip.width).toBeLessThanOrEqual(viewport.width - TOOLTIP_MARGIN);
  });

  it('stops short of the left edge for a control at the start', () => {
    const corner: TipRect = { left: 0, top: 400, width: 20, height: 20 };
    expect(placeTooltip(corner, tip, viewport).left).toBe(TOOLTIP_MARGIN);
  });

  /* Both clamps want the opposite thing; the left edge has to win, or it goes negative. */
  it('pins to the left edge when the tooltip is wider than the window', () => {
    const at = placeTooltip(middle, { width: 2000, height: 26 }, viewport);
    expect(at.left).toBe(TOOLTIP_MARGIN);
  });

  it('never places a tooltip at a negative coordinate', () => {
    const spots: TipRect[] = [
      { left: 0, top: 0, width: 10, height: 10 },
      { left: 1439, top: 899, width: 10, height: 10 },
      { left: -20, top: -20, width: 10, height: 10 },
    ];
    for (const anchor of spots) {
      const at = placeTooltip(anchor, tip, viewport);
      expect(at.left).toBeGreaterThanOrEqual(0);
      expect(at.top).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('staying with the control', () => {
  it('counts the edges as still inside', () => {
    expect(withinRect(middle, 700, 400)).toBe(true);
    expect(withinRect(middle, 724, 424)).toBe(true);
  });

  it('knows when the pointer has left', () => {
    expect(withinRect(middle, 699, 400)).toBe(false);
    expect(withinRect(middle, 725, 400)).toBe(false);
    expect(withinRect(middle, 700, 425)).toBe(false);
  });
});
