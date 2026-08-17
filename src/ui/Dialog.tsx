import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface BaseDialogOptions {
  readonly title: string;
  readonly message?: string;
  readonly confirmLabel?: string;
  readonly danger?: boolean;
}

interface PromptOptions extends BaseDialogOptions {
  readonly initialValue?: string;
  readonly inputLabel?: string;
  readonly placeholder?: string;
}

interface ActiveDialog extends BaseDialogOptions {
  readonly kind: 'confirm' | 'prompt' | 'notice';
  readonly initialValue?: string;
  readonly inputLabel?: string;
  readonly placeholder?: string;
  readonly resolve: (value: boolean | string | null) => void;
}

interface DialogApi {
  confirm: (options: BaseDialogOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  notice: (options: BaseDialogOptions) => Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [active, setActive] = useState<ActiveDialog | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const open = useCallback(<T extends boolean | string | null>(
    options: Omit<ActiveDialog, 'resolve'>,
  ): Promise<T> => new Promise<T>((resolve) => {
    setValue(options.initialValue ?? '');
    setActive({ ...options, resolve: resolve as ActiveDialog['resolve'] });
  }), []);

  const api: DialogApi = {
    confirm: (options) => open<boolean>({ ...options, kind: 'confirm' }),
    prompt: (options) => open<string | null>({ ...options, kind: 'prompt' }),
    notice: async (options) => {
      await open<boolean>({ ...options, kind: 'notice' });
    },
  };

  const finish = useCallback((result: boolean | string | null): void => {
    setActive((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    if (active.kind === 'prompt') inputRef.current?.select();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish(active.kind === 'confirm' ? false : null);
      if (event.key === 'Enter' && active.kind !== 'prompt') finish(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, finish]);

  return (
    <DialogContext.Provider value={api}>
      {children}
      {active && (
        <div
          className="modal-backdrop studio-dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && active.kind === 'notice') finish(true);
          }}
        >
          <form
            className="modal studio-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="studio-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              finish(active.kind === 'prompt' ? value : true);
            }}
          >
            <h3 id="studio-dialog-title">{active.title}</h3>
            {active.message && <p className="studio-dialog-message">{active.message}</p>}
            {active.kind === 'prompt' && (
              <label className="studio-dialog-field">
                {active.inputLabel && <span>{active.inputLabel}</span>}
                <input
                  ref={inputRef}
                  value={value}
                  placeholder={active.placeholder}
                  onChange={(event) => setValue(event.currentTarget.value)}
                />
              </label>
            )}
            <div className="actions">
              {active.kind !== 'notice' && (
                <button type="button" onClick={() => finish(active.kind === 'confirm' ? false : null)}>
                  Cancel
                </button>
              )}
              <button type="submit" className={active.danger ? 'danger' : 'primary'}>
                {active.confirmLabel ?? (active.kind === 'notice' ? 'Close' : 'OK')}
              </button>
            </div>
          </form>
        </div>
      )}
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogApi {
  const dialog = useContext(DialogContext);
  if (!dialog) throw new Error('useDialog must be used inside DialogProvider');
  return dialog;
}
