import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { IconAlert } from './Icons';
import { useModalShell } from './modalShell';

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
  const confirmRef = useRef<HTMLButtonElement>(null);

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

  return (
    <DialogContext.Provider value={api}>
      {children}
      {/*
        Keyed on nothing but its own presence: the shell inside runs when this mounts,
        which is what makes focus enter the dialog rather than the effect firing once
        for a provider that is mounted for the life of the application.
      */}
      {active && (
        <StudioDialog
          active={active}
          value={value}
          setValue={setValue}
          finish={finish}
          inputRef={inputRef}
          confirmRef={confirmRef}
        />
      )}
    </DialogContext.Provider>
  );
}

function StudioDialog({
  active,
  value,
  setValue,
  finish,
  inputRef,
  confirmRef,
}: {
  active: ActiveDialog;
  value: string;
  setValue: (value: string) => void;
  finish: (result: boolean | string | null) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  confirmRef: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  /*
   * Escape, the focus trap and focus on entry come from the shared shell — the same
   * one the export and project dialogs use. This dialog is where that behaviour was
   * first written, and keeping a second copy of it here is how the three drifted
   * apart in the first place.
   *
   * Cancelling is what Escape means, so it answers as the Cancel button does: false
   * for a confirm, null for a prompt, and for a notice there is nothing to answer.
   */
  const dismiss = (): void => finish(active.kind === 'confirm' ? false : null);
  const ref = useModalShell<HTMLFormElement>({
    onClose: active.kind === 'notice' ? () => finish(true) : dismiss,
    initialFocus: active.kind === 'prompt' ? inputRef : confirmRef,
  });

  // Enter confirms, except in a prompt where the form's own submit already does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && active.kind !== 'prompt') finish(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, finish]);

  return (
        <div
          className="modal-backdrop studio-dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && active.kind === 'notice') finish(true);
          }}
        >
          <form
            ref={ref}
            className="modal studio-dialog"
            data-tone={active.danger ? 'danger' : 'default'}
            role="dialog"
            aria-modal="true"
            aria-labelledby="studio-dialog-title"
            {...(active.message ? { 'aria-describedby': 'studio-dialog-message' } : {})}
            onSubmit={(event) => {
              event.preventDefault();
              finish(active.kind === 'prompt' ? value : true);
            }}
          >
            <div className="studio-dialog-head">
              {/*
                Only where something is at stake. An icon on every dialog is the
                look of an older desktop; reserving it for the destructive case is
                what makes it mean anything when it does appear.
              */}
              {active.danger && (
                <span className="studio-dialog-icon" aria-hidden="true">
                  <IconAlert size={17} />
                </span>
              )}
              <div className="studio-dialog-copy">
                <h3 id="studio-dialog-title">{active.title}</h3>
                {active.message && (
                  <p id="studio-dialog-message" className="studio-dialog-message">
                    {active.message}
                  </p>
                )}
              </div>
            </div>
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
              <button
                ref={confirmRef}
                type="submit"
                className={active.danger ? 'danger' : 'primary'}
              >
                {active.confirmLabel ?? (active.kind === 'notice' ? 'Close' : 'OK')}
              </button>
            </div>
          </form>
        </div>
  );
}

export function useDialog(): DialogApi {
  const dialog = useContext(DialogContext);
  if (!dialog) throw new Error('useDialog must be used inside DialogProvider');
  return dialog;
}
