/**
 * The project browser.
 *
 * Every project this browser has ever held lives in OPFS, and until now only the
 * newest one was reachable — the others existed but could not be got back to. This
 * is the way in: a list, ordered by when each was last touched, with the work each
 * one contains shown so the rows can be told apart before opening one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectId } from '../model/types';
import type { ProjectSummary } from '../storage/projectStore';
import { IconDownload, IconFile, IconFolder, IconText, IconTrash } from './Icons';
import { useStudio } from './store';
import { useDialog } from './Dialog';

/**
 * "3 minutes ago" up to a week, then the date.
 *
 * Recency is what the list is sorted by, so it is what the row has to convey — and
 * for the project someone closed twenty minutes ago, an exact timestamp answers a
 * question nobody asked.
 */
function whenModified(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;

  return new Date(at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** What is in it, so a row can be recognised without opening it. */
function contentsOf(project: ProjectSummary): string {
  const clips = `${project.clipCount} clip${project.clipCount === 1 ? '' : 's'}`;
  const assets = `${project.assetCount} file${project.assetCount === 1 ? '' : 's'}`;
  return project.clipCount === 0 && project.assetCount === 0 ? 'Empty' : `${clips} · ${assets}`;
}

export function OpenDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const dialog = useDialog();
  const listStoredProjects = useStudio((s) => s.listStoredProjects);
  const openStoredProject = useStudio((s) => s.openStoredProject);
  const renameStoredProject = useStudio((s) => s.renameStoredProject);
  const deleteStoredProject = useStudio((s) => s.deleteStoredProject);
  const saveProjectToFile = useStudio((s) => s.saveProjectToFile);
  const openProjectFileViaPicker = useStudio((s) => s.openProjectFileViaPicker);
  const newProject = useStudio((s) => s.newProject);
  const currentId = useStudio((s) => s.history.present.project.id);

  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null);
  const [focused, setFocused] = useState<ProjectId | null>(null);
  const [renaming, setRenaming] = useState<ProjectId | null>(null);
  const [busy, setBusy] = useState(false);
  // Read once per open, so a list that takes a moment to scroll does not re-word
  // every row underneath the pointer.
  const [now] = useState(() => Date.now());

  const listRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (): Promise<readonly ProjectSummary[]> => {
    const found = await listStoredProjects();
    setProjects(found);
    return found;
  }, [listStoredProjects]);

  useEffect(() => {
    void refresh().then((found) => setFocused((f) => f ?? found[0]?.id ?? null));
    // Focused on open, so the arrow keys work without clicking into the list first —
    // a dialog whose whole purpose is picking one of a list should already be waiting
    // for that choice.
    listRef.current?.focus();
  }, [refresh]);

  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const open = async (id: ProjectId): Promise<void> => {
    if (busy) return;
    setBusy(true);
    // Closed only on success: a project that would not load leaves the list up, so
    // the next row along is one click away instead of behind Open again.
    if (await openStoredProject(id)) onClose();
    else {
      await refresh();
      setBusy(false);
    }
  };

  const remove = async (project: ProjectSummary): Promise<void> => {
    if (busy) return;
    /*
     * Confirmed, and named. There is no undo across projects and no copy anywhere
     * else — the media went in when it was imported and this is the only place it
     * lives — so the count is spelled out rather than left to be remembered.
     */
    if (!await dialog.confirm({
      title: `Delete “${project.name}”?`,
      message: `${contentsOf(project)}. This erases the project and its stored media. It cannot be undone.`,
      confirmLabel: 'Delete project',
      danger: true,
    })) return;

    setBusy(true);
    await deleteStoredProject(project.id);
    const left = await refresh();
    setFocused(left[0]?.id ?? null);
    setBusy(false);
  };

  const saveToFile = async (project: ProjectSummary): Promise<void> => {
    if (busy) return;
    setBusy(true);
    await saveProjectToFile(project.id);
    setBusy(false);
  };

  const openFromFile = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    // Closed only when a file was actually opened, so a cancelled picker or a file
    // that would not read leaves the list where it was.
    if (await openProjectFileViaPicker()) onClose();
    else {
      await refresh();
      setBusy(false);
    }
  };

  const commitRename = async (id: ProjectId, name: string): Promise<void> => {
    setRenaming(null);
    const trimmed = name.trim();
    const before = projects?.find((p) => p.id === id)?.name;
    if (trimmed.length === 0 || trimmed === before) return;
    await renameStoredProject(id, trimmed);
    await refresh();
  };

  /*
   * Arrows move, Enter opens, Delete deletes — a list of things you pick one of
   * should be usable without the pointer. Bound on the list rather than the window
   * so the rename field keeps its own keys.
   */
  const onListKeyDown = (event: React.KeyboardEvent): void => {
    if (!projects || projects.length === 0 || renaming) return;
    const index = projects.findIndex((p) => p.id === focused);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(projects.length - 1, Math.max(0, (index === -1 ? 0 : index) + step));
      const id = projects[next]?.id;
      if (id) {
        setFocused(id);
        listRef.current?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (event.key === 'Enter' && focused) {
      event.preventDefault();
      void open(focused);
      return;
    }
    if (event.key === 'Delete' && focused) {
      event.preventDefault();
      const project = projects.find((p) => p.id === focused);
      if (project) void remove(project);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal open-dialog" onClick={(event) => event.stopPropagation()}>
        <h3>Open project</h3>
        <p className="dialog-note">
          Projects are kept in this browser on this device, and go when its site data
          does. Save one to a file to keep a copy of your own or move it elsewhere.
        </p>

        <div className="project-list" ref={listRef} tabIndex={0} onKeyDown={onListKeyDown}>
          {projects === null && <p className="empty-note">Reading browser storage…</p>}

          {projects?.length === 0 && (
            <p className="empty-note">
              Nothing saved yet. The project you are working on appears here as soon as
              it is autosaved.
            </p>
          )}

          {projects?.map((project) => {
            const isCurrent = project.id === currentId;
            return (
              <div
                key={project.id}
                data-id={project.id}
                className={`project-row${project.id === focused ? ' focused' : ''}${
                  isCurrent ? ' current' : ''
                }`}
                onClick={() => setFocused(project.id)}
                onDoubleClick={() => void open(project.id)}
              >
                <IconFolder size={18} />

                <span className="project-detail">
                  {renaming === project.id ? (
                    <input
                      ref={renameRef}
                      className="rename-field"
                      defaultValue={project.name}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) => void commitRename(project.id, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void commitRename(project.id, event.currentTarget.value);
                        if (event.key === 'Escape') setRenaming(null);
                        event.stopPropagation();
                      }}
                    />
                  ) : (
                    <span className="project-name">{project.name}</span>
                  )}
                  <span className="project-meta">
                    {whenModified(project.modifiedAt, now)} · {contentsOf(project)}
                    {isCurrent && <span className="project-badge">Open now</span>}
                  </span>
                </span>

                <span className="project-actions">
                  <button
                    className="icon"
                    title="Rename"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      setRenaming(project.id);
                    }}
                  >
                    <IconText size={15} />
                  </button>
                  <button
                    className="icon"
                    title="Save to a file, media included"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void saveToFile(project);
                    }}
                  >
                    <IconDownload size={15} />
                  </button>
                  <button
                    className="icon tint-danger"
                    title={isCurrent ? 'Delete this project and open the next one' : 'Delete'}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void remove(project);
                    }}
                  >
                    <IconTrash size={15} />
                  </button>
                  <button
                    disabled={busy || isCurrent}
                    title={isCurrent ? 'This project is already open' : `Open "${project.name}"`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void open(project.id);
                    }}
                  >
                    Open
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        <div className="actions">
          <button
            disabled={busy}
            onClick={() => void (async () => {
              if (await dialog.confirm({
                title: 'Start a new project?',
                message: 'Your current project is kept safely on this device.',
                confirmLabel: 'New project',
              })) {
                newProject();
                onClose();
              }
            })()}
          >
            <IconFile size={15} /> New project
          </button>
          <button disabled={busy} onClick={() => void openFromFile()}>
            <IconFolder size={15} /> Open a file…
          </button>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
