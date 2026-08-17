/**
 * Project files: a whole project as one file the user owns.
 *
 * Everything else in this app lives in origin-private storage, which means it is
 * gone the moment someone clears site data and cannot be carried to another
 * machine at all. This is the way out and back in — the document *and* its media in
 * a single file, so a project that opens here opens anywhere.
 *
 * Layout:
 *   0    8   magic, "BVSPROJ" + format byte
 *   8    4   manifest length in bytes, uint32 little-endian
 *   12   N   manifest, JSON in UTF-8
 *   12+N ..  media payloads, back to back, in the order the manifest lists them
 *
 * A length-prefixed manifest rather than a zip because the whole archive would be
 * stored uncompressed anyway — video and audio are already compressed — and this
 * costs no dependency and no chance of getting someone else's format subtly wrong.
 *
 * Nothing here reads bytes into memory. `Blob` parts are references, so writing a
 * bundle around a two-gigabyte file allocates almost nothing, and `File.slice`
 * on the way back is equally lazy. Both directions stream from disk.
 */

import { migrateProject } from '../model/migrations';
import type { AssetId, Project } from '../model/types';
import { validateProject } from '../model/validate';

const MAGIC = 'BVSPROJ';
/** Bumped only for a change no earlier reader could survive. */
const FORMAT_VERSION = 1;
const HEADER_BYTES = 12;

/** The extension the picker filters on and downloads are named with. */
export const PROJECT_FILE_EXTENSION = '.bvsproj';

interface MediaEntry {
  readonly assetId: AssetId;
  readonly name: string;
  readonly type: string;
  readonly bytes: number;
}

interface Manifest {
  readonly format: number;
  readonly savedAt: number;
  readonly project: Project;
  readonly media: readonly MediaEntry[];
}

function header(manifestBytes: number): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i);
  bytes[7] = FORMAT_VERSION;
  new DataView(buffer).setUint32(8, manifestBytes, true);
  return buffer;
}

/** A file name the host filesystem will accept, ending in our extension. */
export function projectFileName(name: string): string {
  const base =
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/[. ]+$/, '')
      .slice(0, 180)
      .trim() || 'project';
  return `${base}${PROJECT_FILE_EXTENSION}`;
}

/**
 * Pack a project and its media into one blob.
 *
 * Assets with no cached bytes are simply absent from the manifest — the same
 * situation as a file too large to have been copied into browser storage, and
 * handled the same way on the far side: the clips survive, the source is marked
 * missing, and re-importing it puts the picture back.
 */
export function writeProjectFile(
  project: Project,
  media: ReadonlyMap<AssetId, File>,
): Blob {
  const entries: MediaEntry[] = [];
  const payloads: File[] = [];

  for (const assetId of Object.keys(project.assets) as AssetId[]) {
    const file = media.get(assetId);
    if (!file) continue;
    entries.push({
      assetId,
      name: file.name,
      // Recorded because the bytes are stored without a name or extension, and the
      // decoder is chosen from the asset kind and this, never from guesswork.
      type: file.type,
      bytes: file.size,
    });
    payloads.push(file);
  }

  const manifest: Manifest = {
    format: FORMAT_VERSION,
    savedAt: Date.now(),
    project,
    media: entries,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  return new Blob([header(manifestBytes.length), manifestBytes, ...payloads], {
    type: 'application/octet-stream',
  });
}

export interface ReadProjectFile {
  readonly project: Project;
  readonly media: ReadonlyMap<AssetId, File>;
  /** Assets the file did not carry bytes for; their clips will not render. */
  readonly missingAssetIds: readonly AssetId[];
}

export class ProjectFileError extends Error {}

/**
 * Unpack a project file.
 *
 * Every failure mode gets a sentence someone can act on, because the input is a
 * file off a disk somewhere: it may be truncated, it may be a different format
 * entirely, it may have been written by a newer build of this app.
 */
export async function readProjectFile(file: Blob): Promise<ReadProjectFile> {
  if (file.size < HEADER_BYTES) {
    throw new ProjectFileError('That file is too small to be a project.');
  }

  const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  const magic = String.fromCharCode(...head.subarray(0, MAGIC.length));
  if (magic !== MAGIC) {
    throw new ProjectFileError('That is not a project file.');
  }
  if (head[7]! > FORMAT_VERSION) {
    throw new ProjectFileError(
      `That project file was written by a newer version of the app (format ${head[7]}).`,
    );
  }

  const manifestBytes = new DataView(head.buffer).getUint32(8, true);
  const manifestEnd = HEADER_BYTES + manifestBytes;
  if (manifestEnd > file.size) {
    throw new ProjectFileError('That project file is incomplete.');
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(await file.slice(HEADER_BYTES, manifestEnd).arrayBuffer()),
    ) as Manifest;
  } catch {
    throw new ProjectFileError('That project file is damaged and could not be read.');
  }

  // Bring an older document forward before validating, exactly as loading from
  // browser storage does — validation only accepts the current schema.
  const project = migrateProject(manifest.project);
  const violations = validateProject(project);
  if (violations.length > 0) {
    throw new ProjectFileError(
      `That project file is invalid (${violations.length} problem(s)): ` +
        violations
          .slice(0, 3)
          .map((v) => `${v.path}: ${v.message}`)
          .join('; '),
    );
  }

  const media = new Map<AssetId, File>();
  let offset = manifestEnd;
  for (const entry of manifest.media ?? []) {
    const end = offset + entry.bytes;
    // A payload running past the end means the file was cut short mid-copy. Stop
    // rather than hand the decoder a half-written video.
    if (end > file.size) {
      throw new ProjectFileError('That project file is incomplete — some media is missing.');
    }
    media.set(
      entry.assetId,
      new File([file.slice(offset, end)], entry.name, { type: entry.type }),
    );
    offset = end;
  }

  const missingAssetIds = (Object.keys(project.assets) as AssetId[]).filter(
    (id) => !media.has(id),
  );
  return { project, media, missingAssetIds };
}

/** Total size of the bundle a project would produce, for saying so up front. */
export function projectFileSize(
  project: Project,
  media: ReadonlyMap<AssetId, File>,
): number {
  let total = HEADER_BYTES + JSON.stringify(project).length;
  for (const assetId of Object.keys(project.assets) as AssetId[]) {
    total += media.get(assetId)?.size ?? 0;
  }
  return total;
}
