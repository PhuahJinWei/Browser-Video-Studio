/**
 * Where the play head actually is, kept outside the document.
 *
 * It used to live in the project, at `sequence.view.playhead`, written on every tick
 * through `runTransient` — a back door that existed only to keep the position off
 * the undo stack. Nine components subscribe to the document, so moving a two-pixel
 * line re-rendered the timeline, the inspector, the media bin, the menu bar and the
 * monitor. Measured at 28 ms on an empty sequence and 43 ms with eighteen clips,
 * forty times a second: the transport was spending more than the frame budget on
 * React, and playback ran at 45–53 fps with a third of its position updates dropped.
 *
 * A position is not part of a document. It is not edited, it is not undone, and two
 * people opening the same project do not need to agree on it. So it lives here, in a
 * channel with no React attached: consumers that draw it subscribe and write to the
 * DOM themselves, and the document keeps a copy only so a reopened project starts
 * where it was left.
 */

import { useSyncExternalStore } from 'react';
import * as T from '../model/time';
import type { Time } from '../model/types';

/** Which monitor the transport is driving. */
export type PlaybackMode = 'program' | 'source';

export interface PlaybackState {
  /** Live position, in the timebase of whatever `mode` names. */
  readonly position: Time;
  readonly playing: boolean;
  readonly mode: PlaybackMode;
  /** Length of the thing being played, so a scrubber can scale itself. */
  readonly duration: Time;
}

const INITIAL: PlaybackState = {
  position: T.TIME_ZERO,
  playing: false,
  mode: 'program',
  duration: T.TIME_ZERO,
};

export type PlaybackListener = (state: PlaybackState) => void;

class PlaybackChannel {
  private state: PlaybackState = INITIAL;
  private readonly listeners = new Set<PlaybackListener>();
  /** Bumped on every change, so `useSyncExternalStore` can tell them apart cheaply. */
  private version = 0;

  get(): PlaybackState {
    return this.state;
  }

  getVersion(): number {
    return this.version;
  }

  /**
   * Apply a change and tell everyone, synchronously.
   *
   * Synchronous on purpose: a play head that lags the audio by a frame is the one
   * thing this is for. Listeners write to the DOM directly, so there is no render to
   * batch and nothing is gained by deferring.
   */
  set(patch: Partial<PlaybackState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof PlaybackState)[]) {
      const next = patch[key];
      if (next === undefined) continue;
      const current = this.state[key];
      // Times are compared by value, not by their num/den or their identity: the
      // engine builds a fresh object every tick, and a half expressed as 2/4 is the
      // same instant as one expressed as 1/2. Anything stricter repaints forever on
      // a transport that is not moving.
      const same =
        key === 'position' || key === 'duration'
          ? T.cmp(current as Time, next as Time) === 0
          : current === next;
      if (!same) changed = true;
    }
    if (!changed) return;

    this.state = { ...this.state, ...patch };
    this.version++;
    for (const listener of this.listeners) listener(this.state);
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * The one channel.
 *
 * A module singleton rather than context: the engine, the store and several
 * imperative painters all need it, and threading it through props would put it back
 * into the render path this exists to leave.
 */
export const playback = new PlaybackChannel();

/**
 * Subscribe a React component to part of the transport.
 *
 * For values that change rarely — whether it is playing, which monitor is live.
 * **Not** for the position: selecting that would re-render on every tick and undo
 * the whole point. Draw the position with `subscribe` and a ref instead.
 */
export function usePlayback<Selected>(
  select: (state: PlaybackState) => Selected,
): Selected {
  return useSyncExternalStore(
    (onChange) => playback.subscribe(onChange),
    () => select(playback.get()),
    () => select(INITIAL),
  );
}

/** Position as a fraction of the duration, for rails and scrubbers. */
export function playbackProgress(state: PlaybackState): number {
  const total = T.toSeconds(state.duration);
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(1, T.toSeconds(state.position) / total));
}
