/**
 * The transport channel.
 *
 * Its whole reason to exist is that notifying is cheap and does not go through
 * React, so the tests are about what counts as a change and what listeners see.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as T from '../model/time';
import { playback, playbackProgress } from './playback';

beforeEach(() => {
  playback.set({ position: T.TIME_ZERO, playing: false, mode: 'program', duration: T.TIME_ZERO });
});

describe('publishing a position', () => {
  it('tells listeners synchronously, so the play head cannot lag the audio', () => {
    const seen: number[] = [];
    const off = playback.subscribe((s) => seen.push(T.toSeconds(s.position)));

    playback.set({ position: T.time(2) });

    // Already there — not on a microtask, not after a render.
    expect(seen).toEqual([2]);
    off();
  });

  it('says nothing when the instant is unchanged, even from a new object', () => {
    // The engine builds a fresh Time every tick; a stopped transport would
    // otherwise repaint forever on values that never move.
    playback.set({ position: T.time(1) });
    const listener = vi.fn();
    const off = playback.subscribe(listener);

    playback.set({ position: T.time(2, 2) });

    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('compares times by value, so an equal fraction is not a move', () => {
    playback.set({ position: { num: 1, den: 2 } });
    const listener = vi.fn();
    const off = playback.subscribe(listener);

    playback.set({ position: { num: 2, den: 4 } });

    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('carries several fields in one notification', () => {
    const listener = vi.fn();
    const off = playback.subscribe(listener);

    playback.set({ position: T.time(3), playing: true });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(playback.get().playing).toBe(true);
    off();
  });

  it('stops calling a listener that has unsubscribed', () => {
    const listener = vi.fn();
    playback.subscribe(listener)();

    playback.set({ position: T.time(5) });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('progress along the rail', () => {
  it('is the position over the duration', () => {
    playback.set({ position: T.time(3), duration: T.time(12) });
    expect(playbackProgress(playback.get())).toBeCloseTo(0.25, 6);
  });

  it('is zero rather than infinite when nothing is loaded', () => {
    playback.set({ position: T.time(3), duration: T.TIME_ZERO });
    expect(playbackProgress(playback.get())).toBe(0);
  });

  it('never runs past the ends of the rail', () => {
    playback.set({ position: T.time(20), duration: T.time(10) });
    expect(playbackProgress(playback.get())).toBe(1);
  });
});
