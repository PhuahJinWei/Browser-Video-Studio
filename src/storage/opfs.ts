/**
 * Origin Private File System helpers.
 *
 * OPFS is where media copies, project files and caches live. It is origin-scoped and
 * never leaves the machine, which is what lets the editor work on multi-gigabyte
 * projects without a server.
 */

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!opfsAvailable()) throw new StorageError('OPFS is not available in this browser');
  return navigator.storage.getDirectory();
}

/** Walk (and optionally create) a slash-separated directory path. */
async function directory(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let handle = await root();
  for (const segment of path.split('/').filter(Boolean)) {
    handle = await handle.getDirectoryHandle(segment, { create });
  }
  return handle;
}

function split(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/');
  return index < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, index), name: path.slice(index + 1) };
}

export async function writeFile(path: string, data: Blob | ArrayBuffer | string): Promise<void> {
  const { dir, name } = split(path);
  const parent = await directory(dir, true);
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data as FileSystemWriteChunkType);
  } finally {
    await writable.close();
  }
}

export async function readFile(path: string): Promise<File | null> {
  try {
    const { dir, name } = split(path);
    const parent = await directory(dir, false);
    const handle = await parent.getFileHandle(name, { create: false });
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function readText(path: string): Promise<string | null> {
  const file = await readFile(path);
  return file ? file.text() : null;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

export async function readJson<T>(path: string): Promise<T | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function remove(path: string, recursive = false): Promise<void> {
  try {
    const { dir, name } = split(path);
    const parent = await directory(dir, false);
    await parent.removeEntry(name, { recursive });
  } catch {
    // Already gone; deleting is idempotent by design.
  }
}

export async function list(path: string): Promise<readonly string[]> {
  try {
    const handle = await directory(path, false);
    const names: string[] = [];
    // `keys()` is an async iterator on FileSystemDirectoryHandle.
    for await (const name of (handle as unknown as { keys(): AsyncIterable<string> }).keys()) {
      names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

export async function exists(path: string): Promise<boolean> {
  return (await readFile(path)) !== null;
}

/** Bytes used and available, when the browser will say. */
export async function usage(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  if (!estimate) return null;
  return { usedBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0 };
}
