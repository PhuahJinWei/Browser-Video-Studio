/**
 * Tooltips for controls.
 *
 * The application had already decided against the native `title` tooltip once: the
 * hover card that describes a clip or a bin card exists because `title` waits about a
 * second, cannot be styled and truncates. The controls never got the same treatment,
 * so thirty icon-only buttons — the transport, the track heads, the zoom pair, the
 * view toggles — were still explaining themselves through the slow one.
 *
 * Three things are wrong with `title` on a button, and only the first is cosmetic:
 * the delay is long enough that a person exploring gives up before it arrives; it
 * never appears on keyboard focus, so an icon button is unlabelled for anyone not
 * using a mouse; and it cannot be positioned, so it lands under the pointer and
 * covers the thing next to what you are pointing at.
 *
 * Touch is deliberately not handled. A tap on a touch screen runs the command, so a
 * label that arrives afterwards is answering a question that has already been settled
 * the hard way — the answer there is a visible label, not a tooltip, which is why the
 * main toolbar carries words under its icons.
 */

/**
 * How long the pointer must rest on a control before its tooltip appears.
 *
 * Shorter than the library's 450ms hover card. Pointing at a bin card asks "what is
 * this file", which is worth a considered pause; pointing at a button asks "what does
 * this do", and that is a question someone is asking while hunting, so the answer has
 * to keep up with the hunt.
 */
export const TOOLTIP_DELAY_MS = 320;

/** Distance between the control and its tooltip. */
export const TOOLTIP_GAP = 6;

/** Closest a tooltip may come to the edge of the window. */
export const TOOLTIP_MARGIN = 6;

/**
 * Opt a control into the tooltip layer, and give it its accessible name.
 *
 * Both from one string, because for an icon button they are always the same words —
 * and writing them separately is how they drift, leaving a button whose tooltip and
 * whose screen-reader label disagree about what it does. Replaces `title`, which
 * cannot be spelled without also summoning the native tooltip a second later.
 */
export function tip(text: string): { readonly 'data-tip': string; readonly 'aria-label': string } {
  return { 'data-tip': text, 'aria-label': text };
}

/**
 * A tooltip only, leaving the accessible name alone.
 *
 * For two cases. Something that is not itself a control — a slider's surround, a
 * track name — where an `aria-label` would be announced on an element with no role to
 * attach it to. And a control that already has a better name than its tooltip: the
 * keyframe arrows say "Previous keyframe" to the eye, which has the parameter's own
 * row for context, and "Previous opacity keyframe" to a reader, which does not.
 */
export function hint(text: string): { readonly 'data-tip': string } {
  return { 'data-tip': text };
}

export interface TipRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TipSize {
  readonly width: number;
  readonly height: number;
}

export type TipSide = 'above' | 'below';

export interface TipPlacement {
  readonly left: number;
  readonly top: number;
  readonly side: TipSide;
}

/**
 * Where to put a tooltip for a control, in viewport coordinates.
 *
 * Below by default and above only when below will not fit, because a tooltip above a
 * control sits between it and whatever the person was reading on the way down to it.
 * Horizontally centred on the control, then clamped: a tooltip pushed off the right
 * edge of the window is worse than one that is no longer quite centred, and the
 * controls that need this most — the zoom pair, the fullscreen button — are the ones
 * living in corners.
 */
export function placeTooltip(
  anchor: TipRect,
  tip: TipSize,
  viewport: TipSize,
  gap: number = TOOLTIP_GAP,
  margin: number = TOOLTIP_MARGIN,
): TipPlacement {
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - tip.height - gap;
  const fitsBelow = below + tip.height <= viewport.height - margin;
  const fitsAbove = above >= margin;

  // Neither fits on a window shorter than the tooltip: stay below and let the clamp
  // below keep it on screen, rather than flipping to an edge that is no better.
  const side: TipSide = fitsBelow || !fitsAbove ? 'below' : 'above';
  const unclampedTop = side === 'below' ? below : above;

  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const widest = viewport.width - tip.width - margin;
  // `Math.max` last, so a tooltip wider than the window pins to the left edge rather
  // than to a negative left produced by the clamp itself.
  const left = Math.max(margin, Math.min(centred, widest));

  const tallest = viewport.height - tip.height - margin;
  const top = Math.max(margin, Math.min(unclampedTop, tallest));

  return { left, top, side };
}
