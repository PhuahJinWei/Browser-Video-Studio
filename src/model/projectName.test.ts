/**
 * Renaming a project.
 *
 * The name is what the project browser lists, and the index it reads is derived
 * from the document — so the name has to be part of the document, change through a
 * command like everything else, and never become something a row cannot show.
 */

import { describe, expect, it } from 'vitest';
import { apply } from './commands';
import { makeFixture, insertCommand, sec } from './fixtures';
import { validateProject } from './validate';

describe('setProjectName', () => {
  it('renames the project', () => {
    const f = makeFixture();
    const p = apply(f.project, { type: 'setProjectName', name: 'Wedding cut' }, f.ids);

    expect(p.name).toBe('Wedding cut');
    expect(validateProject(p)).toEqual([]);
  });

  it('trims surrounding whitespace', () => {
    const f = makeFixture();
    const p = apply(f.project, { type: 'setProjectName', name: '  Rough cut \n' }, f.ids);
    expect(p.name).toBe('Rough cut');
  });

  it('refuses an empty name', () => {
    const f = makeFixture();
    expect(() => apply(f.project, { type: 'setProjectName', name: '' }, f.ids)).toThrow();
    expect(() => apply(f.project, { type: 'setProjectName', name: '   ' }, f.ids)).toThrow();
  });

  it('leaves the edit itself alone', () => {
    const f = makeFixture();
    const withClip = apply(
      f.project,
      insertCommand(f, { trackId: f.v1, start: sec(0), duration: sec(4) }),
      f.ids,
    );
    const renamed = apply(withClip, { type: 'setProjectName', name: 'Take 2' }, f.ids);

    // A rename is metadata: nothing about the cut may move because of it.
    expect(renamed.clips).toBe(withClip.clips);
    expect(renamed.tracks).toBe(withClip.tracks);
    expect(renamed.sequences).toBe(withClip.sequences);
  });

  it('is a plain document change, so undo restores the old name', () => {
    const f = makeFixture();
    const renamed = apply(f.project, { type: 'setProjectName', name: 'Take 2' }, f.ids);

    // Commands are pure and history keeps whole snapshots, so the previous project
    // object *is* the undo state — it must still carry the name it had.
    expect(f.project.name).not.toBe('Take 2');
    expect(renamed.name).toBe('Take 2');
  });
});
