/**
 * The last line before a white window.
 *
 * A throw during render unmounts the whole tree, and React's default for that is a
 * blank page with the reason in a console nobody has open. The project itself is
 * safe — it lives in origin storage, not in the component tree — so the honest thing
 * is to say what happened and offer the two things that actually recover it.
 *
 * Only render and lifecycle errors reach here; React does not route event-handler
 * throws through a boundary. That is the right split for this app, because edits go
 * through `run`/`runMany`, which already catch and surface a failed command without
 * disturbing the UI. What lands here is the other kind: a document the UI cannot
 * draw, which is what an over-large exact time used to produce.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  /** Step the document back one edit, when there is one to step back to. */
  readonly onUndo?: () => void;
  readonly canUndo?: () => boolean;
}

interface State {
  readonly error: Error | null;
  readonly componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Still worth the console: the stack is the only place the full trace lives.
    console.error('Unhandled error while rendering', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private readonly retry = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  private readonly undoAndRetry = (): void => {
    this.props.onUndo?.();
    this.retry();
  };

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    // The edit that broke it is the one at the top of the stack, so stepping back is
    // usually the whole fix — offered only when there is something to step back to.
    const undoable = this.props.onUndo !== undefined && (this.props.canUndo?.() ?? false);

    return (
      <div className="crash-screen" role="alert">
        <div className="crash-panel">
          <h1>Something went wrong drawing the editor.</h1>
          <p className="crash-lead">
            Your project is saved on this device and has not been lost. This is the
            editor failing to draw it, not the document going missing.
          </p>
          <pre className="crash-message">{error.message || String(error)}</pre>
          <div className="crash-actions">
            {undoable && (
              <button className="primary" onClick={this.undoAndRetry}>
                Undo the last edit and try again
              </button>
            )}
            <button onClick={this.retry}>Try again</button>
            <button onClick={() => window.location.reload()}>Reload the editor</button>
          </div>
          {componentStack && (
            <details className="crash-detail">
              <summary>Technical detail</summary>
              <pre>
                {error.stack ?? error.message}
                {componentStack}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
