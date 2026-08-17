import { useRef } from 'react';

export interface ScrubberProps {
  /** Normalised position from the beginning (0) to the end (1). */
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly ariaLabel: string;
  readonly ariaValueText?: string;
  readonly title?: string;
  /** Normalised keyboard increment. Defaults to one percent. */
  readonly step?: number;
  /** Optional selected source range, normalised to this rail. */
  readonly range?: { readonly start: number; readonly end: number };
}

export function clampScrubValue(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/**
 * Convert a pointer position using the painted rail—not its larger hit target.
 *
 * Keeping this calculation beside the reusable control prevents future scrubbers
 * from measuring against padding while drawing their fill against the content box.
 */
export function scrubValueAtClientX(
  clientX: number,
  railLeft: number,
  railWidth: number,
): number {
  if (!Number.isFinite(railWidth) || railWidth <= 0) return 0;
  return clampScrubValue((clientX - railLeft) / railWidth);
}

/** A progress rail whose fill, knob, pointer input, and keyboard input share one scale. */
export function Scrubber({
  value,
  onChange,
  ariaLabel,
  ariaValueText,
  title,
  step = 0.01,
  range,
}: ScrubberProps): React.JSX.Element {
  const railRef = useRef<HTMLDivElement>(null);
  const activePointer = useRef<number | null>(null);
  const progress = clampScrubValue(value);
  const keyboardStep = Math.max(1 / 100_000, Math.abs(step));

  const updateFromClientX = (clientX: number): void => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect) return;
    onChange(scrubValueAtClientX(clientX, rect.left, rect.width));
  };

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (activePointer.current !== event.pointerId) return;
    activePointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className="scrub"
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      {...(ariaValueText ? { 'aria-valuetext': ariaValueText } : {})}
      {...(title ? { title } : {})}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        activePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromClientX(event.clientX);
      }}
      onPointerMove={(event) => {
        if (activePointer.current === event.pointerId) updateFromClientX(event.clientX);
      }}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onKeyDown={(event) => {
        let next: number | null = null;
        switch (event.key) {
          case 'ArrowLeft':
          case 'ArrowDown':
            next = progress - keyboardStep;
            break;
          case 'ArrowRight':
          case 'ArrowUp':
            next = progress + keyboardStep;
            break;
          case 'PageDown':
            next = progress - keyboardStep * 10;
            break;
          case 'PageUp':
            next = progress + keyboardStep * 10;
            break;
          case 'Home':
            next = 0;
            break;
          case 'End':
            next = 1;
            break;
        }
        if (next === null) return;
        event.preventDefault();
        onChange(clampScrubValue(next));
      }}
    >
      <div className="scrub-rail" ref={railRef}>
        {range && (
          <div
            className="scrub-range"
            style={{
              left: `${clampScrubValue(range.start) * 100}%`,
              width: `${Math.max(0, clampScrubValue(range.end) - clampScrubValue(range.start)) * 100}%`,
            }}
          />
        )}
        <div className="scrub-fill" style={{ width: `${progress * 100}%` }} />
        <div className="scrub-knob" style={{ left: `${progress * 100}%` }} />
      </div>
    </div>
  );
}
