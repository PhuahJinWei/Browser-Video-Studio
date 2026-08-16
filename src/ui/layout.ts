/**
 * Panel layout: how wide the side panels are, what is collapsed, how the library
 * lists itself.
 *
 * Deliberately not part of the project document. It describes this browser rather
 * than the edit, so opening the same project on another machine should not drag
 * someone else's panel sizes along with it — and a divider drag has no business in
 * the undo history.
 */

import { create } from 'zustand';

export type LibraryView = 'grid' | 'list';

/**
 * Bounds for the side panels.
 *
 * The lower bounds match the minimums the middle row's grid enforces, so dragging a
 * divider can never leave a panel narrower than its own content.
 */
export const BIN_MIN = 190;
export const BIN_MAX = 520;
export const INSPECTOR_MIN = 220;
export const INSPECTOR_MAX = 520;

export interface LayoutState {
  readonly binWidth: number;
  readonly inspectorWidth: number;
  readonly inspectorOpen: boolean;
  readonly libraryView: LibraryView;

  setBinWidth: (px: number) => void;
  setInspectorWidth: (px: number) => void;
  setInspectorOpen: (open: boolean) => void;
  toggleInspector: () => void;
  setLibraryView: (view: LibraryView) => void;
}

const STORAGE_KEY = 'bvs.layout.v1';

interface StoredLayout {
  binWidth?: unknown;
  inspectorWidth?: unknown;
  inspectorOpen?: unknown;
  libraryView?: unknown;
}

const DEFAULTS = {
  binWidth: 240,
  inspectorWidth: 280,
  // Open to begin with: a panel nobody knows about is the problem a collapsible one
  // is supposed to solve, not create. One click hides it for good.
  inspectorOpen: true,
  libraryView: 'grid' as LibraryView,
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Read what was saved, ignoring anything that does not look right. */
function load(): typeof DEFAULTS {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const stored = JSON.parse(raw) as StoredLayout;

    return {
      binWidth:
        typeof stored.binWidth === 'number' ? clamp(stored.binWidth, BIN_MIN, BIN_MAX) : DEFAULTS.binWidth,
      inspectorWidth:
        typeof stored.inspectorWidth === 'number'
          ? clamp(stored.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX)
          : DEFAULTS.inspectorWidth,
      inspectorOpen:
        typeof stored.inspectorOpen === 'boolean' ? stored.inspectorOpen : DEFAULTS.inspectorOpen,
      libraryView: stored.libraryView === 'list' ? 'list' : DEFAULTS.libraryView,
    };
  } catch {
    // A corrupt or unavailable store is not worth failing to start over.
    return DEFAULTS;
  }
}

function save(state: LayoutState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        binWidth: state.binWidth,
        inspectorWidth: state.inspectorWidth,
        inspectorOpen: state.inspectorOpen,
        libraryView: state.libraryView,
      }),
    );
  } catch {
    // Private browsing, a full quota — the layout simply will not persist.
  }
}

export const useLayout = create<LayoutState>((set, get) => {
  const persist = (): void => save(get());

  return {
    ...load(),

    setBinWidth: (px) => {
      set({ binWidth: clamp(px, BIN_MIN, BIN_MAX) });
      persist();
    },
    setInspectorWidth: (px) => {
      set({ inspectorWidth: clamp(px, INSPECTOR_MIN, INSPECTOR_MAX) });
      persist();
    },
    setInspectorOpen: (open) => {
      set({ inspectorOpen: open });
      persist();
    },
    toggleInspector: () => {
      set({ inspectorOpen: !get().inspectorOpen });
      persist();
    },
    setLibraryView: (view) => {
      set({ libraryView: view });
      persist();
    },
  };
});
