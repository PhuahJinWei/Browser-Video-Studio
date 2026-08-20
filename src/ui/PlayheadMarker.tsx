/**
 * Anything drawn at the play head, positioned without a render.
 *
 * The line down the timeline, the grab handle in the ruler, the fill on a scrub
 * rail: all of them are one number, updated as often as the transport ticks. Going
 * through React for that meant re-rendering every panel that reads the document
 * forty times a second. These hooks subscribe to the playback channel and write to
 * the element directly, so a tick costs one style assignment per marker.
 */

import { useEffect, useRef, type RefObject } from 'react';
import * as T from '../model/time';
import { playback, playbackProgress, type PlaybackState } from './playback';

/**
 * Drive an element from the play head, in whatever unit it is drawn in.
 *
 * `paint` runs on every transport change and once per render, so a marker follows a
 * zoom or a resize as readily as it follows playback. It is held in a ref rather
 * than in the effect's dependencies: it closes over the current zoom, which changes
 * far more often than the subscription should be torn down and rebuilt.
 */
export function usePlaybackPaint(paint: (state: PlaybackState) => void): void {
  const latest = useRef(paint);
  latest.current = paint;

  useEffect(() => {
    const run = (state: PlaybackState): void => latest.current(state);
    run(playback.get());
    return playback.subscribe(run);
  }, []);

  // Props changed — a new zoom, a new duration, a lane that grew. The subscription
  // cannot see those, so a render repaints once by hand.
  useEffect(() => {
    latest.current(playback.get());
  });
}

/** Position an absolutely placed element at the play head, in content pixels. */
export function usePlayheadLeft(
  ref: RefObject<HTMLElement | null>,
  pxPerSecond: number,
  offset = 0,
): void {
  usePlaybackPaint((state) => {
    const element = ref.current;
    if (!element) return;
    element.style.left = `${offset + Math.round(T.toSeconds(state.position) * pxPerSecond)}px`;
  });
}

/**
 * Drive a scrub rail from the play head, as a fraction of the duration.
 *
 * Written as a custom property rather than as two inline styles: the fill's width
 * and the knob's offset are the same number, and a rail that set them separately
 * would need two elements found and two writes per tick.
 */
export function usePlaybackProgress(ref: RefObject<HTMLElement | null>): void {
  usePlaybackPaint((state) => {
    const element = ref.current;
    if (!element) return;
    element.style.setProperty('--scrub-value', `${playbackProgress(state)}`);
  });
}

/** Show the play head's time, as text, at whatever rate it moves. */
export function usePlayheadText(
  ref: RefObject<HTMLElement | null>,
  format: (at: T.Time) => string,
): void {
  const formatter = useRef(format);
  formatter.current = format;

  usePlaybackPaint((state) => {
    const element = ref.current;
    if (!element) return;
    const next = formatter.current(state.position);
    // Compared before writing: assigning identical text still dirties the node and
    // costs a layout on a timecode that is only redrawn because something else moved.
    if (element.textContent !== next) element.textContent = next;
  });
}
