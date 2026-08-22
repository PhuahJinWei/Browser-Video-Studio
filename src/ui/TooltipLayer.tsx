/**
 * The single tooltip layer.
 *
 * One listener at the document rather than a wrapper around each of thirty buttons:
 * the controls that need tooltips are spread across the header, the transport, the
 * track heads and the status bar, and threading a component through all of them would
 * put a node in the tree for every icon in the application. A control opts in with
 * `data-tip`, and nothing else about it has to change.
 *
 * Pointer tracking is a hit test on movement, not `pointerover`. Disabled buttons
 * fire no pointer events at all, and a disabled button is where an explanation is
 * worth most — "why can I not press this" is a sharper question than "what does this
 * do", and the Transition button answers exactly that in its tooltip.
 *
 * A tooltip goes as soon as the pointer moves off the spot it was summoned to, rather
 * than clinging until the control is left — see `hoverDwell`, which the clip hover
 * card shares. Comparing against that spot also keeps the hit test off the hot path
 * while a hand is holding still.
 */

import { useEffect, useRef, useState } from 'react';
import { movedEnoughToDismiss } from './hoverDwell';
import { placeTooltip, TOOLTIP_DELAY_MS, type TipPlacement } from './tooltip';

interface Shown {
  readonly text: string;
  readonly anchor: DOMRect;
  /** Kept so a tooltip can be dropped when the thing it describes stops existing. */
  readonly el: Element;
  /** Focus has no dwell to wait through, so it skips the delay. */
  readonly immediate: boolean;
}

export function TooltipLayer(): React.JSX.Element | null {
  const [shown, setShown] = useState<Shown | null>(null);
  const [at, setAt] = useState<TipPlacement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  /** What the pointer is currently over, delayed or not, so movement can be ignored. */
  const target = useRef<{ el: Element; at: { x: number; y: number } } | null>(null);

  useEffect(() => {
    const clear = (): void => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    };
    const hide = (): void => {
      clear();
      target.current = null;
      setShown(null);
      setAt(null);
    };

    const open = (el: Element, immediate: boolean): void => {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      const anchor = el.getBoundingClientRect();
      const show = (): void => setShown({ text, anchor, el, immediate });
      clear();
      if (immediate) {
        show();
        return;
      }
      // Anything on screen goes while the dwell runs again, so a tooltip is never
      // left over a control the pointer has moved on from. React bails out when it is
      // already null, so this costs nothing on the common path.
      setShown(null);
      setAt(null);
      timer.current = window.setTimeout(show, TOOLTIP_DELAY_MS);
    };

    const onMove = (event: PointerEvent): void => {
      const to = { x: event.clientX, y: event.clientY };
      const current = target.current;
      /*
       * Cheap path, and the rule at once: a hand holding still keeps its tooltip, and
       * a hand going somewhere loses it and has to come to rest again. Measuring from
       * the last resolved point rather than testing the rectangle also means a
       * tooltip on a wide control — a preset chip, a slider's surround — does not sit
       * there while the pointer travels the length of it.
       */
      if (current && !movedEnoughToDismiss(current.at, to)) return;

      // `elementFromPoint` rather than `event.target`, which is the nearest enabled
      // ancestor when the pointer is over a disabled control.
      const under = document.elementFromPoint(to.x, to.y);
      const tip = under?.closest('[data-tip]') ?? null;
      if (!tip) {
        if (current) hide();
        return;
      }
      target.current = { el: tip, at: to };
      open(tip, false);
    };

    const onFocus = (event: FocusEvent): void => {
      const el = event.target;
      if (!(el instanceof Element)) return;
      const tip = el.closest('[data-tip]');
      // Only for keyboard focus. Showing one after a click repeats what the person
      // just did, over the thing they did it to.
      if (!tip || !tip.matches(':focus-visible')) return;
      // No pointer position to anchor against; the next real move re-resolves.
      target.current = null;
      open(tip, true);
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    // Capture, because a press means the person is acting rather than asking.
    document.addEventListener('pointerdown', hide, { capture: true });
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', hide);
    /*
     * Capture, so that Escape is seen even when something else claims it.
     *
     * A modal stops the key propagating once it has used it to close itself, which
     * left a tooltip on screen pointing at a button that had gone with the dialog.
     * This layer outlives every one of them, so it has to hear the key regardless of
     * who else answers it.
     */
    document.addEventListener('keydown', onKey, true);
    // A tooltip is positioned against a rectangle that scrolling and resizing move.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      clear();
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerdown', hide, { capture: true });
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  /*
   * Measured after paint, then placed.
   *
   * The width is not knowable before the text is in the DOM, and the placement needs
   * it to centre and to clamp — so the first frame renders it hidden rather than
   * letting a mispositioned tooltip flash at the wrong corner.
   */
  useEffect(() => {
    if (!shown || !tipRef.current) {
      setAt(null);
      return;
    }
    // Whatever it described has been taken off the page in the meantime — a dialog
    // closing under the pointer, a row re-rendered away. Describe nothing instead.
    if (!shown.el.isConnected) {
      setShown(null);
      setAt(null);
      return;
    }
    const box = tipRef.current.getBoundingClientRect();
    setAt(
      placeTooltip(
        shown.anchor,
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [shown]);

  if (!shown) return null;
  return (
    <div
      ref={tipRef}
      className={`tooltip${at ? ` ${at.side}` : ''}`}
      role="tooltip"
      // Never the accessible name: the control carries that itself in `aria-label`,
      // and announcing it twice is how a screen reader ends up saying "Play, Play".
      aria-hidden="true"
      style={at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {shown.text}
    </div>
  );
}
