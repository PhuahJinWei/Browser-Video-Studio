/**
 * What a clip's right-click menu acts on.
 *
 * Extracted from the menu that builds it so it can be tested: as an expression
 * inline in `openClipMenu` it read plausibly and was wrong, and nothing but a
 * careful reading of React's closure semantics said so.
 */

import { selectionUnit } from '../model/selectors';
import type { ClipId, Project } from '../model/types';

/**
 * The clips a menu opened on `clipId` should take.
 *
 * An existing multi-selection is honoured as it stands — right-clicking inside a
 * sweep of clips acts on the sweep. Anything else resolves through
 * `selectionUnit`, so a linked pair or a group goes whole.
 *
 * `selection` must be the selection as it was *before* the right-click. A menu
 * opening on an unselected clip also selects it, but that new selection cannot be
 * read back from this render's value, and using the stale one deleted a single
 * member out of a unit the menu had just lit up in full.
 */
export function clipMenuTargets(
  project: Project,
  selection: readonly ClipId[],
  clipId: ClipId,
): readonly ClipId[] {
  return selection.includes(clipId) && selection.length > 1
    ? selection
    : selectionUnit(project, clipId);
}
