import { describe, expect, it } from 'vitest';
import { assertMark, dragMark, type Marks } from './markRange';
import * as T from '../model/time';

const sec = (n: number): T.Time => T.time(n);
const FRAME = T.frameDuration(T.FPS_25); // 1/25 s
const at = (marks: Marks) => [
  marks.inPoint === null ? null : T.toSeconds(marks.inPoint),
  marks.outPoint === null ? null : T.toSeconds(marks.outPoint),
];

describe('assertMark', () => {
  it('sets the edge it is given', () => {
    expect(at(assertMark({ inPoint: null, outPoint: null }, 'in', sec(2)))).toEqual([2, null]);
    expect(at(assertMark({ inPoint: sec(2), outPoint: null }, 'out', sec(6)))).toEqual([2, 6]);
  });

  it('drops the opposite mark when the new one crosses it', () => {
    const marks = { inPoint: sec(2), outPoint: sec(6) };
    // In asserted past Out: the old Out described a range that no longer exists.
    expect(at(assertMark(marks, 'in', sec(8)))).toEqual([8, null]);
    expect(at(assertMark(marks, 'out', sec(1)))).toEqual([null, 1]);
  });

  it('drops it on an exact collision too, since a zero-length range is not one', () => {
    expect(at(assertMark({ inPoint: sec(2), outPoint: sec(6) }, 'in', sec(6)))).toEqual([6, null]);
  });
});

describe('dragMark', () => {
  it('moves the edge freely while it stays on its own side', () => {
    const marks = { inPoint: sec(2), outPoint: sec(6) };
    expect(at(dragMark(marks, 'in', sec(3), FRAME))).toEqual([3, 6]);
    expect(at(dragMark(marks, 'out', sec(5), FRAME))).toEqual([2, 5]);
  });

  it('stops a frame short of the far mark rather than crossing it', () => {
    const marks = { inPoint: sec(2), outPoint: sec(6) };
    const dragged = dragMark(marks, 'in', sec(9), FRAME);
    expect(T.toSeconds(dragged.inPoint!)).toBeCloseTo(6 - 1 / 25, 9);
    // The far mark is still there: nothing vanishes under the pointer.
    expect(T.toSeconds(dragged.outPoint!)).toBe(6);
  });

  it('stops a frame past the far mark when dragging the other end', () => {
    const dragged = dragMark({ inPoint: sec(2), outPoint: sec(6) }, 'out', sec(0), FRAME);
    expect(T.toSeconds(dragged.outPoint!)).toBeCloseTo(2 + 1 / 25, 9);
    expect(T.toSeconds(dragged.inPoint!)).toBe(2);
  });

  it('leaves a lone mark free, since there is nothing to be clamped by', () => {
    expect(at(dragMark({ inPoint: sec(2), outPoint: null }, 'in', sec(99), FRAME))).toEqual([99, null]);
    expect(at(dragMark({ inPoint: null, outPoint: sec(2) }, 'out', sec(0), FRAME))).toEqual([null, 0]);
  });

  it('never produces a range that is backwards or empty', () => {
    const marks = { inPoint: sec(2), outPoint: sec(6) };
    for (const target of [-5, 0, 2, 5.9, 6, 6.5, 100]) {
      for (const edge of ['in', 'out'] as const) {
        const next = dragMark(marks, edge, T.fromSeconds(target), FRAME);
        expect(T.lt(next.inPoint!, next.outPoint!)).toBe(true);
      }
    }
  });
});
