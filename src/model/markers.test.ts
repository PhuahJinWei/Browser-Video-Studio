/**
 * Markers: adding, editing and removing them.
 *
 * They were addable and removable long before anything drew one, so `setMarkerProps`
 * is the piece that was missing — a marker you cannot name or recolour is only ever
 * a dot on the ruler.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { makeFixture, run, runFrom, sec, type Fixture } from './fixtures';
import type { MarkerId, Project } from './types';

let f: Fixture;

beforeEach(() => {
  f = makeFixture();
});

function markerIds(p: Project): readonly MarkerId[] {
  return p.sequences[f.seqId]!.markerIds;
}

describe('adding one', () => {
  it('puts it in the document and on the sequence', () => {
    const p = run(f, { type: 'addMarker', sequenceId: f.seqId, at: sec(2), name: 'Intro ends' });

    expect(markerIds(p).length).toBe(1);
    const marker = p.markers[markerIds(p)[0]!]!;
    expect(marker).toMatchObject({ at: sec(2), name: 'Intro ends' });
  });

  it('gives an unnamed one a colour to be drawn in anyway', () => {
    const p = run(f, { type: 'addMarker', sequenceId: f.seqId, at: sec(1) });
    const marker = p.markers[markerIds(p)[0]!]!;

    expect(marker.name).toBe('');
    expect(marker.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('keeps several in the order they were dropped', () => {
    const p = run(
      f,
      { type: 'addMarker', sequenceId: f.seqId, at: sec(5), name: 'B' },
      { type: 'addMarker', sequenceId: f.seqId, at: sec(1), name: 'A' },
    );
    expect(markerIds(p).map((id) => p.markers[id]!.name)).toEqual(['B', 'A']);
  });
});

describe('editing one', () => {
  let base: Project;
  let markerId: MarkerId;

  beforeEach(() => {
    base = run(f, { type: 'addMarker', sequenceId: f.seqId, at: sec(2), name: 'Intro ends' });
    markerId = markerIds(base)[0]!;
  });

  it('renames it without moving it', () => {
    const p = runFrom(f, base, { type: 'setMarkerProps', markerId, props: { name: 'Chorus' } });

    expect(p.markers[markerId]).toMatchObject({ name: 'Chorus', at: sec(2) });
  });

  it('recolours it without touching the name', () => {
    const p = runFrom(f, base, { type: 'setMarkerProps', markerId, props: { color: '#7d5cd6' } });

    expect(p.markers[markerId]).toMatchObject({ color: '#7d5cd6', name: 'Intro ends' });
  });

  it('accepts an empty name, which is a marker with no label rather than no marker', () => {
    const p = runFrom(f, base, { type: 'setMarkerProps', markerId, props: { name: '' } });

    expect(p.markers[markerId]!.name).toBe('');
    expect(markerIds(p).length).toBe(1);
  });

  it('refuses to edit one that is not there', () => {
    expect(() =>
      runFrom(f, base, { type: 'setMarkerProps', markerId: 'mk_nope' as MarkerId, props: { name: 'x' } }),
    ).toThrow();
  });
});

describe('removing one', () => {
  it('takes it off the sequence as well as out of the document', () => {
    const base = run(f, { type: 'addMarker', sequenceId: f.seqId, at: sec(2), name: 'Intro ends' });
    const markerId = markerIds(base)[0]!;

    const p = runFrom(f, base, { type: 'removeMarker', markerId });

    expect(p.markers[markerId]).toBeUndefined();
    expect(markerIds(p)).toEqual([]);
  });
});
