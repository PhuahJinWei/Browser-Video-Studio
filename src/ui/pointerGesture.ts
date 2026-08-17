/** True only for moves belonging to a pointer-down this surface accepted. */
export function ownsPointerGesture(activePointerId: number | null, pointerId: number): boolean {
  return activePointerId !== null && activePointerId === pointerId;
}
