/**
 * Schema migrations.
 *
 * A saved project carries the `schemaVersion` it was written with. `validateProject`
 * rejects anything that is not the current version and `loadProject` throws on a
 * rejection, so a project written by an older build must be brought forward here
 * before it is validated — otherwise bumping the version silently makes every
 * existing file unopenable.
 *
 * Each step takes the document one version forward and is written against the shape
 * of *that* version, never the current types. Steps therefore keep working when the
 * model moves on again.
 */

import type { Project } from './types';
import { SCHEMA_VERSION } from './types';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** A loosely-typed document, since older versions do not match today's `Project`. */
type RawProject = Record<string, unknown> & { schemaVersion?: unknown };

type MigrationStep = (project: RawProject) => RawProject;

/**
 * `MIGRATIONS[n]` upgrades a version-`n` document to version `n + 1`.
 *
 * Never edit a step once released: a file written last month has to travel the same
 * path it would have travelled then.
 */
const MIGRATIONS: Readonly<Record<number, MigrationStep>> = {
  /**
   * 1 → 2: clips gained `groupId` for user grouping, alongside the existing
   * `linkGroupId` for A/V pairs. Nothing was previously grouped.
   */
  1: (project) => {
    const clips = (project.clips ?? {}) as Record<string, Record<string, unknown>>;
    const migrated: Record<string, unknown> = {};
    for (const [id, clip] of Object.entries(clips)) {
      migrated[id] = { ...clip, groupId: clip.groupId ?? null };
    }
    return { ...project, clips: migrated, schemaVersion: 2 };
  },
};

export function readSchemaVersion(project: unknown): number | null {
  if (typeof project !== 'object' || project === null) return null;
  const version = (project as RawProject).schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) ? version : null;
}

export function needsMigration(project: unknown): boolean {
  const version = readSchemaVersion(project);
  return version !== null && version < SCHEMA_VERSION;
}

/**
 * Bring a stored document up to the current schema.
 *
 * Throws for a document from a *newer* build, which cannot be understood, and for a
 * version with no route forward — both are clearer than loading something subtly wrong.
 */
export function migrateProject(stored: unknown): Project {
  const version = readSchemaVersion(stored);
  if (version === null) {
    throw new MigrationError('Project file has no readable schemaVersion');
  }
  if (version > SCHEMA_VERSION) {
    throw new MigrationError(
      `Project was saved by a newer version of the editor (schema ${version}, this build reads ${SCHEMA_VERSION})`,
    );
  }

  let current = stored as RawProject;
  for (let from = version; from < SCHEMA_VERSION; from++) {
    const step = MIGRATIONS[from];
    if (!step) {
      throw new MigrationError(`No migration from schema ${from} to ${from + 1}`);
    }
    current = step(current);
  }

  return current as unknown as Project;
}
