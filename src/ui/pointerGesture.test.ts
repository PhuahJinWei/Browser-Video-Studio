import { ownsPointerGesture } from './pointerGesture';

describe('pointer gesture ownership', () => {
  it('rejects a held pointer that merely enters a surface', () => {
    expect(ownsPointerGesture(null, 7)).toBe(false);
  });

  it('accepts only the pointer that began the gesture', () => {
    expect(ownsPointerGesture(7, 7)).toBe(true);
    expect(ownsPointerGesture(7, 8)).toBe(false);
  });
});
