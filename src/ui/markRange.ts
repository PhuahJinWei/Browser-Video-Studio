/**
 * What the In and Out marks become when one of them is set.
 *
 * There are two ways to move a mark and they mean different things, which is why
 * this is a module and not a line inside the store.
 *
 * Pressing I or O *asserts*: In is here now, whatever was true before. If that lands
 * past the Out mark then the old Out described a range that no longer exists, and
 * keeping it would leave a backwards selection — so it is dropped, and you are left
 * holding the one mark you just made.
 *
 * Dragging a handle *adjusts*: the range exists and you are changing one end of it.
 * Clearing the far mark mid-gesture would make the flag vanish out from under the
 * pointer, so the drag is clamped a frame clear of it instead. The range gets small;
 * it never turns inside out and never loses an end.
 */

import * as T from '../model/time';
import type { Time } from '../model/types';

export type MarkEdge = 'in' | 'out';

/** Which of the two rules above a change follows. */
export type MarkMode = 'assert' | 'adjust';

export interface Marks {
  readonly inPoint: Time | null;
  readonly outPoint: Time | null;
}

/** Set a mark to exactly where it was asked for, dropping a stale opposite. */
export function assertMark(marks: Marks, edge: MarkEdge, at: Time): Marks {
  const next = edge === 'in' ? { ...marks, inPoint: at } : { ...marks, outPoint: at };
  if (next.inPoint && next.outPoint && !T.lt(next.inPoint, next.outPoint)) {
    return edge === 'in' ? { inPoint: at, outPoint: null } : { inPoint: null, outPoint: at };
  }
  return next;
}

/**
 * Move one end of an existing range, held clear of the other.
 *
 * With nothing on the far side there is nothing to be clamped by, so this is the
 * same as asserting — dragging a lone mark should still go where it is dragged.
 */
export function dragMark(marks: Marks, edge: MarkEdge, at: Time, frame: Time): Marks {
  if (edge === 'in') {
    if (!marks.outPoint) return { ...marks, inPoint: at };
    return { ...marks, inPoint: T.min(at, T.sub(marks.outPoint, frame)) };
  }
  if (!marks.inPoint) return { ...marks, outPoint: at };
  return { ...marks, outPoint: T.max(at, T.add(marks.inPoint, frame)) };
}
