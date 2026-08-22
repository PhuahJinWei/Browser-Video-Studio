/**
 * Saved presets: a look you can put back, not a source clips point at.
 */

import { describe, expect, it } from 'vitest';
import * as T from '../model/time';
import type { ClipId, SolidClip, TitleClip, TrackId } from '../model/types';
import {
  presetClipSpec,
  presetCommands,
  presetDuration,
  presetFromClip,
  presetStyleCommands,
} from './presets';

const trackId = 'tr_1' as TrackId;
const clipId = 'cl_new' as ClipId;

const title = {
  kind: 'title',
  duration: T.time(4),
  text: 'ACME NEWS',
  style: {
    fontFamily: 'system-ui',
    fontSizePx: 72,
    fontWeight: 800,
    color: '#ffd166',
    align: 'left',
    background: '#0b3d91',
  },
} as TitleClip;

const solid = { kind: 'solid', duration: T.time(3), fill: '#1f6feb' } as SolidClip;

describe('capturing a clip', () => {
  it('keeps a title’s words and its whole style', () => {
    const preset = presetFromClip(title, 'Lower third', 'p1');

    expect(preset).toMatchObject({
      id: 'p1',
      name: 'Lower third',
      kind: 'title',
      seconds: 4,
      text: 'ACME NEWS',
    });
    expect(preset.kind === 'title' && preset.style).toEqual(title.style);
  });

  it('keeps a colour’s fill', () => {
    const preset = presetFromClip(solid, 'Brand blue', 'p2');
    expect(preset).toMatchObject({ kind: 'solid', seconds: 3, fill: '#1f6feb' });
  });

  it('keeps the length it was saved at, so it comes back the same size', () => {
    expect(T.toSeconds(presetDuration(presetFromClip(title, 'x', 'p3')))).toBe(4);
  });
});

describe('putting one back', () => {
  it('inserts a colour in a single command', () => {
    const commands = presetCommands(presetFromClip(solid, 'Brand blue', 'p'), trackId, T.time(2), clipId);

    expect(commands.length).toBe(1);
    expect(commands[0]).toMatchObject({ type: 'insertClip', trackId });
  });

  it('inserts a title and then applies the look it could not carry', () => {
    // `insertClip` has no room for a style, so the second command is what makes the
    // preset a preset rather than a plain title.
    const commands = presetCommands(presetFromClip(title, 'Lower third', 'p'), trackId, T.time(2), clipId);

    expect(commands.map((c) => c.type)).toEqual(['insertClip', 'setTitleProps']);
    expect(commands[1]).toMatchObject({ clipId, style: title.style });
  });

  it('names the clip it makes, so it can be told apart on the timeline', () => {
    const commands = presetCommands(presetFromClip(title, 'Lower third', 'p'), trackId, T.time(0), clipId);
    expect(commands[0]).toMatchObject({ clip: { name: 'Lower third' } });
  });

  it('puts it exactly where it is asked to', () => {
    const commands = presetCommands(presetFromClip(solid, 'Brand blue', 'p'), trackId, T.time(7), clipId);
    expect(commands[0]).toMatchObject({ clip: { start: T.time(7) } });
  });

  it('gives every placement its own clip id, so two drops are two clips', () => {
    const preset = presetFromClip(title, 'Lower third', 'p');
    const a = presetCommands(preset, trackId, T.time(0), 'cl_a' as ClipId);
    const b = presetCommands(preset, trackId, T.time(9), 'cl_b' as ClipId);

    expect(a[0]).toMatchObject({ clip: { clipId: 'cl_a' } });
    expect(b[0]).toMatchObject({ clip: { clipId: 'cl_b' } });
  });
});

describe('the spec, split out so both routes in can share it', () => {
  it('leaves the clip id out when the caller has not chosen one yet', () => {
    // Adding at the play head lets `planGenerated` name the clip, because it is the
    // one deciding which track it lands on.
    const spec = presetClipSpec(presetFromClip(title, 'Lower third', 'p'), T.time(1));
    expect('clipId' in spec).toBe(false);
  });

  it('carries the id through when the caller has', () => {
    const spec = presetClipSpec(presetFromClip(title, 'Lower third', 'p'), T.time(1), clipId);
    expect(spec).toMatchObject({ clipId });
  });

  it('asks for a style command only where there is a style to apply', () => {
    expect(presetStyleCommands(presetFromClip(title, 'x', 'p'), clipId).length).toBe(1);
    // A colour carries its fill on the insert itself, so nothing follows it.
    expect(presetStyleCommands(presetFromClip(solid, 'x', 'p'), clipId).length).toBe(0);
  });
});
