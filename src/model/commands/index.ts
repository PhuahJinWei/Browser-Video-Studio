/**
 * The commands layer's public surface.
 *
 *   const next = apply(project, { type: 'splitClips', trackIds: [v1], at: t });
 *
 * `apply` is pure: it never mutates `project`, and it never reads the clock. Given the
 * same document, command and `IdSource`, it always produces the same output.
 */

import { randomIdSource, type IdSource } from '../ids';
import type { Project } from '../types';
import { runCommand } from './handlers';
import { commitDraft, newDraft } from './internal';
import type { Command } from './types';

export type {
  ClipMove,
  ClipParamKey,
  ClipProps,
  Command,
  CommandType,
  EffectOwner,
  NewClipSpec,
  TrackProps,
  ViewProps,
} from './types';

/** Apply one command, returning a new project. Throws `ModelError` on invalid edits. */
export function apply(project: Project, command: Command, ids: IdSource = randomIdSource): Project {
  const draft = newDraft(project);
  runCommand(draft, command, ids);
  return commitDraft(project, draft);
}

/**
 * Apply several commands as one unit. If any of them throws, the whole batch is
 * discarded and the original project is returned unchanged — there is no half-applied
 * state, which matters for multi-clip edits like a ripple delete across tracks.
 */
export function applyAll(
  project: Project,
  commands: readonly Command[],
  ids: IdSource = randomIdSource,
): Project {
  const draft = newDraft(project);
  for (const command of commands) runCommand(draft, command, ids);
  return commitDraft(project, draft);
}
