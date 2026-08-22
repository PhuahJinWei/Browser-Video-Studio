/**
 * The first three moves: which one is a person on.
 */

import { describe, expect, it } from 'vitest';
import { FIRST_STEPS, firstStepStates, type FirstStepKey, type FirstStepState } from './firstSteps';

/** The states keyed by step, which is what every assertion here is really about. */
function states(hasMedia: boolean, hasClips: boolean): Record<FirstStepKey, FirstStepState> {
  return Object.fromEntries(
    firstStepStates({ hasMedia, hasClips }).map(({ step, state }) => [step.key, state]),
  ) as Record<FirstStepKey, FirstStepState>;
}

describe('where the person stands', () => {
  it('starts on importing, with the rest ahead', () => {
    expect(states(false, false)).toEqual({ import: 'now', arrange: 'later', export: 'later' });
  });

  it('moves to the timeline once there is media', () => {
    expect(states(true, false)).toEqual({ import: 'done', arrange: 'now', export: 'later' });
  });

  it('moves to exporting once there is a clip', () => {
    expect(states(true, true)).toEqual({ import: 'done', arrange: 'done', export: 'now' });
  });

  /*
   * Deleting every clip puts the mark back on the timeline step rather than leaving
   * it stranded on export, which is what a "furthest reached" counter would do.
   */
  it('walks back when the timeline is emptied again', () => {
    expect(states(true, true).arrange).toBe('done');
    expect(states(true, false).arrange).toBe('now');
  });

  it('marks exactly one step as the current one', () => {
    for (const media of [false, true]) {
      for (const clips of [false, true]) {
        const now = firstStepStates({ hasMedia: media, hasClips: clips }).filter(
          (entry) => entry.state === 'now',
        );
        expect(now).toHaveLength(1);
      }
    }
  });

  it('keeps all three visible from the start, in order', () => {
    const listed = firstStepStates({ hasMedia: false, hasClips: false }).map((e) => e.step.key);
    expect(listed).toEqual(['import', 'arrange', 'export']);
    expect(listed).toHaveLength(FIRST_STEPS.length);
  });

  /*
   * Clips without media is not a state the library can reach by importing, but a
   * title or a colour is a clip with no asset behind it — so it is reachable, and the
   * mark must not skip back over a step that genuinely is not done.
   */
  it('does not mark importing done just because a generated clip exists', () => {
    expect(states(false, true)).toEqual({ import: 'now', arrange: 'done', export: 'later' });
  });
});

describe('what each step says', () => {
  it('names a real control rather than describing one', () => {
    const detail = (key: FirstStepKey): string =>
      FIRST_STEPS.find((step) => step.key === key)!.detail;
    expect(detail('import')).toContain('Ctrl+I');
    expect(detail('arrange')).toContain('Add to timeline');
    expect(detail('export')).toContain('Ctrl+E');
  });

  it('gives every step a title and a detail', () => {
    for (const step of FIRST_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.detail.length).toBeGreaterThan(0);
    }
  });
});
