/**
 * The animation-frame loop behind edge scrolling.
 *
 * The case worth guarding is re-entrancy: the loop's body re-runs the gesture it
 * scrolls for, and that gesture reports its pointer back, so the body calls `start`
 * from inside itself on every frame. That used to book a second frame each time and
 * lose the handle for it.
 */

import { describe, expect, it } from 'vitest';
import { createFrameLoop, type FrameHost } from './edgeScroll';

/** A hand-cranked `requestAnimationFrame`. */
function fakeHost(): FrameHost & { flush(): number; readonly pending: number; readonly cancelled: number } {
  let next = 1;
  let booked = new Map<number, () => void>();
  let cancelled = 0;
  return {
    request(callback) {
      const handle = next++;
      booked.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      if (booked.delete(handle)) cancelled++;
    },
    /** Run everything booked for this frame; returns how many ran. */
    flush() {
      const due = [...booked.values()];
      booked = new Map();
      for (const callback of due) callback();
      return due.length;
    },
    get pending() {
      return booked.size;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

describe('a loop whose body starts it again', () => {
  it('still runs its body exactly once per frame', () => {
    const host = fakeHost();
    let runs = 0;
    const loop = createFrameLoop(() => {
      runs++;
      // What an edge-scroll tick does: re-runs the gesture, which reports back.
      loop.start();
    }, host);

    loop.start();
    for (let frame = 0; frame < 10; frame++) {
      expect(host.flush()).toBe(1);
    }

    expect(runs).toBe(10);
    expect(host.pending).toBe(1);
  });

  it('never leaves a frame booked that nothing holds the handle for', () => {
    const host = fakeHost();
    const loop = createFrameLoop(() => loop.start(), host);

    loop.start();
    for (let frame = 0; frame < 8; frame++) host.flush();

    // One stop must be enough to end it, however long it ran.
    loop.stop();
    expect(host.pending).toBe(0);
    expect(loop.running).toBe(false);
    expect(host.flush()).toBe(0);
  });
});

describe('ordinary use', () => {
  it('keeps ticking once started', () => {
    const host = fakeHost();
    let runs = 0;
    const loop = createFrameLoop(() => runs++, host);

    loop.start();
    host.flush();
    host.flush();
    host.flush();

    expect(runs).toBe(3);
    expect(loop.running).toBe(true);
  });

  it('ignores a second start', () => {
    const host = fakeHost();
    const loop = createFrameLoop(() => {}, host);

    loop.start();
    loop.start();
    loop.start();

    expect(host.pending).toBe(1);
  });

  it('stops from inside its own body without rebooking', () => {
    const host = fakeHost();
    let runs = 0;
    const loop = createFrameLoop(() => {
      runs++;
      loop.stop();
    }, host);

    loop.start();
    host.flush();

    expect(runs).toBe(1);
    expect(host.pending).toBe(0);
    expect(host.flush()).toBe(0);
  });

  it('does nothing on a stop it never started', () => {
    const host = fakeHost();
    const loop = createFrameLoop(() => {}, host);

    loop.stop();

    expect(loop.running).toBe(false);
    expect(host.pending).toBe(0);
  });

  it('can be restarted after stopping', () => {
    const host = fakeHost();
    let runs = 0;
    const loop = createFrameLoop(() => runs++, host);

    loop.start();
    host.flush();
    loop.stop();
    loop.start();
    host.flush();

    expect(runs).toBe(2);
  });
});
