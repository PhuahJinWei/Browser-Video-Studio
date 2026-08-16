/**
 * Undo/redo.
 *
 * Snapshot-based: each entry holds a whole `Project` root, which is cheap because
 * commands share structure with the version they came from. See docs/DATA_MODEL.md
 * for why this beats hand-written inverse commands.
 *
 * Coalescing matters as much as the stack itself — a clip drag fires a `moveClips`
 * per pointer move, and without merging you get 200 undo steps for one gesture.
 */

import { apply, applyAll, type Command } from './commands';
import { randomIdSource, type IdSource } from './ids';
import type { Project } from './types';

export interface HistoryEntry {
  readonly project: Project;
  readonly label: string;
  /**
   * Consecutive edits sharing a key merge into one undo step. Use something stable
   * for the gesture, e.g. `drag:cl_7`. Undefined never merges.
   */
  readonly coalesceKey?: string;
}

export interface History {
  readonly past: readonly HistoryEntry[];
  readonly present: HistoryEntry;
  readonly future: readonly HistoryEntry[];
  readonly limit: number;
}

export const DEFAULT_HISTORY_LIMIT = 200;

export function initHistory(project: Project, limit = DEFAULT_HISTORY_LIMIT): History {
  return { past: [], present: { project, label: 'Open' }, future: [], limit };
}

export function canUndo(h: History): boolean {
  return h.past.length > 0;
}

export function canRedo(h: History): boolean {
  return h.future.length > 0;
}

export function current(h: History): Project {
  return h.present.project;
}

/** Label of the edit that undo would reverse, for menu text. */
export function undoLabel(h: History): string | null {
  return h.present.label === 'Open' || h.past.length === 0 ? null : h.present.label;
}

export function redoLabel(h: History): string | null {
  return h.future[0]?.label ?? null;
}

export interface PushOptions {
  readonly label: string;
  readonly coalesceKey?: string;
}

/** Record a new document state, dropping any redo branch. */
export function push(h: History, project: Project, opts: PushOptions): History {
  if (project === h.present.project) return h;

  const entry: HistoryEntry = {
    project,
    label: opts.label,
    ...(opts.coalesceKey !== undefined ? { coalesceKey: opts.coalesceKey } : {}),
  };

  // Merge into the current step when the gesture continues.
  const merges =
    opts.coalesceKey !== undefined &&
    h.present.coalesceKey === opts.coalesceKey &&
    h.future.length === 0;
  if (merges) {
    return { ...h, present: entry, future: [] };
  }

  const past = [...h.past, h.present];
  return {
    ...h,
    past: past.length > h.limit ? past.slice(past.length - h.limit) : past,
    present: entry,
    future: [],
  };
}

/** Apply a command and record it in one step. */
export function commit(
  h: History,
  command: Command,
  opts: PushOptions,
  ids: IdSource = randomIdSource,
): History {
  return push(h, apply(current(h), command, ids), opts);
}

/** Apply several commands as one atomic undo step. */
export function commitAll(
  h: History,
  commands: readonly Command[],
  opts: PushOptions,
  ids: IdSource = randomIdSource,
): History {
  return push(h, applyAll(current(h), commands, ids), opts);
}

export function undo(h: History): History {
  const previous = h.past[h.past.length - 1];
  if (!previous) return h;
  return {
    ...h,
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
  };
}

export function redo(h: History): History {
  const next = h.future[0];
  if (!next) return h;
  return {
    ...h,
    past: [...h.past, h.present],
    present: next,
    future: h.future.slice(1),
  };
}

/**
 * End the current gesture so the next edit starts a fresh undo step, even if it
 * carries the same coalesce key. Call on pointer-up.
 */
export function breakCoalescing(h: History): History {
  if (h.present.coalesceKey === undefined) return h;
  const { project, label } = h.present;
  return { ...h, present: { project, label } };
}

/** Replace the document without touching the stack (e.g. after loading from disk). */
export function reset(h: History, project: Project, label = 'Open'): History {
  return { ...h, past: [], present: { project, label }, future: [] };
}
