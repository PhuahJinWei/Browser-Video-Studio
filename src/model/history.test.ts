import { beforeEach, describe, expect, it } from 'vitest';
import { describeTrack, insertCommand, makeFixture, sec, type Fixture } from './fixtures';
import {
  breakCoalescing,
  canRedo,
  canUndo,
  commit,
  commitAll,
  current,
  initHistory,
  push,
  redo,
  redoLabel,
  reset,
  undo,
  undoLabel,
} from './history';

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});

const insertA = (fx: Fixture) =>
  insertCommand(fx, { trackId: fx.v1, start: sec(0), duration: sec(2), name: 'A' });
const insertB = (fx: Fixture) =>
  insertCommand(fx, { trackId: fx.v1, start: sec(4), duration: sec(2), name: 'B' });

describe('undo and redo', () => {
  it('starts empty', () => {
    const h = initHistory(f.project);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undoLabel(h)).toBeNull();
    expect(current(h)).toBe(f.project);
  });

  it('walks backwards and forwards', () => {
    let h = initHistory(f.project);
    h = commit(h, insertA(f), { label: 'Insert A' }, f.ids);
    h = commit(h, insertB(f), { label: 'Insert B' }, f.ids);
    expect(describeTrack(current(h), f.v1)).toBe('A[0..2) B[4..6)');

    h = undo(h);
    expect(describeTrack(current(h), f.v1)).toBe('A[0..2)');
    expect(canRedo(h)).toBe(true);
    expect(redoLabel(h)).toBe('Insert B');

    h = undo(h);
    expect(describeTrack(current(h), f.v1)).toBe('');
    expect(canUndo(h)).toBe(false);

    h = redo(h);
    h = redo(h);
    expect(describeTrack(current(h), f.v1)).toBe('A[0..2) B[4..6)');
    expect(canRedo(h)).toBe(false);
  });

  it('is a no-op at either end', () => {
    const h = initHistory(f.project);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it('drops the redo branch on a new edit', () => {
    let h = initHistory(f.project);
    h = commit(h, insertA(f), { label: 'Insert A' }, f.ids);
    h = commit(h, insertB(f), { label: 'Insert B' }, f.ids);
    h = undo(h);
    expect(canRedo(h)).toBe(true);

    h = commit(
      h,
      insertCommand(f, { trackId: f.v2, start: sec(0), duration: sec(1), name: 'C' }),
      { label: 'Insert C' },
      f.ids,
    );
    expect(canRedo(h)).toBe(false);
    expect(describeTrack(current(h), f.v1)).toBe('A[0..2)');
    expect(describeTrack(current(h), f.v2)).toBe('C[0..1)');
  });

  it('reports the label of the edit undo would reverse', () => {
    let h = initHistory(f.project);
    h = commit(h, insertA(f), { label: 'Insert A' }, f.ids);
    expect(undoLabel(h)).toBe('Insert A');
    expect(redoLabel(h)).toBeNull();
  });

  it('treats a batch as one step', () => {
    let h = initHistory(f.project);
    h = commitAll(h, [insertA(f), insertB(f)], { label: 'Paste' }, f.ids);
    expect(describeTrack(current(h), f.v1)).toBe('A[0..2) B[4..6)');
    h = undo(h);
    expect(describeTrack(current(h), f.v1)).toBe('');
  });

  it('ignores a push that changed nothing', () => {
    const h = initHistory(f.project);
    expect(push(h, f.project, { label: 'No-op' })).toBe(h);
  });
});

describe('coalescing', () => {
  it('merges consecutive edits from one gesture', () => {
    let h = initHistory(f.project);
    h = commit(h, insertA(f), { label: 'Insert A' }, f.ids);
    const clipId = current(h).tracks[f.v1]!.clipIds[0]!;

    for (const at of [1, 2, 3]) {
      h = commit(
        h,
        { type: 'moveClips', moves: [{ clipId, toTrackId: f.v1, toStart: sec(at) }] },
        { label: 'Move clip', coalesceKey: `drag:${clipId}` },
        f.ids,
      );
    }
    expect(describeTrack(current(h), f.v1)).toBe('A[3..5)');

    // One undo reverses the whole drag, not each pointer move.
    h = undo(h);
    expect(describeTrack(current(h), f.v1)).toBe('A[0..2)');
  });

  it('starts a fresh step once the gesture ends', () => {
    let h = initHistory(f.project);
    h = commit(h, insertA(f), { label: 'Insert A' }, f.ids);
    const clipId = current(h).tracks[f.v1]!.clipIds[0]!;
    const drag = (to: number) =>
      ({
        type: 'moveClips' as const,
        moves: [{ clipId, toTrackId: f.v1, toStart: sec(to) }],
      });

    h = commit(h, drag(2), { label: 'Move clip', coalesceKey: `drag:${clipId}` }, f.ids);
    h = breakCoalescing(h);
    h = commit(h, drag(5), { label: 'Move clip', coalesceKey: `drag:${clipId}` }, f.ids);

    expect(describeTrack(current(h), f.v1)).toBe('A[5..7)');
    h = undo(h);
    expect(describeTrack(current(h), f.v1)).toBe('A[2..4)');
    h = undo(h);
    expect(describeTrack(current(h), f.v1)).toBe('A[0..2)');
  });

  it('does not merge different keys', () => {
    let h = initHistory(f.project);
    h = commit(h, insertA(f), { label: 'A', coalesceKey: 'a' }, f.ids);
    h = commit(h, insertB(f), { label: 'B', coalesceKey: 'b' }, f.ids);
    h = undo(h);
    expect(describeTrack(current(h), f.v1)).toBe('A[0..2)');
  });
});

describe('limits and reset', () => {
  it('discards the oldest entries past the limit', () => {
    let h = initHistory(f.project, 3);
    for (let i = 0; i < 10; i++) {
      h = commit(
        h,
        insertCommand(f, { trackId: f.v1, start: sec(i * 2), duration: sec(2), name: `C${i}` }),
        { label: `Insert ${i}` },
        f.ids,
      );
    }
    expect(h.past).toHaveLength(3);
    // Undoing everything available still leaves the earlier edits applied.
    while (canUndo(h)) h = undo(h);
    expect(describeTrack(current(h), f.v1)).toBe('C0[0..2) C1[2..4) C2[4..6) C3[6..8) C4[8..10) C5[10..12) C6[12..14)');
  });

  it('clears the stack on reset', () => {
    let h = initHistory(f.project);
    h = commit(h, insertA(f), { label: 'Insert A' }, f.ids);
    h = reset(h, f.project);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(current(h)).toBe(f.project);
  });
});
