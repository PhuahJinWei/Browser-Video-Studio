/**
 * The focus trap's arithmetic: where Tab lands, and when to intervene at all.
 */

import { describe, expect, it } from 'vitest';
import { atTrapEdge, wrapFocusIndex } from './modalShell';

describe('where Tab lands', () => {
  it('steps forward through the middle', () => {
    expect(wrapFocusIndex(5, 1, false)).toBe(2);
    expect(wrapFocusIndex(5, 3, false)).toBe(4);
  });

  it('steps back through the middle', () => {
    expect(wrapFocusIndex(5, 3, true)).toBe(2);
    expect(wrapFocusIndex(5, 1, true)).toBe(0);
  });

  it('wraps the last round to the first', () => {
    expect(wrapFocusIndex(5, 4, false)).toBe(0);
  });

  it('wraps the first back round to the last', () => {
    expect(wrapFocusIndex(5, 0, true)).toBe(4);
  });

  /*
   * -1 is focus parked on the dialog itself, or escaped behind the backdrop before
   * the trap caught it. Both want the near end in the direction of travel.
   */
  it('pulls focus in from nowhere, at the near end', () => {
    expect(wrapFocusIndex(5, -1, false)).toBe(0);
    expect(wrapFocusIndex(5, -1, true)).toBe(4);
  });

  it('has nowhere to go in an empty dialog', () => {
    expect(wrapFocusIndex(0, -1, false)).toBe(-1);
    expect(wrapFocusIndex(0, 2, true)).toBe(-1);
  });

  it('keeps a single control focused in both directions', () => {
    expect(wrapFocusIndex(1, 0, false)).toBe(0);
    expect(wrapFocusIndex(1, 0, true)).toBe(0);
  });

  it('always lands somewhere real', () => {
    for (const count of [1, 2, 5, 9]) {
      for (let current = -1; current < count; current++) {
        for (const backwards of [false, true]) {
          const next = wrapFocusIndex(count, current, backwards);
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThan(count);
        }
      }
    }
  });

  it('goes round the whole ring and back to the start', () => {
    const count = 4;
    let at = 0;
    for (let step = 0; step < count; step++) at = wrapFocusIndex(count, at, false);
    expect(at).toBe(0);
  });
});

describe('when to intervene', () => {
  /* The browser orders the middle better than a hand-rolled trap can. */
  it('leaves the middle to the browser', () => {
    expect(atTrapEdge(5, 2, false)).toBe(false);
    expect(atTrapEdge(5, 2, true)).toBe(false);
    expect(atTrapEdge(5, 1, false)).toBe(false);
  });

  it('catches Tab off the last control', () => {
    expect(atTrapEdge(5, 4, false)).toBe(true);
    expect(atTrapEdge(5, 4, true)).toBe(false);
  });

  it('catches Shift+Tab off the first control', () => {
    expect(atTrapEdge(5, 0, true)).toBe(true);
    expect(atTrapEdge(5, 0, false)).toBe(false);
  });

  it('catches focus that is not in the dialog at all', () => {
    expect(atTrapEdge(5, -1, false)).toBe(true);
    expect(atTrapEdge(5, -1, true)).toBe(true);
  });

  it('treats a dialog with no controls as always at the edge', () => {
    expect(atTrapEdge(0, -1, false)).toBe(true);
  });

  /* One control is both ends at once, so either direction has to be caught. */
  it('catches both directions on a lone control', () => {
    expect(atTrapEdge(1, 0, false)).toBe(true);
    expect(atTrapEdge(1, 0, true)).toBe(true);
  });
});
