/**
 * OPFS capability probe.
 *
 * `FileSystemFileHandle.createSyncAccessHandle()` is exposed **only in workers**, so
 * this check cannot run on the main thread — testing it there is always a false
 * negative. Sync access handles are the fast path we rely on for proxies and frame
 * caches, so it is worth knowing for real.
 */

export interface OpfsProbeResult {
  readonly writable: boolean;
  readonly sync: boolean;
  readonly error: string | null;
}

// The project's tsconfig uses lib.dom; workers get their own config once the engine
// lands (see docs/ARCHITECTURE.md §11). Until then, narrow the global explicitly.
const ctx = self as unknown as {
  postMessage(message: OpfsProbeResult): void;
  addEventListener(type: 'message', handler: () => void): void;
};

const PROBE_NAME = '.capability-probe';

/** lib.dom does not declare the worker-only sync API, so describe the part we use. */
interface SyncAccessHandle {
  close(): void;
}
interface SyncCapableFileHandle {
  createSyncAccessHandle?: () => Promise<SyncAccessHandle>;
}

async function probe(): Promise<OpfsProbeResult> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(PROBE_NAME, { create: true });

    const create = (handle as SyncCapableFileHandle).createSyncAccessHandle;
    let sync = false;
    if (typeof create === 'function') {
      try {
        const access = await create.call(handle);
        access.close();
        sync = true;
      } catch {
        // Present but unusable (e.g. a concurrent handle is already open).
        sync = false;
      }
    }

    await root.removeEntry(PROBE_NAME).catch(() => undefined);
    return { writable: true, sync, error: null };
  } catch (err) {
    return { writable: false, sync: false, error: String(err) };
  }
}

ctx.addEventListener('message', () => {
  void probe().then((result) => ctx.postMessage(result));
});
