/**
 * Right-click menus.
 *
 * A single menu instance lives at the app root and is opened by any component
 * through `useContextMenu().open(event, items)`. Keeping one instance means only one
 * menu can ever be visible, and the outside-click and Escape handling is written once.
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  readonly label: string;
  readonly onSelect: () => void;
  readonly icon?: React.ReactNode;
  readonly disabled?: boolean;
  /** Shortcut hint shown right-aligned, e.g. "S". */
  readonly hint?: string;
  readonly danger?: boolean;
  /** Shows a tick, for entries that toggle something on and off. */
  readonly checked?: boolean;
}

/**
 * A row of colours rather than one entry per colour.
 *
 * Eight labels as eight menu lines would bury the actions underneath them, and the
 * thing being chosen is a colour — showing it beats naming it. The name rides on
 * the title attribute for anyone who needs it.
 */
export interface MenuSwatches {
  readonly kind: 'swatches';
  readonly label: string;
  readonly options: readonly { readonly value: string | null; readonly name: string }[];
  /** Which one is currently set, ticked in the row. */
  readonly value: string | null;
  readonly onPick: (value: string | null) => void;
}

export type MenuEntry = MenuItem | MenuSwatches | 'separator';

interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly entries: readonly MenuEntry[];
}

interface ContextMenuApi {
  open: (event: React.MouseEvent, entries: readonly MenuEntry[]) => void;
  close: () => void;
}

const ContextMenuContext = createContext<ContextMenuApi | null>(null);

export function useContextMenu(): ContextMenuApi {
  const api = useContext(ContextMenuContext);
  if (!api) throw new Error('useContextMenu must be used inside <ContextMenuProvider>');
  return api;
}

export function ContextMenuProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const open = useCallback((event: React.MouseEvent, entries: readonly MenuEntry[]) => {
    event.preventDefault();
    event.stopPropagation();
    if (entries.length === 0) return;
    setMenu({ x: event.clientX, y: event.clientY, entries });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  return (
    <ContextMenuContext.Provider value={{ open, close }}>
      {children}
      {menu && <Menu state={menu} onClose={close} />}
    </ContextMenuContext.Provider>
  );
}

/**
 * Renders a list of entries. Shared by the right-click menu and the menu bar so
 * both look and behave identically.
 */
export function renderMenuEntries(
  entries: readonly MenuEntry[],
  onClose: () => void,
): React.ReactNode {
  return entries.map((entry, index) =>
    entry === 'separator' ? (
      <div key={`sep-${index}`} className="menu-separator" />
    ) : 'kind' in entry ? (
      <div className="menu-swatches" key={entry.label}>
        <span className="menu-swatches-label">{entry.label}</span>
        <div className="menu-swatch-row">
          {entry.options.map((option) => (
            <button
              key={option.name}
              type="button"
              className={`menu-swatch${option.value === null ? ' none' : ''}${
                entry.value === option.value ? ' on' : ''
              }`}
              title={option.name}
              aria-label={option.name}
              style={option.value ? { background: option.value } : undefined}
              onClick={() => {
                onClose();
                entry.onPick(option.value);
              }}
            />
          ))}
        </div>
      </div>
    ) : (
      <button
        key={entry.label}
        type="button"
        className={`menu-item${entry.danger ? ' danger' : ''}`}
        disabled={entry.disabled ?? false}
        onClick={() => {
          onClose();
          entry.onSelect();
        }}
      >
        <span className="menu-icon">{entry.checked ? <Tick /> : entry.icon}</span>
        <span className="menu-label">{entry.label}</span>
        {entry.hint && <span className="menu-hint">{entry.hint}</span>}
      </button>
    ),
  );
}

function Tick(): React.JSX.Element {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}

function Menu({ state, onClose }: { state: MenuState; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: state.x, y: state.y });

  // Keep the menu on screen: flip it back inside the viewport once measured.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(state.x, window.innerWidth - rect.width - 4));
    const y = Math.max(4, Math.min(state.y, window.innerHeight - rect.height - 4));
    setPosition({ x, y });
  }, [state.x, state.y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    // Capture phase so a click anywhere dismisses before it does anything else.
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {renderMenuEntries(state.entries, onClose)}
    </div>
  );
}
