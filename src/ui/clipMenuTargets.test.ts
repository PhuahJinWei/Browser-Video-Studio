/**
 * What a clip's right-click menu takes.
 *
 * The regression these guard: the menu used to derive its targets from the
 * selection as it stood *before* the right-click, so opening it on an unselected
 * half of a linked pair selected both and then deleted one.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { insertCommand, makeFixture, run, runFrom, sec, type Fixture } from '../model/fixtures';
import type { ClipId, Project } from '../model/types';
import { clipMenuTargets } from './clipMenuTargets';

let f: Fixture;
let project: Project;
/** Two clips on V1, one on A1. */
let a: ClipId;
let b: ClipId;
let sound: ClipId;

beforeEach(() => {
  f = makeFixture();
  project = run(
    f,
    insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4), name: 'A' }),
    insertCommand(f, { trackId: f.v1, start: sec(4), duration: sec(4), name: 'B' }),
    insertCommand(f, { trackId: f.a1, kind: 'audio', start: sec(0), duration: sec(4), name: 'S' }),
  );
  [a, b] = project.tracks[f.v1]!.clipIds as [ClipId, ClipId];
  sound = project.tracks[f.a1]!.clipIds[0]!;
});

describe('a clip that stands alone', () => {
  it('takes just itself when nothing is selected', () => {
    expect(clipMenuTargets(project, [], a)).toEqual([a]);
  });

  it('takes just itself when something else is selected', () => {
    // The menu is about to reselect, so the old selection is not what it acts on.
    expect(clipMenuTargets(project, [b], a)).toEqual([a]);
  });
});

describe('a clip that moves as part of a unit', () => {
  beforeEach(() => {
    project = runFrom(f, project, { type: 'groupClips', clipIds: [a, sound] });
  });

  it('takes the whole group even though it was not selected', () => {
    expect([...clipMenuTargets(project, [], a)].sort()).toEqual([a, sound].sort());
  });

  it('takes the whole group when a different clip was selected', () => {
    expect([...clipMenuTargets(project, [b], a)].sort()).toEqual([a, sound].sort());
  });

  it('takes the whole group when opened on the other member', () => {
    expect([...clipMenuTargets(project, [], sound)].sort()).toEqual([a, sound].sort());
  });
});

describe('an existing multi-selection', () => {
  it('is honoured as it stands, so a sweep acts on the sweep', () => {
    expect(clipMenuTargets(project, [a, b], a)).toEqual([a, b]);
  });

  it('is ignored when the menu opens outside it', () => {
    expect(clipMenuTargets(project, [a, b], sound)).toEqual([sound]);
  });
});
