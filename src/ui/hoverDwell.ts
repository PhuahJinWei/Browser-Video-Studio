/**
 * When a hint that is already on screen has outstayed its welcome.
 *
 * Both the clip hover card and the control tooltips wait for the pointer to come to
 * rest before appearing — pointing at something is a question, and the pause is what
 * asks it. Neither applied the same reasoning afterwards: once shown, a hint stayed
 * until the pointer left the thing entirely. On a clip that spans half the timeline
 * that is a long time to keep an answer pinned over the work it describes, and the
 * person has plainly stopped asking the moment they start moving again.
 *
 * So movement dismisses, and the dwell begins again — which is what the pre-show
 * behaviour already did, extended past the moment the hint appears.
 *
 * The reason it was not done that way to begin with is real: restarting on *any*
 * movement makes a card flicker under a hand that is merely resting unsteadily, or
 * under a trackpad that reports a pixel of drift while nothing is touching it. The
 * tolerance below is what separates a hand holding still from a hand going somewhere.
 */

/**
 * How far the pointer may drift before a shown hint counts as unwanted, in pixels.
 *
 * Above the jitter of a held mouse and the drift of an untouched trackpad, and below
 * anything a person would call moving. Deliberately one number for both surfaces:
 * this measures intent, which belongs to the hand rather than to whatever is under it.
 */
export const HOVER_MOVE_TOLERANCE = 6;

export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Whether the pointer has moved far enough from where a hint was anchored to mean it.
 *
 * True when there is nothing to compare against, so a caller with no anchor yet
 * always re-arms rather than silently holding a hint in place.
 */
export function movedEnoughToDismiss(
  from: PointerPoint | null,
  to: PointerPoint,
  tolerance: number = HOVER_MOVE_TOLERANCE,
): boolean {
  if (!from) return true;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Squared, to keep a square root off a path that runs on every pointer move.
  return dx * dx + dy * dy > tolerance * tolerance;
}
