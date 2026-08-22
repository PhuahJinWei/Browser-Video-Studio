/**
 * The behaviour every modal owes a person, in one place.
 *
 * Three things were built once, in the confirm/prompt dialog, and then not inherited
 * by the two modals written by hand — export and the project browser. Each is the
 * same failure seen from a different seat:
 *
 *  - Escape did nothing, so someone who opened Export by accident had to work out
 *    that the dark area is clickable. A modal that cannot be dismissed the universal
 *    way is a modal that feels stuck, and feeling stuck is what makes people close
 *    the tab.
 *  - Tab walked straight out of the dialog into the sixty controls behind the
 *    backdrop, which are visible, unreachable by mouse, and still focusable. A
 *    keyboard user tabbed off the end of the export settings and vanished into an
 *    editor they could no longer see.
 *  - Focus never entered the dialog at all, so the first keystroke after opening one
 *    went to whatever was behind it.
 *
 * A stack rather than a single active modal, because the project browser opens a
 * confirm on top of itself when deleting. Only the topmost handles keys; the ones
 * underneath wait their turn, and each restores focus to wherever it was when it
 * opened, so closing the confirm puts you back in the list you were deleting from.
 */

import { useEffect, useRef, type RefObject } from 'react';

/**
 * What Tab is allowed to reach.
 *
 * `:not([tabindex='-1'])` matters for the dialog container itself, which is made
 * focusable only so that focus can be parked on it — it is a destination, never a
 * stop on the way round.
 */
const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Everything inside `root` that Tab can reach, in document order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      // A control in a collapsed section has no box, and focusing it would scroll
      // to a place with nothing to see.
      (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement),
  );
}

/**
 * Where Tab should land, given where it is now.
 *
 * `current` of -1 means focus is not on any of them — either parked on the dialog
 * itself, or escaped behind the backdrop before the trap caught it. Both want the
 * same answer: the near end, in the direction of travel.
 */
export function wrapFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}

/**
 * Whether Tab from here would leave the dialog.
 *
 * Only the ends are intercepted. Tabbing between two fields in the middle is the
 * browser's job, and doing it by hand instead would quietly drop everything native
 * ordering gets right — radio groups, `tabindex`, shadow content.
 */
export function atTrapEdge(count: number, current: number, backwards: boolean): boolean {
  if (count <= 0) return true;
  if (current < 0) return true;
  return backwards ? current === 0 : current === count - 1;
}

/** Innermost first, so a confirm raised over the project browser handles its own keys. */
const stack: HTMLElement[] = [];

export interface ModalShellOptions {
  /**
   * What Escape and the backdrop do, or null while the modal must not be dismissed —
   * an export mid-encode, which has its own Cancel that stops the work first.
   */
  readonly onClose: (() => void) | null;
  /**
   * What to focus on opening. Defaults to the dialog itself, so a screen reader reads
   * the title before the first control rather than announcing a button out of context.
   */
  readonly initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * Escape, a focus trap, focus on entry and focus back on the way out.
 *
 * Returns the ref to put on the modal element.
 */
export function useModalShell<T extends HTMLElement>({
  onClose,
  initialFocus,
}: ModalShellOptions): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  // Read through a ref so a changing handler does not tear down the listener and,
  // with it, the stack entry this modal's turn depends on.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const focusRef = useRef(initialFocus);
  focusRef.current = initialFocus;

  /*
   * Captured during the first render, not in the effect below.
   *
   * Effects run in declaration order across the whole component, and a modal is
   * entitled to focus something itself on the way in — the project browser focuses
   * its list so the arrow keys work immediately. That effect is declared first, so by
   * the time this one ran the "element to go back to" had already become an element
   * *inside* the dialog, which is then removed with it, and focus came back to
   * nothing. Reading it here means it is whatever was focused when the modal was
   * created, whatever any effect does afterwards.
   */
  const restoreRef = useRef<HTMLElement | null>(null);
  if (restoreRef.current === null) {
    restoreRef.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const restoreTo = restoreRef.current;
    stack.push(root);
    // Focusable only as a destination for entry and for the trap's fallback.
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    const entry = focusRef.current?.current ?? root;
    entry.focus();
    // A dialog that opens on a filled-in field is offering to replace what is in it —
    // renaming a folder starts from its current name, and typing should overwrite
    // rather than append to it.
    if (entry instanceof HTMLInputElement) entry.select();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== root) return;
      if (event.key === 'Escape') {
        const close = closeRef.current;
        if (!close) return;
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (!atTrapEdge(items.length, current, event.shiftKey)) return;
      event.preventDefault();
      items[wrapFocusIndex(items.length, current, event.shiftKey)]?.focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const at = stack.lastIndexOf(root);
      if (at >= 0) stack.splice(at, 1);
      /*
       * Only when focus belonged to the modal that is going away; a handler which has
       * already moved it somewhere deliberate should keep it there.
       *
       * `<body>` counts as belonging to it. React detaches the dialog before this
       * cleanup runs, and a focused element that is removed from the document does
       * not hand focus on to anything — it falls to the body, and the test for "still
       * inside the modal" is then false about a modal that has already gone.
       */
      const active = document.activeElement;
      const wasOurs = !active || active === document.body || root.contains(active);
      if (restoreTo?.isConnected && wasOurs) restoreTo.focus();
    };
  }, []);

  return ref;
}
