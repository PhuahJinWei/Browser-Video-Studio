/**
 * Repair a document whose exact times have grown denominators too large to work with.
 *
 * Times are exact rationals, and adding two of them takes the lowest common multiple
 * of their denominators. A drag used to add a fresh pointer-derived delta — any
 * denominator up to a hundred thousand — to the start it had produced last time, so
 * with the zoom drifting between drags the denominators were coprime and multiplied:
 * sixteen thousand, then a billion, then a trillion, until the result no longer fit a
 * double and every subsequent edit threw `TimeOverflowError`. Dragging is on the
 * frame grid now and cannot compound, but documents saved before that are still out
 * there carrying the damage, and one more edit is all it takes to make them throw.
 *
 * So this runs once as a project is adopted. It is deliberately not a normalisation
 * pass over every time: a clip cut against an audio sample boundary is on a perfectly
 * sensible denominator and is left exactly as it is. Only the values that are already
 * pathological are moved, and only as far as the nearest frame.
 */

import * as T from './time';
import type { FrameRate, Project, Time } from './types';

/**
 * The largest denominator a time may carry before it is treated as damage.
 *
 * `fromSeconds` approximates within a million by default, and a 48 kHz sample
 * boundary is 48000, so everything the app produces on purpose is well inside this.
 */
export const MAX_REASONABLE_DEN = 1_000_000;

export interface TimeRepair {
  readonly project: Project;
  /** How many values had to be moved, for the status line. */
  readonly repaired: number;
}

function needsRepair(t: Time | null | undefined): boolean {
  return t !== null && t !== undefined && t.den > MAX_REASONABLE_DEN;
}

export function repairProjectTimes(project: Project): TimeRepair {
  let repaired = 0;

  /** Snap an instant to the grid; leave a healthy one untouched. */
  const instant = (t: Time, rate: FrameRate): Time => {
    if (!needsRepair(t)) return t;
    repaired++;
    return T.snapToFrame(t, rate);
  };

  /** A length may not round down to nothing, or the clip would vanish. */
  const length = (t: Time, rate: FrameRate): Time => {
    if (!needsRepair(t)) return t;
    repaired++;
    const snapped = T.snapToFrame(t, rate);
    return T.isPositive(snapped) ? snapped : T.frameDuration(rate);
  };

  // Which sequence a track belongs to decides the grid its clips are measured on.
  const rateOfTrack = new Map<string, FrameRate>();
  for (const sequence of Object.values(project.sequences)) {
    for (const trackId of [...sequence.videoTrackIds, ...sequence.audioTrackIds]) {
      rateOfTrack.set(trackId, sequence.frameRate);
    }
  }
  const anyRate = Object.values(project.sequences)[0]?.frameRate ?? T.FPS_25;

  const clips = { ...project.clips };
  for (const [id, clip] of Object.entries(clips)) {
    const rate = rateOfTrack.get(clip.trackId) ?? anyRate;
    const start = instant(clip.start, rate);
    const duration = length(clip.duration, rate);
    // Source time rides the same grid; a clip's in-point is a frame of its source.
    const sourceIn = 'sourceIn' in clip ? instant(clip.sourceIn, rate) : undefined;
    if (start === clip.start && duration === clip.duration && sourceIn === (clip as { sourceIn?: Time }).sourceIn) {
      continue;
    }
    clips[id as keyof typeof clips] = {
      ...clip,
      start,
      duration,
      ...(sourceIn !== undefined ? { sourceIn } : {}),
    } as (typeof clips)[keyof typeof clips];
  }

  const transitions = { ...project.transitions };
  for (const [id, transition] of Object.entries(transitions)) {
    const rate = rateOfTrack.get(transition.trackId) ?? anyRate;
    const duration = length(transition.duration, rate);
    const offset = transition.offset === null ? null : instant(transition.offset, rate);
    if (duration === transition.duration && offset === transition.offset) continue;
    transitions[id as keyof typeof transitions] = { ...transition, duration, offset };
  }

  const markers = { ...project.markers };
  for (const [id, marker] of Object.entries(markers)) {
    const at = instant(marker.at, anyRate);
    // A point marker is a zero length and must stay one.
    const duration = T.isZero(marker.duration) ? marker.duration : length(marker.duration, anyRate);
    if (at === marker.at && duration === marker.duration) continue;
    markers[id as keyof typeof markers] = { ...marker, at, duration };
  }

  const sequences = { ...project.sequences };
  for (const [id, sequence] of Object.entries(sequences)) {
    const playhead = instant(sequence.view.playhead, sequence.frameRate);
    if (playhead === sequence.view.playhead) continue;
    sequences[id as keyof typeof sequences] = {
      ...sequence,
      view: { ...sequence.view, playhead },
    };
  }

  if (repaired === 0) return { project, repaired: 0 };
  return { project: { ...project, clips, transitions, markers, sequences }, repaired };
}
