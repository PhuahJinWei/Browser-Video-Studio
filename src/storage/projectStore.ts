/**
 * Project persistence.
 *
 * Layout in OPFS:
 *   projects/<projectId>/project.json     the document
 *   projects/<projectId>/media/<assetId>  a copy of each imported file
 *   projects/index.json                   list of projects, newest first
 *
 * Media is copied rather than referenced so a project still opens after the user
 * moves or renames the original file. Copies are skipped above a size threshold,
 * in which case reopening asks for the file again.
 */

import { migrateProject } from '../model/migrations';
import type { AssetId, Project, ProjectId } from '../model/types';
import { validateProject } from '../model/validate';
import * as opfs from './opfs';

const INDEX_PATH = 'projects/index.json';

export interface ProjectSummary {
  readonly id: ProjectId;
  readonly name: string;
  readonly modifiedAt: number;
  readonly assetCount: number;
  readonly clipCount: number;
}

interface ProjectIndex {
  readonly projects: readonly ProjectSummary[];
}

function projectDir(id: ProjectId): string {
  return `projects/${id}`;
}

function mediaPath(id: ProjectId, assetId: AssetId): string {
  return `${projectDir(id)}/media/${assetId}`;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<readonly ProjectSummary[]> {
  const index = await opfs.readJson<ProjectIndex>(INDEX_PATH);
  return index?.projects ?? [];
}

async function updateIndex(summary: ProjectSummary): Promise<void> {
  const existing = await listProjects();
  const others = existing.filter((p) => p.id !== summary.id);
  const projects = [summary, ...others].sort((a, b) => b.modifiedAt - a.modifiedAt);
  await opfs.writeJson(INDEX_PATH, { projects } satisfies ProjectIndex);
}

function summarise(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    modifiedAt: project.modifiedAt,
    assetCount: Object.keys(project.assets).length,
    clipCount: Object.keys(project.clips).length,
  };
}

// ---------------------------------------------------------------------------
// Save / load
// ---------------------------------------------------------------------------

/**
 * Write the document. `modifiedAt` is stamped here rather than in the commands
 * layer, which is pure and never reads the clock.
 */
export async function saveProject(project: Project): Promise<void> {
  const stamped: Project = { ...project, modifiedAt: Date.now() };
  await opfs.writeJson(`${projectDir(project.id)}/project.json`, stamped);
  await updateIndex(summarise(stamped));
}

/** Copy an imported file alongside the project so it survives a reload. */
export async function saveMedia(
  projectId: ProjectId,
  assetId: AssetId,
  file: Blob,
  maxBytes: number,
): Promise<boolean> {
  if (file.size > maxBytes) return false;
  await opfs.writeFile(mediaPath(projectId, assetId), file);
  return true;
}

export async function loadMedia(projectId: ProjectId, assetId: AssetId): Promise<File | null> {
  return opfs.readFile(mediaPath(projectId, assetId));
}

export interface LoadedProject {
  readonly project: Project;
  readonly media: ReadonlyMap<AssetId, File>;
  /** Assets whose media could not be restored; their clips will not render. */
  readonly missingAssetIds: readonly AssetId[];
}

/** Read a project and whatever media is still cached beside it. */
export async function loadProject(id: ProjectId): Promise<LoadedProject | null> {
  const stored = await opfs.readJson<unknown>(`${projectDir(id)}/project.json`);
  if (!stored) return null;

  // Bring an older file forward before validating, since validation rejects any
  // schema version that is not the current one.
  const project = migrateProject(stored);

  // A corrupt or partially written file must not take the whole app down.
  const violations = validateProject(project);
  if (violations.length > 0) {
    throw new Error(
      `Saved project is invalid (${violations.length} problem(s)): ${violations
        .slice(0, 3)
        .map((v) => `${v.path}: ${v.message}`)
        .join('; ')}`,
    );
  }

  const media = new Map<AssetId, File>();
  const missing: AssetId[] = [];
  for (const assetId of Object.keys(project.assets) as AssetId[]) {
    const file = await loadMedia(id, assetId);
    if (file) media.set(assetId, file);
    else missing.push(assetId);
  }

  return { project, media, missingAssetIds: missing };
}

/** The most recently modified project, or null when there is none. */
export async function loadMostRecent(): Promise<LoadedProject | null> {
  const [newest] = await listProjects();
  if (!newest) return null;
  try {
    return await loadProject(newest.id);
  } catch {
    return null;
  }
}

export async function deleteProject(id: ProjectId): Promise<void> {
  await opfs.remove(projectDir(id), true);
  const projects = (await listProjects()).filter((p) => p.id !== id);
  await opfs.writeJson(INDEX_PATH, { projects } satisfies ProjectIndex);
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

/**
 * Debounced writer.
 *
 * Coalesces bursts of edits into one write, and never runs two writes at once —
 * overlapping `createWritable` calls on the same file can interleave and truncate.
 */
export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Project | null = null;
  private writing = false;
  private lastError: Error | null = null;

  constructor(
    private readonly delayMs = 800,
    private readonly onError?: (error: Error) => void,
  ) {}

  get error(): Error | null {
    return this.lastError;
  }

  schedule(project: Project): void {
    this.pending = project;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writing) return;

    const project = this.pending;
    this.pending = null;
    if (!project) return;

    this.writing = true;
    try {
      await saveProject(project);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      this.onError?.(this.lastError);
    } finally {
      this.writing = false;
      // An edit that landed mid-write still needs saving.
      if (this.pending) this.schedule(this.pending);
    }
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
