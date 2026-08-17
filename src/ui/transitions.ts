/**
 * Shared transition vocabulary for the UI.
 *
 * Kept out of both the timeline and the inspector so the two cannot drift into
 * calling the same style by different names.
 */

import type { TransitionType } from '../model/types';

/** Menu, inspector and badge wording, named for the direction the edge travels. */
export const TRANSITION_LABELS: Readonly<Record<TransitionType, string>> = {
  dissolve: 'Cross dissolve',
  'wipe.right': 'Wipe right →',
  'wipe.left': 'Wipe left ←',
  'wipe.down': 'Wipe down ↓',
  'wipe.up': 'Wipe up ↑',
  'wipe.iris': 'Iris',
};

/** Short form for the badge, where there is rarely room for the full name. */
export const TRANSITION_SHORT_LABELS: Readonly<Record<TransitionType, string>> = {
  dissolve: 'Dissolve',
  'wipe.right': 'Wipe →',
  'wipe.left': 'Wipe ←',
  'wipe.down': 'Wipe ↓',
  'wipe.up': 'Wipe ↑',
  'wipe.iris': 'Iris',
};

/** Length a transition gets when added without a length being asked for. */
export const DEFAULT_TRANSITION_SECONDS = 1;

export function transitionLabel(type: string): string {
  return TRANSITION_LABELS[type as TransitionType] ?? type;
}

export function transitionShortLabel(type: string): string {
  return TRANSITION_SHORT_LABELS[type as TransitionType] ?? type;
}
