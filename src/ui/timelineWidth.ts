/**
 * How wide the timeline lays its content out.
 *
 * Extracted from the component so the rule can be stated and tested on its own: it
 * is two lines of arithmetic guarding a class of bug that is very hard to see by
 * reading, and was found only by measuring a drag.
 */

/**
 * The content width to lay out, in pixels.
 *
 * `material` is the sequence and its tail; `view` is the visible width of the
 * lanes; `scrolledTo` is where the view is scrolled to right now.
 *
 * The last of those is the point. Laying the timeline out from the document alone
 * meant an edit that shortened the material shortened the timeline under a view
 * already scrolled past the new end, and the browser then clamped `scrollLeft` to
 * fit. That clamp moves the view without anyone asking for it — deleting the last
 * clip while scrolled to it threw the view a thousand pixels back to the start —
 * and under a drag it compounds, because a drag adds the scroll it observes to the
 * pointer's own movement so the clip stays under the pointer when the view moves
 * legitimately. It cannot tell a clamp from a scroll: dragging the rightmost clip
 * left shrank the timeline, which clamped the view, which moved the clip further
 * left, once per pointer event. Measured at six times the pointer's speed, and
 * accelerating.
 *
 * Flooring the width at what the current scroll position needs makes the clamp
 * arithmetically impossible. The layout may grow; it never shrinks out from under
 * the view. The surplus costs a longer scrollbar and nothing else, and it comes
 * back down on its own as the view is scrolled left again — which is also how the
 * desktop editors behave, none of which collapse the timeline under your viewport.
 */
export function timelineContentWidth(
  material: number,
  view: number,
  scrolledTo: number,
): number {
  // `view` alone is the old floor — the case of a window wider than the material —
  // and is what this reduces to whenever the view is scrolled to the start.
  return Math.max(Math.ceil(material), Math.ceil(Math.max(0, scrolledTo) + view));
}
