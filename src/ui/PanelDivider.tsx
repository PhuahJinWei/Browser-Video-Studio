/**
 * The draggable seam between two panels.
 *
 * Reports the pointer's absolute position rather than a delta, so a drag that runs
 * past a panel's limit and comes back lands where the pointer is instead of where
 * the accumulated deltas say it should be.
 */

import { useEffect, useRef, useState } from 'react';

export function PanelDivider({
  onDrag,
  label,
  axis = 'x',
}: {
  /** Called with the pointer's position along `axis` while dragging. */
  onDrag: (position: number) => void;
  label: string;
  /**
   * Which way the seam slides. `x` is a column boundary dragged left and right,
   * `y` a row boundary dragged up and down.
   */
  axis?: 'x' | 'y';
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  // The handler is replaced every render as `onDrag` closes over fresh state; the
  // listener is registered once, so it reads the current one through a ref.
  const latest = useRef(onDrag);
  latest.current = onDrag;

  useEffect(() => {
    if (!dragging) return;

    const move = (event: PointerEvent): void => {
      event.preventDefault();
      latest.current(axis === 'x' ? event.clientX : event.clientY);
    };
    const up = (): void => setDragging(false);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // Without this the drag paints a text selection across both panels, and the
    // cursor flickers back to whatever is under it.
    document.body.classList.add(axis === 'x' ? 'resizing' : 'resizing-y');

    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing', 'resizing-y');
    };
  }, [dragging, axis]);

  return (
    <div
      className={`panel-divider${axis === 'y' ? ' horizontal' : ''}${dragging ? ' dragging' : ''}`}
      role="separator"
      // A separator between stacked rows is itself horizontal, and vice versa.
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={label}
      onPointerDown={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
    />
  );
}
