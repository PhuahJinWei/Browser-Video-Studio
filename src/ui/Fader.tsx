/**
 * A range input that shows where neutral is and what it is currently set to.
 *
 * The compact controls — the track fader, the master fader, the zoom slider — had
 * neither. Their value lived only in a `title`, which means hovering and waiting to
 * learn where you are, and nothing at all marked the value they were supposed to
 * return to. Both are the sort of thing a slider is expected to have and nobody
 * misses consciously; you just find the control harder to aim than it should be.
 */

import { useRef, useState } from 'react';

const RANGE_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
]);

/** Keep values supplied by typed fields on the same grid as their range input. */
export function quantizeRangeValue(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const clamped = Math.max(min, Math.min(max, value));
  if (!Number.isFinite(step) || step <= 0) return clamped;
  const decimals = Math.max(0, (String(step).split('.')[1] ?? '').length);
  const stepped = min + Math.round((clamped - min) / step) * step;
  return Number(Math.max(min, Math.min(max, stepped)).toFixed(decimals));
}

/**
 * A detent is deliberately expressed in value steps rather than pixels.
 *
 * Pixel-only snapping made a short fader swallow a huge part of its range. Five
 * one-percent steps, on the other hand, is enough to catch the 96/104% values a
 * 25px track can physically produce without turning 80–120% into one dead zone.
 */
export function snapRangeValue(
  value: number,
  neutral: number | undefined,
  step: number,
  neutralSnapSteps: number,
): number {
  if (neutral === undefined || neutralSnapSteps <= 0) return value;
  return Math.abs(value - neutral) <= Math.abs(step) * neutralSnapSteps ? neutral : value;
}

export function Fader({
  value,
  min,
  max,
  step,
  neutral,
  format,
  title,
  id,
  disabled = false,
  className,
  ariaLabel,
  thumb,
  neutralSnapSteps = 0,
  onChange,
  onCommit,
  onReset,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Where the mark goes — unity, centre, silence. Omit when there is no such value. */
  neutral?: number;
  /** Renders the value for the bubble shown while dragging. */
  format: (value: number) => string;
  title?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Half of this insets the mark and the bubble, so both track the thumb's centre. */
  thumb?: number;
  /** Pointer-only detent radius, measured in slider steps. Keyboard input stays exact. */
  neutralSnapSteps?: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
  /** Double-click returns to neutral, the way the faders already did. */
  onReset?: () => void;
}): React.JSX.Element {
  const [pulling, setPulling] = useState(false);
  const gestureActive = useRef(false);
  const pointerActive = useRef<number | null>(null);

  const span = max - min;
  const fraction = (v: number): number => (span === 0 ? 0 : (v - min) / span);

  const stop = (): void => {
    if (!gestureActive.current) return;
    gestureActive.current = false;
    pointerActive.current = null;
    setPulling(false);
    onCommit?.();
  };

  const start = (): void => {
    gestureActive.current = true;
    setPulling(true);
  };

  return (
    <span
      className={`range${neutral === undefined ? '' : ' has-neutral'}${className ? ` ${className}` : ''}`}
      style={{
        ...(neutral === undefined ? {} : { '--neutral': fraction(neutral) }),
        ...(thumb === undefined ? {} : { '--thumb': `${thumb}px` }),
        ...(pulling ? { '--at': fraction(value) } : {}),
      } as React.CSSProperties}
    >
      <input
        id={id}
        type="range"
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={value}
        title={title}
        aria-label={ariaLabel}
        aria-valuetext={format(value)}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(
            pointerActive.current === null
              ? next
              : snapRangeValue(next, neutral, step, neutralSnapSteps),
          );
        }}
        onPointerDown={(event) => {
          pointerActive.current = event.pointerId;
          start();
          event.currentTarget.setPointerCapture(event.pointerId);
          // The surface underneath is usually a drag target of its own — the track
          // header selects, the timeline scrubs — and it must not also react.
          event.stopPropagation();
        }}
        onPointerUp={(event) => {
          stop();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={stop}
        onLostPointerCapture={stop}
        // Keyboard nudging deserves the readout too.
        onKeyDown={(event) => {
          if (RANGE_KEYS.has(event.key)) start();
        }}
        onKeyUp={(event) => {
          if (RANGE_KEYS.has(event.key)) stop();
        }}
        onBlur={stop}
        {...(onReset
          ? {
              onDoubleClick: () => {
                onReset();
                // `dblclick` arrives after the second pointer-up, so that gesture
                // has already stopped. The reset itself needs its own boundary.
                onCommit?.();
              },
            }
          : {})}
      />
      {pulling && <span className="range-bubble">{format(value)}</span>}
    </span>
  );
}
