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
export type Theme = 'light' | 'dark';

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
  readonly theme: Theme;

  setBinWidth: (px: number) => void;
  setInspectorWidth: (px: number) => void;
  setInspectorOpen: (open: boolean) => void;
  toggleInspector: () => void;
  setLibraryView: (view: LibraryView) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'bvs.layout.v1';

interface StoredLayout {
  binWidth?: unknown;
  inspectorWidth?: unknown;
  inspectorOpen?: unknown;
  libraryView?: unknown;
  theme?: unknown;
}

const DEFAULTS = {
  binWidth: 240,
  inspectorWidth: 280,
  // Open to begin with: a panel nobody knows about is the problem a collapsible one
  // is supposed to solve, not create. One click hides it for good.
  inspectorOpen: true,
  libraryView: 'grid' as LibraryView,
  theme: 'light' as Theme,
};

/**
 * Put the theme on <html>, where the stylesheet's `[data-theme]` override looks for it.
 *
 * Light is the absence of the attribute rather than a value of its own, so the
 * default palette on bare `:root` is what renders before any script has run — there
 * is no flash of the wrong theme while the bundle loads.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
}

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
      theme: stored.theme === 'dark' ? 'dark' : DEFAULTS.theme,
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
        theme: state.theme,
      }),
    );
  } catch {
    // Private browsing, a full quota — the layout simply will not persist.
  }
}

export const useLayout = create<LayoutState>((set, get) => {
  const persist = (): void => save(get());
  const initial = load();
  // The saved choice has to reach <html> before the first paint, not on a later
  // effect, or the app opens in light and swaps to dark in front of you.
  applyTheme(initial.theme);

  return {
    ...initial,

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
    setTheme: (theme) => {
      set({ theme });
      applyTheme(theme);
      persist();
    },
    toggleTheme: () => {
      const theme: Theme = get().theme === 'dark' ? 'light' : 'dark';
      set({ theme });
      applyTheme(theme);
      persist();
    },
  };
});
