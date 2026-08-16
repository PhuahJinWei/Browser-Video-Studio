/**
 * Planning a transition that the clips cannot afford.
 *
 * A cross dissolve plays both clips at once, so each needs material past its own
 * cut. A clip that uses its whole source file has none — which is exactly what
 * dropping two files onto a track gives you, and by far the commonest edit anyone
 * makes. Refusing there would make transitions close to useless.
 *
 * So when the handles fall short, the overlap is taken out of the clips themselves:
 * trim each side back by the shortfall, then ripple the rest of the track earlier to
 * close the gap. The result is a real dissolve made of real frames, at the cost of a
 * shorter sequence. The alternative — repeating frozen frames, as some editors do —
 * fakes the picture instead, which this project has consistently declined to do.
 */

import type { Command } from './commands';
import { clipEnd, clipTrimHandles, trackClips } from './selectors';
import * as T from './time';
import type { Clip, ClipId, Project, Time, Transition, TrackId } from './types';

/** A cut a transition is being put on. Either side may be black. */
export interface PlannedCut {
  readonly from: Clip | null;
  readonly to: Clip | null;
}

export interface TransitionPlan {
  readonly commands: readonly Command[];
  /** Length the transition ends up with, after any clamping. */
  readonly duration: Time;
  /** Taken off the outgoing clip to make room; zero when the handles sufficed. */
  readonly borrowedFromOutgoing: Time;
  /** Taken off the incoming clip. */
  readonly borrowedFromIncoming: Time;
  /** How much shorter the sequence gets. */
  readonly shortenedBy: Time;
}

/** What each side of the cut must supply for a transition of `duration`. */
function required(
  alignment: Transition['alignment'],
  duration: Time,
): { readonly tail: Time; readonly head: Time } {
  switch (alignment) {
    case 'start':
      // Wholly after the cut: only the outgoing clip plays on.
      return { tail: duration, head: T.TIME_ZERO };
    case 'end':
      // Wholly before it: only the incoming clip starts early.
      return { tail: T.TIME_ZERO, head: duration };
    default: {
      const half = T.scale(duration, 0.5);
      return { tail: half, head: half };
    }
  }
}

/** Shortfall on one side: what is needed beyond what the handle already offers. */
function shortfall(available: Time | null, needed: Time): Time {
  // A generated clip has no source to run out of.
  if (available === null) return T.TIME_ZERO;
  return T.max(T.sub(needed, available), T.TIME_ZERO);
}

export interface PlanOptions {
  readonly duration: Time;
  readonly transitionType?: string;
  readonly alignment?: Transition['alignment'];
  /** Smallest a clip may be left at. One frame, normally. */
  readonly minimumClip: Time;
}

/**
 * Commands that put a transition on every one of `cuts`, borrowing from the clips
 * where the handles fall short.
 *
 * The same borrow is applied to every cut rather than each working out its own. A
 * linked pair's video and audio streams are rarely the exact same length, so letting
 * them borrow independently would slide the picture against the sound.
 */
export function planTransition(
  project: Project,
  cuts: readonly PlannedCut[],
  options: PlanOptions,
): TransitionPlan {
  const alignment = options.alignment ?? 'centered';
  const twoSided = cuts.filter((cut): cut is { from: Clip; to: Clip } =>
    cut.from !== null && cut.to !== null,
  );

  // A fade against black plays nothing past an edge, so it never needs a handle.
  if (twoSided.length === 0) {
    return {
      commands: cuts.map((cut) => addCommand(cut, options, alignment)),
      duration: options.duration,
      borrowedFromOutgoing: T.TIME_ZERO,
      borrowedFromIncoming: T.TIME_ZERO,
      shortenedBy: T.TIME_ZERO,
    };
  }

  // Longest transition the clips could reach even after giving up their own frames:
  // everything from a clip's in-point to the end of its source is fair game, less the
  // frame it has to keep.
  let duration = options.duration;
  for (const { from, to } of twoSided) {
    const { tailroom } = clipTrimHandles(project, from);
    const { headroom } = clipTrimHandles(project, to);
    const spareOutgoing = T.add(tailroom ?? from.duration, T.sub(from.duration, options.minimumClip));
    const spareIncoming = T.add(headroom ?? to.duration, T.sub(to.duration, options.minimumClip));

    const share = alignment === 'centered' ? 2 : 1;
    if (alignment !== 'end') duration = T.min(duration, T.mulInt(spareOutgoing, share));
    if (alignment !== 'start') duration = T.min(duration, T.mulInt(spareIncoming, share));
  }
  if (!T.isPositive(duration)) {
    return {
      commands: [],
      duration: T.TIME_ZERO,
      borrowedFromOutgoing: T.TIME_ZERO,
      borrowedFromIncoming: T.TIME_ZERO,
      shortenedBy: T.TIME_ZERO,
    };
  }

  // Worst shortfall across the cuts, so every track gives up the same amount.
  const need = required(alignment, duration);
  let fromOutgoing = T.TIME_ZERO;
  let fromIncoming = T.TIME_ZERO;
  for (const { from, to } of twoSided) {
    const handles = { out: clipTrimHandles(project, from), in: clipTrimHandles(project, to) };
    fromOutgoing = T.max(fromOutgoing, shortfall(handles.out.tailroom, need.tail));
    fromIncoming = T.max(fromIncoming, shortfall(handles.in.headroom, need.head));
  }

  const commands: Command[] = [];
  const shortenedBy = T.add(fromOutgoing, fromIncoming);

  if (T.isPositive(shortenedBy)) {
    for (const { from, to } of twoSided) {
      // Pull the outgoing clip's out-point back, which turns the frames it gives up
      // into the tail handle the overlap reads from.
      if (T.isPositive(fromOutgoing)) {
        commands.push({
          type: 'trimClip',
          clipId: from.id,
          edge: 'out',
          to: T.sub(clipEnd(from), fromOutgoing),
        });
      }
      // And push the incoming clip's in-point later, for the same reason.
      if (T.isPositive(fromIncoming)) {
        commands.push({
          type: 'trimClip',
          clipId: to.id,
          edge: 'in',
          to: T.add(to.start, fromIncoming),
        });
      }

      // Close the gap the two trims opened, taking everything downstream with it so
      // the track stays gapless.
      commands.push({
        type: 'moveClips',
        moves: rippleFrom(project, to.trackId, to.id, fromOutgoing, shortenedBy),
        mode: 'overwrite',
      });
    }
  }

  for (const cut of cuts) {
    commands.push(addCommand(cut, { ...options, duration }, alignment));
  }

  return { commands, duration, borrowedFromOutgoing: fromOutgoing, borrowedFromIncoming: fromIncoming, shortenedBy };
}

function addCommand(
  cut: PlannedCut,
  options: Pick<PlanOptions, 'duration' | 'transitionType'>,
  alignment: Transition['alignment'],
): Command {
  return {
    type: 'addTransition',
    fromClipId: cut.from?.id ?? null,
    toClipId: cut.to?.id ?? null,
    duration: options.duration,
    alignment,
    ...(options.transitionType !== undefined ? { transitionType: options.transitionType } : {}),
  };
}

/**
 * Close the gap, working from the clips' original positions.
 *
 * The incoming clip moves back only by what the *outgoing* clip gave up, because
 * trimming its own head has already pushed its start later by the rest. Everything
 * behind it moves by the full amount, since it lost nothing itself.
 */
function rippleFrom(
  project: Project,
  trackId: TrackId,
  clipId: ClipId,
  incomingBy: Time,
  laterBy: Time,
): readonly { readonly clipId: ClipId; readonly toTrackId: TrackId; readonly toStart: Time }[] {
  const clips = trackClips(project, trackId);
  const index = clips.findIndex((c) => c.id === clipId);
  if (index < 0) return [];

  return clips.slice(index).map((clip, offset) => ({
    clipId: clip.id,
    toTrackId: trackId,
    toStart: T.max(T.TIME_ZERO, T.sub(clip.start, offset === 0 ? incomingBy : laterBy)),
  }));
}
