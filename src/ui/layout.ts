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

/**
 * How short and how tall the timeline may be dragged.
 *
 * The lower bound is the same one the grid used to enforce on its own; the upper is
 * only a sanity limit, since the real ceiling is how much room the middle row needs
 * and the stylesheet works that out against the window.
 */
export const TIMELINE_MIN = 160;
export const TIMELINE_MAX = 1200;
export const TIMELINE_VIDEO_RATIO_MIN = 0.2;
export const TIMELINE_VIDEO_RATIO_MAX = 0.8;
/** Room the preview and the side panels keep, whatever the timeline is dragged to. */
export const MIDDLE_MIN = 180;

export interface LayoutState {
  readonly binWidth: number;
  readonly inspectorWidth: number;
  readonly inspectorOpen: boolean;
  readonly libraryView: LibraryView;
  readonly theme: Theme;
  readonly timelineHeight: number;
  readonly timelineVideoRatio: number;
  readonly timelineVideoScrollTop: number;
  readonly timelineAudioScrollTop: number;

  setBinWidth: (px: number) => void;
  setInspectorWidth: (px: number) => void;
  setInspectorOpen: (open: boolean) => void;
  toggleInspector: () => void;
  setLibraryView: (view: LibraryView) => void;
  setTimelineHeight: (px: number) => void;
  setTimelineVideoRatio: (ratio: number) => void;
  setTimelinePaneScroll: (kind: 'video' | 'audio', px: number) => void;
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
  timelineHeight?: unknown;
  timelineVideoRatio?: unknown;
  timelineVideoScrollTop?: unknown;
  timelineAudioScrollTop?: unknown;
}

const DEFAULTS = {
  /*
   * Wide enough to browse in rather than merely to list.
   *
   * The grid reflows cards to fill whatever width it is given, so a narrow default
   * meant a single column of thumbnails and a lot of scrolling before anything had
   * even been imported. The centre column keeps its own 300px floor, so this only
   * takes room the preview was not using.
   */
  binWidth: 520,
  inspectorWidth: 280,
  // Open to begin with: a panel nobody knows about is the problem a collapsible one
  // is supposed to solve, not create. One click hides it for good.
  inspectorOpen: true,
  libraryView: 'grid' as LibraryView,
  theme: 'light' as Theme,
  // Roughly the 45% the grid used to hardcode, at a common window height.
  timelineHeight: 320,
  timelineVideoRatio: 0.5,
  timelineVideoScrollTop: 0,
  timelineAudioScrollTop: 0,
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
      timelineHeight:
        typeof stored.timelineHeight === 'number'
          ? clamp(stored.timelineHeight, TIMELINE_MIN, TIMELINE_MAX)
          : DEFAULTS.timelineHeight,
      timelineVideoRatio:
        typeof stored.timelineVideoRatio === 'number'
          ? clamp(stored.timelineVideoRatio, TIMELINE_VIDEO_RATIO_MIN, TIMELINE_VIDEO_RATIO_MAX)
          : DEFAULTS.timelineVideoRatio,
      timelineVideoScrollTop:
        typeof stored.timelineVideoScrollTop === 'number'
          ? Math.max(0, stored.timelineVideoScrollTop)
          : DEFAULTS.timelineVideoScrollTop,
      timelineAudioScrollTop:
        typeof stored.timelineAudioScrollTop === 'number'
          ? Math.max(0, stored.timelineAudioScrollTop)
          : DEFAULTS.timelineAudioScrollTop,
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
        timelineHeight: state.timelineHeight,
        timelineVideoRatio: state.timelineVideoRatio,
        timelineVideoScrollTop: state.timelineVideoScrollTop,
        timelineAudioScrollTop: state.timelineAudioScrollTop,
      }),
    );
  } catch {
    // Private browsing, a full quota — the layout simply will not persist.
  }
}

export const useLayout = create<LayoutState>((set, get) => {
  const persist = (): void => save(get());
  let timelineMotionPersistTimer: ReturnType<typeof setTimeout> | null = null;
  const persistTimelineMotion = (): void => {
    if (timelineMotionPersistTimer !== null) clearTimeout(timelineMotionPersistTimer);
    timelineMotionPersistTimer = setTimeout(() => {
      timelineMotionPersistTimer = null;
      persist();
    }, 150);
  };
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
    setTimelineHeight: (px) => {
      set({ timelineHeight: clamp(px, TIMELINE_MIN, TIMELINE_MAX) });
      persist();
    },
    setTimelineVideoRatio: (ratio) => {
      set({
        timelineVideoRatio: clamp(
          ratio,
          TIMELINE_VIDEO_RATIO_MIN,
          TIMELINE_VIDEO_RATIO_MAX,
        ),
      });
      persistTimelineMotion();
    },
    setTimelinePaneScroll: (kind, px) => {
      set(
        kind === 'video'
          ? { timelineVideoScrollTop: Math.max(0, px) }
          : { timelineAudioScrollTop: Math.max(0, px) },
      );
      // Native scroll events can fire every frame. Saving synchronously for each
      // pixel would turn a cheap pane scroll into repeated JSON/localStorage work.
      persistTimelineMotion();
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
