/**
 * When a hint that is already on screen has outstayed its welcome.
 */

import { describe, expect, it } from 'vitest';
import { HOVER_MOVE_TOLERANCE, movedEnoughToDismiss } from './hoverDwell';

const at = (x: number, y: number) => ({ x, y });

describe('whether the pointer has really moved', () => {
  it('ignores a pointer that has not moved at all', () => {
    expect(movedEnoughToDismiss(at(100, 100), at(100, 100))).toBe(false);
  });

  /* A held mouse reports a pixel or two; a resting trackpad drifts. Neither is a move. */
  it('ignores jitter inside the tolerance', () => {
    expect(movedEnoughToDismiss(at(100, 100), at(103, 100))).toBe(false);
    expect(movedEnoughToDismiss(at(100, 100), at(100, 104))).toBe(false);
    expect(movedEnoughToDismiss(at(100, 100), at(103, 103))).toBe(false);
  });

  it('counts a deliberate move in any direction', () => {
    expect(movedEnoughToDismiss(at(100, 100), at(120, 100))).toBe(true);
    expect(movedEnoughToDismiss(at(100, 100), at(80, 100))).toBe(true);
    expect(movedEnoughToDismiss(at(100, 100), at(100, 130))).toBe(true);
    expect(movedEnoughToDismiss(at(100, 100), at(100, 70))).toBe(true);
  });

  /* Diagonal drift must not need to be further than straight drift to count. */
  it('measures distance rather than either axis alone', () => {
    // 5 across and 5 down is 7.07 away, past a tolerance of 6, though neither axis is.
    expect(movedEnoughToDismiss(at(0, 0), at(5, 5))).toBe(true);
    expect(movedEnoughToDismiss(at(0, 0), at(5, 0))).toBe(false);
    expect(movedEnoughToDismiss(at(0, 0), at(0, 5))).toBe(false);
  });

  it('treats exactly the tolerance as still holding still', () => {
    expect(movedEnoughToDismiss(at(0, 0), at(HOVER_MOVE_TOLERANCE, 0))).toBe(false);
    expect(movedEnoughToDismiss(at(0, 0), at(HOVER_MOVE_TOLERANCE + 1, 0))).toBe(true);
  });

  /* No anchor means nothing to hold still relative to, so the caller re-arms. */
  it('says yes when there is no anchor to compare against', () => {
    expect(movedEnoughToDismiss(null, at(0, 0))).toBe(true);
  });

  it('honours a tolerance given by the caller', () => {
    expect(movedEnoughToDismiss(at(0, 0), at(10, 0), 20)).toBe(false);
    expect(movedEnoughToDismiss(at(0, 0), at(10, 0), 2)).toBe(true);
  });

  it('is symmetric', () => {
    const a = at(40, 90);
    const b = at(70, 130);
    expect(movedEnoughToDismiss(a, b)).toBe(movedEnoughToDismiss(b, a));
  });
});
