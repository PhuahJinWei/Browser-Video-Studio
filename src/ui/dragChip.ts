/**
 * The thing you actually aim with while dragging something onto the timeline.
 *
 * Left to itself the browser drags a snapshot of the whole control — a library tile
 * is 157 by 118
 * pixels — anchored wherever inside it you happened to grab. The clip lands with
 * its head under the pointer, which is the right behaviour and every editor's, but
 * against a ghost that big and that far off-centre it reads as landing to the right
 * of where you aimed. The tile was never the thing being positioned; the head is.
 *
 * So: a narrow chip, with the hotspot on its leading edge, so what you point with
 * is the edge the clip will start at.
 */
export function setDragChip(event: React.DragEvent, name: string): void {
  // Anything a previous drag failed to clear. Cheap, and it keeps a missed cleanup
  // from accumulating one node per drag for the life of the session.
  for (const stale of document.querySelectorAll('.asset-drag-chip')) stale.remove();

  const chip = document.createElement('div');
  chip.className = 'asset-drag-chip';
  chip.textContent = name;
  document.body.append(chip);
  event.dataTransfer.setDragImage(chip, 0, chip.offsetHeight / 2);

  // The browser reads the element while this handler runs and never again, so the
  // node can go as soon as the task ends. A timer rather than an animation frame:
  // frames stop being delivered in a background tab, and a drag that started just
  // before the window lost focus would leave the chip behind for good.
  setTimeout(() => chip.remove(), 0);
}

