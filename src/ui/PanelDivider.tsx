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
}: {
  /** Called with the pointer's client X while dragging. */
  onDrag: (clientX: number) => void;
  label: string;
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
      latest.current(event.clientX);
    };
    const up = (): void => setDragging(false);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // Without this the drag paints a text selection across both panels.
    document.body.classList.add('resizing');

    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
  }, [dragging]);

  return (
    <div
      className={`panel-divider${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
    />
  );
}
