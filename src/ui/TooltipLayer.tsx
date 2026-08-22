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
 * do", and the Transition button answers exactly that in its tooltip. `withinRect`
 * keeps the hit test off the hot path while the pointer is resting.
 */

import { useEffect, useRef, useState } from 'react';
import { placeTooltip, TOOLTIP_DELAY_MS, withinRect, type TipPlacement } from './tooltip';

interface Shown {
  readonly text: string;
  readonly anchor: DOMRect;
  /** Focus has no dwell to wait through, so it skips the delay. */
  readonly immediate: boolean;
}

export function TooltipLayer(): React.JSX.Element | null {
  const [shown, setShown] = useState<Shown | null>(null);
  const [at, setAt] = useState<TipPlacement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  /** What the pointer is currently over, delayed or not, so movement can be ignored. */
  const target = useRef<{ el: Element; rect: DOMRect } | null>(null);

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
      const show = (): void => setShown({ text, anchor, immediate });
      if (immediate) {
        clear();
        show();
      } else {
        clear();
        timer.current = window.setTimeout(show, TOOLTIP_DELAY_MS);
      }
    };

    const onMove = (event: PointerEvent): void => {
      // Cheap path: still inside whatever we already resolved, so nothing to redo.
      const current = target.current;
      if (current && withinRect(current.rect, event.clientX, event.clientY)) return;

      // `elementFromPoint` rather than `event.target`, which is the nearest enabled
      // ancestor when the pointer is over a disabled control.
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const tip = under?.closest('[data-tip]') ?? null;
      if (!tip) {
        if (current) hide();
        return;
      }
      if (current?.el === tip) return;
      target.current = { el: tip, rect: tip.getBoundingClientRect() };
      open(tip, false);
    };

    const onFocus = (event: FocusEvent): void => {
      const el = event.target;
      if (!(el instanceof Element)) return;
      const tip = el.closest('[data-tip]');
      // Only for keyboard focus. Showing one after a click repeats what the person
      // just did, over the thing they did it to.
      if (!tip || !tip.matches(':focus-visible')) return;
      target.current = { el: tip, rect: tip.getBoundingClientRect() };
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
    document.addEventListener('keydown', onKey);
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
      document.removeEventListener('keydown', onKey);
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
