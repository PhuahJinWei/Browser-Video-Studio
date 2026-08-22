/**
 * Setting track heights: which tracks, and to what.
 *
 * The scopes matter more than the arithmetic. The seam's menu offers "this kind" and
 * the toolbar offers "all", and a scope that quietly took the wrong tracks would
 * look like the height simply not sticking.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture, run, type Fixture } from '../model/fixtures';
import type { Command } from '../model/commands';
import type { Project } from '../model/types';
import { setTrackHeightCommands } from './trackHeightActions';
import { TRACK_HEIGHT_MAX, TRACK_HEIGHT_MIN } from './trackHeight';

let f: Fixture;
let project: Project;

beforeEach(() => {
  f = makeFixture();
  // V1, V2 and A1 at three different heights, so every scope has work to do.
  project = run(
    f,
    { type: 'setTrackProps', trackId: f.v1, props: { height: 140 } },
    { type: 'setTrackProps', trackId: f.v2, props: { height: 60 } },
    { type: 'setTrackProps', trackId: f.a1, props: { height: 80 } },
  );
});

/** The tracks a command list touches. */
function touched(commands: readonly Command[]): string[] {
  return commands.flatMap((c) => (c.type === 'setTrackProps' ? [c.trackId] : []));
}

describe('scope', () => {
  it('takes every track when no kind is named', () => {
    expect(touched(setTrackHeightCommands(project, f.seqId, 100)).sort()).toEqual(
      [f.v1, f.v2, f.a1].sort(),
    );
  });

  it('takes only the video stack for video', () => {
    expect(touched(setTrackHeightCommands(project, f.seqId, 100, 'video')).sort()).toEqual(
      [f.v1, f.v2].sort(),
    );
  });

  it('takes only the audio stack for audio', () => {
    expect(touched(setTrackHeightCommands(project, f.seqId, 100, 'audio'))).toEqual([f.a1]);
  });
});

describe('what it leaves out', () => {
  it('skips tracks already at that height, so a no-op never reaches undo', () => {
    // V1 is the only one at 140.
    expect(touched(setTrackHeightCommands(project, f.seqId, 140))).toEqual([f.v2, f.a1]);
  });

  it('produces nothing at all when every track already agrees', () => {
    const level = run(
      f,
      { type: 'setTrackProps', trackId: f.v1, props: { height: 100 } },
      { type: 'setTrackProps', trackId: f.v2, props: { height: 100 } },
      { type: 'setTrackProps', trackId: f.a1, props: { height: 100 } },
    );
    expect(setTrackHeightCommands(level, f.seqId, 100)).toEqual([]);
  });

  it('says nothing about a sequence that is not there', () => {
    expect(setTrackHeightCommands(project, 'sq_nope' as never, 100)).toEqual([]);
  });
});

describe('the height itself', () => {
  it('is clamped, so a menu can never ask for one the drag could not reach', () => {
    const tall = setTrackHeightCommands(project, f.seqId, 9999);
    const short = setTrackHeightCommands(project, f.seqId, -50);

    for (const command of tall) {
      expect(command.type === 'setTrackProps' && command.props.height).toBe(TRACK_HEIGHT_MAX);
    }
    for (const command of short) {
      expect(command.type === 'setTrackProps' && command.props.height).toBe(TRACK_HEIGHT_MIN);
    }
  });
});
