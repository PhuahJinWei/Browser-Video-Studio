/**
 * Application store.
 *
 * Holds the undo history, the selection and the engine handle. Every document edit
 * goes through `run` (recorded) or `runTransient` (not recorded) — the distinction
 * matters because the playhead lives in the document, and recording it would put
 * sixty entries a second on the undo stack.
 */

import { create } from 'zustand';
import { planTransition, type PlannedCut } from '../model/planTransition';
import { DEFAULT_TRANSITION_SECONDS } from './transitions';
import { Engine, type EngineTelemetry } from '../engine/engine';
import {
  exportSequence,
  suggestBitrate,
  type ExportDestination,
  type ExportProgress,
  type ExportSettings,
} from '../engine/export';
import type { StreamTargetChunk } from 'mediabunny';
import { isImageFile, MediaLibrary } from '../engine/media';
import { generateProxy as encodeProxy } from '../engine/proxy';
import { PreviewStore } from '../engine/previewStore';
import { apply, type Command, type NewClipSpec } from '../model/commands';
import { normaliseFolder } from '../model/commands/handlers';
import { repairProjectTimes } from '../model/repairTimes';
import { randomIdSource } from '../model/ids';
import { createProject } from '../model/factories';
import {
  breakCoalescing,
  canRedo,
  canUndo,
  commit,
  current,
  initHistory,
  push,
  redo,
  undo,
  type History,
} from '../model/history';
import {
  clipEnd,
  clipsUsingAssets,
  clipsWithin,
  expandSelection,
  getSequence,
  nearestCut,
  pairedCuts,
  sequenceDuration,
  trackDuration,
} from '../model/selectors';
import * as T from '../model/time';
import { playback } from './playback';
import { staticParam } from '../model/params';
import { encoderSafeSequenceSize } from '../model/sequenceFormat';
import type {
  Asset,
  AssetId,
  Clip,
  ClipId,
  FrameRate,
  Project,
  SequenceId,
  Size,
  ProjectId,
  Time,
  TimeRange,
  TrackId,
  TrackKind,
  TransitionId,
} from '../model/types';
import {
  PROJECT_FILE_EXTENSION,
  projectFileName,
  projectFileSize,
  readProjectFile,
  writeProjectFile,
} from '../storage/projectFile';
import {
  Autosaver,
  deleteMedia,
  deleteProxy,
  deleteProject,
  listProjects,
  loadMedia,
  loadProxy,
  loadMostRecent,
  loadProject,
  renameProject as renameStoredProject,
  saveMedia,
  saveProxy,
  saveProject,
  type LoadedProject,
  type ProjectSummary,
  type SaveState,
} from '../storage/projectStore';

const ids = randomIdSource;

/*
 * Selecting in one panel drops the selection in the other.
 *
 * Clip, track and transition selection were already exclusive, for the inspector's
 * sake. The library was left out of that, so a media item stayed lit while a clip
 * was picked on the timeline — two live selections at once, and Delete meaning
 * whichever panel happened to hold focus, which is not something the screen shows.
 * A file selected in the library and forgotten there is one keypress from taking
 * every clip cut from it, because removing media offers to remove its clips too.
 *
 * Track selection is deliberately *not* cleared by picking media: a chosen track is
 * the destination a three-point edit sends the source to, so the two are meant to
 * be held at the same time.
 */
const NO_ASSETS = { selectedAssetIds: [], assetSelectionAnchor: null } as const;
const NO_CLIPS = { selection: [], selectionAnchor: null } as const;

/** Hand a blob to the browser as a download. */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * A file name the host filesystem will actually accept.
 *
 * Timecode is full of colons and Windows rejects every one of them, so a still
 * named after the frame it came from has to be rewritten before it is offered.
 */
function safeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/, '')
    .slice(0, 180)
    .trim() || 'untitled';
}

interface BrowserFileWritable {
  write(chunk: { readonly type: 'write'; readonly position: number; readonly data: Uint8Array }): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface BrowserFileHandle {
  createWritable(): Promise<BrowserFileWritable>;
}

type SaveFilePicker = (options: {
  readonly suggestedName: string;
  readonly types: readonly {
    readonly description: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }[];
}) => Promise<BrowserFileHandle>;

/**
 * Choose a seekable destination while the Export click still owns user activation.
 * Browsers without File System Access fall back to the ordinary Blob download.
 */
async function chooseExportDestination(
  fileName: string,
  container: ExportSettings['container'],
): Promise<ExportDestination | 'fallback' | 'cancelled'> {
  const picker = (globalThis as typeof globalThis & { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (!picker) return 'fallback';

  try {
    const mime = container === 'mp4' ? 'video/mp4' : 'video/webm';
    const extension = container === 'mp4' ? '.mp4' : '.webm';
    const handle = await picker({
      suggestedName: safeFileName(fileName),
      types: [{ description: `${container.toUpperCase()} video`, accept: { [mime]: [extension] } }],
    });
    const file = await handle.createWritable();
    let aborted = false;
    let bytes = 0;
    let stream: WritableStream<StreamTargetChunk>;
    stream = new WritableStream<StreamTargetChunk>({
      write: async (chunk) => {
        if (aborted) throw new DOMException('Export cancelled', 'AbortError');
        bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
        await file.write({ type: 'write', position: chunk.position, data: chunk.data });
      },
      close: async () => {
        if (aborted) await file.abort('Export cancelled');
        else await file.close();
      },
      abort: async (reason) => {
        aborted = true;
        await file.abort(reason);
      },
    });
    return {
      writable: stream,
      cancel: () => {
        aborted = true;
        // When the muxer has not locked the stream yet this closes the native file
        // immediately; otherwise output.cancel() reaches the `close` branch above.
        void stream.abort('Export cancelled').catch(() => undefined);
      },
      byteLength: () => bytes,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    throw error;
  }
}

/** Bytes in the units a person thinks in, for anything about to hand over a file. */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(0)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function starterProject(): { project: Project; sequenceId: SequenceId } {
  const sequenceId = ids.sequence();
  const project = createProject({
    id: ids.project(),
    sequenceId,
    name: 'Untitled project',
    frameRate: T.FPS_30,
    /*
     * One of each to begin with.
     *
     * Four tracks was two more than a new project has anything to put on, and the
     * empty pair sat between the ruler and the work taking up the timeline's scarcest
     * dimension. Dropping media past the last lane makes another, and a clip carrying
     * both streams creates whatever counterpart it needs — so the ones that get used
     * still arrive on their own.
     */
    videoTrackIds: [ids.track()],
    audioTrackIds: [ids.track()],
  });
  return { project, sequenceId };
}

export interface StudioState {
  history: History;
  sequenceId: SequenceId;
  selection: readonly ClipId[];
  /** A selected track, for editing its volume, pan and effects. */
  selectedTrackId: TrackId | null;
  /** A selected transition, for editing its style, length and alignment. */
  selectedTransitionId: TransitionId | null;
  /** Where a Shift-click measures its range from: the last clip clicked plainly. */
  selectionAnchor: ClipId | null;
  /** Selected media in the library. Separate from the clip selection: one is source, the other is edit. */
  selectedAssetIds: readonly AssetId[];
  /** Where a Shift-click in the library measures from. */
  assetSelectionAnchor: AssetId | null;
  /** Null is the edited program; an id opens that library asset in the source monitor. */
  previewAssetId: AssetId | null;
  /** Current source-monitor position, kept here so global capture commands use what is visible. */
  /** Per-source edit marks; source metadata, not timeline document state. */
  sourceMarks: ReadonlyMap<AssetId, { readonly inPoint: Time | null; readonly outPoint: Time | null }>;
  engine: Engine | null;
  /** Source blobs, kept so the engine can reopen assets. */
  mediaFiles: ReadonlyMap<AssetId, File>;
  telemetry: EngineTelemetry | null;
  previews: PreviewStore | null;
  /** Bumped whenever a preview finishes, so the timeline re-renders. */
  previewVersion: number;
  exportProgress: ExportProgress | null;
  exportBusy: boolean;
  proxyProgress: ReadonlyMap<AssetId, number>;
  /**
   * Asset currently being dragged out of the media bin.
   *
   * `dataTransfer.getData` is blocked during dragover (only `drop` may read it), so
   * the ghost cannot learn the asset's duration from the event — it comes from here.
   */
  draggingAssetId: AssetId | null;
  status: string;
  error: string | null;
  showTelemetry: boolean;
  /**
   * What the autosaver is doing.
   *
   * There is no Save command — every edit is written to browser storage on a short
   * debounce — so this is the only thing that can tell anyone their work is being
   * kept. Silence was fine while nobody was looking for a Save button; it stops
   * being fine the moment the toolbar implies one should exist.
   */
  saveState: SaveState;

  project: () => Project;
  playhead: () => Time;
  duration: () => Time;

  run: (command: Command, label: string, coalesceKey?: string) => void;
  runMany: (commands: readonly Command[], label: string, coalesceKey?: string) => void;
  runTransient: (command: Command) => void;
  endGesture: () => void;
  undoEdit: () => void;
  redoEdit: () => void;
  canUndoEdit: () => boolean;
  canRedoEdit: () => boolean;

  /** Selects exactly these clips, without expanding to their units. */
  selectExact: (clipIds: readonly ClipId[]) => void;
  /** Selects these clips and everything linked or grouped with them. */
  select: (clipIds: readonly ClipId[]) => void;
  toggleSelect: (clipId: ClipId) => void;
  selectTrack: (trackId: TrackId | null) => void;
  selectTransition: (transitionId: TransitionId | null) => void;
  /**
   * Extend the selection from the last clip clicked to this one — Shift-click.
   *
   * The rectangle between the two anchors decides it, so dragging across tracks
   * picks up everything in between rather than only what shares a track.
   */
  selectRangeTo: (clipId: ClipId) => void;
  /** Clips touched by a marquee, added to the selection when `additive`. */
  selectWithin: (
    trackIds: readonly TrackId[],
    range: TimeRange,
    additive: boolean,
  ) => void;

  /**
   * Library selection. `ordered` is the list as the panel is currently showing it,
   * since a Shift-click means "everything between these two on screen" and the
   * store has no idea what the filters and the folder have left visible.
   */
  selectAssets: (assetIds: readonly AssetId[]) => void;
  toggleSelectAsset: (assetId: AssetId) => void;
  selectAssetRangeTo: (assetId: AssetId, ordered: readonly AssetId[]) => void;

  /**
   * Remove media from the project.
   *
   * `removeAsset` refuses an asset that still has clips, and one refusal discards
   * the whole batch — so the used ones are separated out here. With `withClips`
   * their clips go too; without it they are left alone and named in the result.
   */
  removeAssets: (
    assetIds: readonly AssetId[],
    options?: { readonly withClips?: boolean },
  ) => { readonly removed: number; readonly blocked: readonly string[] };
  /** Which of these assets are cut into the timeline, and how many clips each has. */
  assetUsage: (assetIds: readonly AssetId[]) => ReadonlyMap<AssetId, number>;
  moveAssetsToFolder: (assetIds: readonly AssetId[], folder: string) => void;
  renameAssetFolder: (from: string, to: string) => void;

  setPlayhead: (at: Time) => void;
  setZoom: (pixelsPerSecond: number) => void;

  /**
   * Move clips onto a track that does not exist yet — dropping into the gap above,
   * below or between the lanes.
   *
   * A move whose `toTrackId` is null lands on the new track. The whole thing is one
   * batch, so undo cannot leave a stray empty track behind after putting the clip
   * back where it came from.
   */
  moveClipsToNewTrack: (
    kind: TrackKind,
    index: number,
    moves: readonly {
      readonly clipId: ClipId;
      readonly toTrackId: TrackId | null;
      readonly toStart: Time;
    }[],
    coalesceKey?: string,
    /**
     * A second track made in the same batch for the linked half of an A/V pair,
     * so the picture and its sound land together instead of the sound being left
     * behind on whichever lane it happened to be on.
     */
    partner?: {
      readonly kind: TrackKind;
      readonly index: number;
      readonly clipIds: readonly ClipId[];
    },
  ) => void;
  /** Place an asset on a track created for it at `index` — the media-bin half of the same gesture. */
  dropAssetOnNewTrack: (assetId: AssetId, kind: TrackKind, index: number, start?: Time) => void;

  /** Capture the visible program/source frame into the media library. */
  captureFrame: () => Promise<void>;
  previewAsset: (assetId: AssetId) => void;
  showProgramPreview: () => void;
  setSourceTime: (at: Time) => void;
  setSourceMark: (edge: 'in' | 'out') => void;
  clearSourceMarks: () => void;
  editSourceToTimeline: (mode: 'insert' | 'overwrite') => void;
  downloadAsset: (assetId: AssetId) => Promise<void>;
  /** Replace missing bytes without changing the asset id used by timeline clips. */
  relinkAsset: (assetId: AssetId) => Promise<void>;
  generateProxy: (assetId: AssetId) => Promise<void>;
  removeProxy: (assetId: AssetId) => Promise<void>;
  setProxyMode: (mode: Project['settings']['proxyMode']) => void;

  attachEngine: (canvas: HTMLCanvasElement) => Promise<void>;
  /** `folder` files the imports straight into a media-bin folder as they land. */
  importFiles: (
    files: readonly File[],
    options?: { readonly folder?: string },
  ) => Promise<readonly AssetId[]>;
  importViaPicker: () => Promise<void>;
  addAssetToTimeline: (assetId: AssetId) => Promise<void>;
  addTitle: (text: string) => void;
  addSolid: (fill: string) => void;
  /**
   * Put a transition on the cut nearest the playhead.
   *
   * `trackId` limits it to one track; without it the search covers the selected
   * clips' tracks, or every track when nothing is selected. Returns false when
   * there was no bare cut to use.
   */
  /**
   * Cut at the playhead.
   *
   * With a selection only its tracks are cut — and since selecting one half of a
   * linked pair selects the whole unit, a clip and its own audio come apart
   * together. With nothing selected the cut runs across every track, which is
   * what you want when you are simply chopping the timeline.
   */
  splitAtPlayhead: () => void;
  /**
   * Clear out the tracks holding nothing, in one undo step.
   *
   * Deliberately a command rather than something that happens on its own when the
   * last clip leaves a track: an empty track is an ordinary working state — room
   * made ahead of an overlay, or a lane a clip has been dragged off mid-rearrange —
   * and a stack that reshuffles itself under the pointer takes its height, its
   * lock, its mute and its position with it. See `emptyTracksToRemove` for what it
   * will take.
   */
  removeEmptyTracks: () => void;
  addTransitionNearPlayhead: (transitionType?: string, trackId?: TrackId) => boolean;
  /** Whether a transition has a bare cut to land on, for anything offering the action. */
  canAddTransitionNearPlayhead: () => boolean;
  /**
   * Put a transition on these cuts, shortening the clips when they have no
   * handles to spare. Returns false when even that cannot make room.
   */
  addTransitionOnCuts: (
    cuts: readonly PlannedCut[],
    transitionType: string,
    duration: Time,
    label?: string,
  ) => boolean;
  /**
   * Place an asset on an existing track.
   *
   * `start` is where the drop pointed; without it the clip is appended after
   * whatever the track already holds, which is what the bin's own "add to
   * timeline" action wants and what a drag deliberately does not.
   */
  dropAssetOnTrack: (assetId: AssetId, trackId: TrackId, start?: Time) => void;
  setDraggingAsset: (assetId: AssetId | null) => void;
  newProject: () => void;
  togglePlay: () => Promise<void>;
  runExport: (settings: ExportSettings) => Promise<void>;
  cancelExport: () => void;
  setStatus: (status: string) => void;
  setError: (error: string | null) => void;
  toggleTelemetry: () => void;
  restoreLastProject: () => Promise<void>;
  buildPreviews: () => Promise<void>;

  // -- stored projects ------------------------------------------------------
  /** Every project in browser storage, newest first. */
  listStoredProjects: () => Promise<readonly ProjectSummary[]>;
  /** Close the current project and open this one. Returns false if it would not open. */
  openStoredProject: (id: ProjectId) => Promise<boolean>;
  /** Rename a project, open or not. */
  renameStoredProject: (id: ProjectId, name: string) => Promise<void>;
  /** Erase a project and its cached media. Moves on if it was the one open. */
  deleteStoredProject: (id: ProjectId) => Promise<void>;
  /** Download a project and its media as one file. */
  saveProjectToFile: (id: ProjectId) => Promise<void>;
  /** Read a project file, store it as a new project, and open it. */
  openProjectFile: (file: File) => Promise<boolean>;
  /** Ask for a project file and open it. Returns false if nothing was picked. */
  openProjectFileViaPicker: () => Promise<boolean>;
}

/**
 * Autosave. Lives outside the store because it is a side-effect owner, not state:
 * every recorded edit schedules a debounced write of the current document.
 */
const autosaver = new Autosaver(
  800,
  (error) => {
    useStudio.setState({ error: `Autosave failed: ${error.message}` });
  },
  (saveState) => {
    useStudio.setState({ saveState });
  },
);

/**
 * Write any pending edit immediately.
 *
 * Without this, anything done inside the debounce window is lost when the tab
 * closes. `pagehide` is the reliable signal — `beforeunload` is skipped when a tab
 * is discarded or the page is restored from the back/forward cache.
 */
export function flushAutosave(): Promise<void> {
  const state = useStudio.getState();
  autosaver.schedule(state.project());
  // Awaitable so a caller that is about to replace the document can let the old one
  // finish writing first. `pagehide` cannot wait for it and does not need to: the
  // write is already in flight by the time it returns.
  return autosaver.flush();
}

const initial = starterProject();

/**
 * Copy the live position back into the document, eventually.
 *
 * The document keeps a play head only so that reopening a project starts where it
 * was left — nothing reads it during an edit. Writing it on every tick is what used
 * to re-render the whole application forty times a second, so it is written on a
 * delay instead, and never while playing: pausing does it once, at the end.
 */
let playheadCommitTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Write a known position into the document now, cancelling anything pending.
 *
 * Takes the time rather than reading it, because the callers that need it now are
 * the ones about to change it — handing the monitor to a source, or stopping. A
 * deferred read would fetch whatever replaced it.
 */
function commitPlayhead(get: () => StudioState, at: Time): void {
  if (playheadCommitTimer !== null) {
    clearTimeout(playheadCommitTimer);
    playheadCommitTimer = null;
  }
  const state = get();
  const sequence = state.project().sequences[state.sequenceId];
  if (!sequence || T.cmp(sequence.view.playhead, at) === 0) return;
  state.runTransient({ type: 'setView', sequenceId: state.sequenceId, view: { playhead: at } });
}

/** Write wherever the head ends up, once it stops moving. */
function commitPlayheadSoon(get: () => StudioState): void {
  if (playheadCommitTimer !== null) clearTimeout(playheadCommitTimer);
  playheadCommitTimer = setTimeout(() => {
    playheadCommitTimer = null;
    // Never while a source is in the monitor: the channel is carrying that clip's
    // own time, which has nothing to do with where the edit is.
    if (playback.get().mode !== 'program') return;
    commitPlayhead(get, playback.get().position);
  }, PLAYHEAD_COMMIT_MS);
}

/** Long enough that a scrub is one write rather than a hundred. */
const PLAYHEAD_COMMIT_MS = 400;

/** Point the transport at a document's saved position, without writing back. */
function adoptPlayheadFrom(project: Project, sequenceId: SequenceId): void {
  const sequence = project.sequences[sequenceId];
  if (sequence) playback.set({ position: sequence.view.playhead });
}

let exportController: AbortController | null = null;
const proxyControllers = new Map<AssetId, AbortController>();
let automaticProxyQueue = Promise.resolve();

function wantsAutomaticProxy(project: Project, asset: Asset): boolean {
  if (asset.kind !== 'video' || !asset.video || asset.derived.proxyPath) return false;
  if (project.settings.proxyMode === 'never') return false;
  if (project.settings.proxyMode === 'always') return true;
  return asset.video.size.width > 1280 || asset.video.size.height > 720;
}

/** Serialize background encodes so a multi-file import cannot exhaust VideoEncoder resources. */
function queueAutomaticProxies(get: () => StudioState, assetIds: readonly AssetId[]): void {
  automaticProxyQueue = automaticProxyQueue.then(async () => {
    for (const assetId of assetIds) {
      const asset = get().project().assets[assetId];
      if (asset && wantsAutomaticProxy(get().project(), asset)) await get().generateProxy(assetId);
    }
  });
}

/** Ask the browser not to evict project media under storage pressure. */
async function requestDurableStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export const useStudio = create<StudioState>((set, get) => ({
  history: initHistory(initial.project),
  sequenceId: initial.sequenceId,
  selection: [],
  selectedTrackId: null,
  selectedTransitionId: null,
  selectionAnchor: null,
  selectedAssetIds: [],
  assetSelectionAnchor: null,
  previewAssetId: null,
  sourceMarks: new Map(),
  engine: null,
  mediaFiles: new Map(),
  telemetry: null,
  previews: null,
  previewVersion: 0,
  exportProgress: null,
  exportBusy: false,
  proxyProgress: new Map(),
  draggingAssetId: null,
  status: 'Import media to begin.',
  error: null,
  saveState: 'idle',
  // Off to begin with. The panel is worth having — it is the only window onto
  // where a frame's time actually goes — but it sits over the picture, and the
  // picture is what you open the app to look at.
  showTelemetry: false,

  project: () => current(get().history),
  // The live position, not the document's copy of it. Every command that acts "at
  // the play head" — split, add title, add transition — has to see where the head
  // actually is, which during playback the document deliberately does not know.
  playhead: () => playback.get().position,
  duration: () => sequenceDuration(get().project(), get().sequenceId),

  run: (command, label, coalesceKey) => {
    try {
      const history = commit(
        get().history,
        command,
        { label, ...(coalesceKey !== undefined ? { coalesceKey } : {}) },
        ids,
      );
      set({ history, error: null });
      autosaver.schedule(current(history));
      get().engine?.refresh();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  runMany: (commands, label, coalesceKey) => {
    try {
      let project = get().project();
      for (const command of commands) project = apply(project, command, ids);
      const history = push(get().history, project, {
        label,
        ...(coalesceKey !== undefined ? { coalesceKey } : {}),
      });
      set({ history, error: null });
      autosaver.schedule(project);
      get().engine?.refresh();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  /** Apply without touching the undo stack — used for the playhead and viewport. */
  runTransient: (command) => {
    const history = get().history;
    try {
      const project = apply(current(history), command, ids);
      set({
        history: { ...history, present: { ...history.present, project } },
      });
    } catch {
      // View changes are never worth surfacing an error for.
    }
  },

  endGesture: () => set({ history: breakCoalescing(get().history) }),
  undoEdit: () => {
    const history = undo(get().history);
    set({ history, selection: [] });
    // The head stays where it is. Undo takes back an edit, not where you were
    // standing when you made it — and now that the position is not part of the
    // document, a restored snapshot carries a stale copy that would teleport it.
    // Writing the live position over that copy is what keeps the two agreeing.
    commitPlayhead(get, playback.get().position);
    autosaver.schedule(current(history));
    get().engine?.refresh();
  },
  redoEdit: () => {
    const history = redo(get().history);
    set({ history, selection: [] });
    commitPlayhead(get, playback.get().position);
    autosaver.schedule(current(history));
    get().engine?.refresh();
  },
  canUndoEdit: () => canUndo(get().history),
  canRedoEdit: () => canRedo(get().history),

  selectExact: (clipIds) =>
    set({ selection: clipIds, selectedTrackId: null, selectedTransitionId: null, ...NO_ASSETS }),

  /**
   * Clip, track and transition selection are mutually exclusive: the inspector
   * shows one subject, and two at once would leave it ambiguous.
   */
  selectTrack: (trackId) =>
    set({ selectedTrackId: trackId, selection: [], selectedTransitionId: null }),

  selectTransition: (transitionId) =>
    set({ selectedTransitionId: transitionId, selection: [], selectedTrackId: null }),

  /**
   * Selecting one member of a link or group selects the whole unit.
   *
   * Delete, ripple delete and the inspector all read `selection`, so without this
   * they disagree with dragging — which already moves a unit together. That gap is
   * what let deleting a video clip leave its audio orphaned on the track.
   */
  select: (clipIds) =>
    set({
      selection: expandSelection(get().project(), clipIds),
      selectedTrackId: null,
      selectedTransitionId: null,
      selectionAnchor: clipIds[0] ?? null,
      ...NO_ASSETS,
    }),

  selectRangeTo: (clipId) => {
    const state = get();
    const project = state.project();
    const target = project.clips[clipId];
    const anchorId = state.selectionAnchor ?? state.selection[0];
    const anchor = anchorId === undefined ? undefined : project.clips[anchorId];

    // Nothing to reach from, so this is just an ordinary click.
    if (!target || !anchor) {
      state.select([clipId]);
      return;
    }

    const order = orderedTrackIds(project, state.sequenceId);
    const first = order.indexOf(anchor.trackId);
    const last = order.indexOf(target.trackId);
    const tracks = order.slice(Math.min(first, last), Math.max(first, last) + 1);

    const range = T.rangeFromBounds(
      T.min(anchor.start, target.start),
      T.max(clipEnd(anchor), clipEnd(target)),
    );
    set({
      selection: expandSelection(project, clipsWithin(project, tracks, range).map((c) => c.id)),
      selectedTrackId: null,
      selectedTransitionId: null,
      // The anchor stays put, so shift-clicking again re-measures from it.
      selectionAnchor: anchorId ?? null,
      ...NO_ASSETS,
    });
  },

  selectWithin: (trackIds, range, additive) => {
    const project = get().project();
    const found = expandSelection(project, clipsWithin(project, trackIds, range).map((c) => c.id));
    const existing = additive ? get().selection : [];
    set({
      selection: [...existing, ...found.filter((id) => !existing.includes(id))],
      selectedTrackId: null,
      selectedTransitionId: null,
      ...NO_ASSETS,
    });
  },

  toggleSelect: (clipId) => {
    const project = get().project();
    const unit = expandSelection(project, [clipId]);
    const selection = get().selection;
    const alreadyIn = unit.every((id) => selection.includes(id));
    set({
      selection: alreadyIn
        ? selection.filter((id) => !unit.includes(id))
        : [...selection, ...unit.filter((id) => !selection.includes(id))],
      ...NO_ASSETS,
    });
  },

  // ------------------------------------------------------------------ library

  selectAssets: (assetIds) =>
    set({ selectedAssetIds: assetIds, assetSelectionAnchor: assetIds[0] ?? null, ...NO_CLIPS }),

  toggleSelectAsset: (assetId) => {
    const current = get().selectedAssetIds;
    set({
      selectedAssetIds: current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId],
      assetSelectionAnchor: assetId,
      ...NO_CLIPS,
    });
  },

  selectAssetRangeTo: (assetId, ordered) => {
    const anchor = get().assetSelectionAnchor ?? get().selectedAssetIds[0];
    const from = anchor === undefined ? -1 : ordered.indexOf(anchor);
    const to = ordered.indexOf(assetId);

    // Nothing to measure from, or the anchor has been filtered out of view.
    if (from < 0 || to < 0) {
      set({ selectedAssetIds: [assetId], assetSelectionAnchor: assetId, ...NO_CLIPS });
      return;
    }
    set({
      selectedAssetIds: ordered.slice(Math.min(from, to), Math.max(from, to) + 1),
      // The anchor stays put, so shift-clicking again re-measures from it.
      assetSelectionAnchor: anchor ?? null,
      ...NO_CLIPS,
    });
  },

  previewAsset: (assetId) => {
    const asset = get().project().assets[assetId];
    if (!asset || asset.status.state === 'missing') return;
    void get().engine?.pause();
    // The program position is written back before the monitor changes hands — with
    // the value read now, not later, since the next line replaces it.
    commitPlayhead(get, playback.get().position);
    playback.set({
      mode: 'source',
      position: T.TIME_ZERO,
      playing: false,
      duration: asset.video?.duration ?? asset.audio?.duration ?? T.TIME_ZERO,
    });
    set({
      previewAssetId: assetId,
      selectedAssetIds: [assetId],
      assetSelectionAnchor: assetId,
      status: `Previewing source "${asset.name}".`,
      error: null,
      ...NO_CLIPS,
    });
  },

  showProgramPreview: () => {
    if (get().previewAssetId === null) return;
    // Back to the program, at the position the document kept for exactly this.
    const sequence = get().project().sequences[get().sequenceId];
    playback.set({
      mode: 'program',
      playing: false,
      position: sequence?.view.playhead ?? T.TIME_ZERO,
      duration: get().duration(),
    });
    set({ previewAssetId: null });
    get().engine?.requestRender(get().playhead());
  },

  setSourceTime: (at) => {
    const state = get();
    const asset = state.previewAssetId ? state.project().assets[state.previewAssetId] : null;
    const duration = asset?.video?.duration ?? asset?.audio?.duration ?? T.TIME_ZERO;
    playback.set({ position: T.clamp(at, T.TIME_ZERO, duration) });
  },

  setSourceMark: (edge) => {
    const state = get();
    const assetId = state.previewAssetId;
    if (!assetId) return;
    const duration = state.project().assets[assetId]?.video?.duration
      ?? state.project().assets[assetId]?.audio?.duration
      ?? T.TIME_ZERO;
    const at = T.clamp(playback.get().position, T.TIME_ZERO, duration);
    const current = state.sourceMarks.get(assetId) ?? { inPoint: null, outPoint: null };
    let next = edge === 'in' ? { ...current, inPoint: at } : { ...current, outPoint: at };
    // Keep the range meaningful: moving one edge through the other clears the
    // stale opposite edge instead of silently creating a negative selection.
    if (next.inPoint && next.outPoint && !T.lt(next.inPoint, next.outPoint)) {
      next = edge === 'in'
        ? { inPoint: at, outPoint: null }
        : { inPoint: null, outPoint: at };
    }
    const marks = new Map(state.sourceMarks);
    marks.set(assetId, next);
    set({ sourceMarks: marks, status: `Marked source ${edge === 'in' ? 'In' : 'Out'} at ${T.formatDuration(at, { decimals: 2 })}.` });
  },

  clearSourceMarks: () => {
    const assetId = get().previewAssetId;
    if (!assetId) return;
    const marks = new Map(get().sourceMarks);
    marks.delete(assetId);
    set({ sourceMarks: marks, status: 'Cleared source In/Out marks.' });
  },

  editSourceToTimeline: (mode) => {
    const state = get();
    const assetId = state.previewAssetId;
    if (!assetId) return;
    const project = state.project();
    const asset = project.assets[assetId];
    if (!asset || asset.status.state === 'missing') return;
    const sequence = getSequence(project, state.sequenceId);
    const marks = state.sourceMarks.get(assetId);
    const total = asset.video?.duration ?? asset.audio?.duration ?? T.TIME_ZERO;
    const sourceIn = marks?.inPoint ?? T.TIME_ZERO;
    const sourceOut = marks?.outPoint ?? total;
    const duration = asset.kind === 'image' ? total : T.sub(sourceOut, sourceIn);
    if (!T.isPositive(duration)) {
      set({ error: 'Source In must be before Source Out.' });
      return;
    }

    const selected = state.selectedTrackId ? project.tracks[state.selectedTrackId] : null;
    const selectedCompatible = selected && (
      (selected.kind === 'video' && Boolean(asset.video)) ||
      (selected.kind === 'audio' && Boolean(asset.audio))
    );
    const trackId = selectedCompatible
      ? selected.id
      : asset.video
        ? sequence.videoTrackIds[0]
        : sequence.audioTrackIds[0];
    if (!trackId) {
      set({ error: 'No compatible target track is available.' });
      return;
    }

    try {
      const placement = planPlacement(project, state.sequenceId, asset, trackId, {
        start: state.playhead(),
        sourceIn,
        duration,
        mode,
      });
      state.runMany(placement.commands, `${mode === 'insert' ? 'Insert' : 'Overwrite'} source`);
      set({
        status: `${mode === 'insert' ? 'Inserted' : 'Overwrote with'} ${T.formatDuration(duration, { decimals: 2 })} from "${asset.name}".`,
      });
      state.engine?.requestRender(placement.start);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  downloadAsset: async (assetId) => {
    const state = get();
    const asset = state.project().assets[assetId];
    if (!asset) return;

    try {
      const file = state.mediaFiles.get(assetId) ?? (await loadMedia(state.project().id, assetId));
      if (!file) throw new Error('The original media is not available');
      downloadBlob(file, safeFileName(asset.source?.fileName ?? asset.name));
      set({ status: `Downloaded "${asset.name}".`, error: null });
    } catch (err) {
      set({ error: `Could not download "${asset.name}": ${err instanceof Error ? err.message : String(err)}` });
    }
  },

  relinkAsset: async (assetId) => {
    const original = get().project().assets[assetId];
    if (!original) return;
    const previousFile = get().mediaFiles.get(assetId) ?? null;
    let decoderWasClosed = false;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = original.kind === 'image' ? 'image/*' : original.kind === 'audio' ? 'audio/*' : 'video/*,audio/*';
    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });
    if (!file) return;

    set({ status: `Checking replacement for "${original.name}"…`, error: null });
    try {
      const candidate = isImageFile(file)
        ? await MediaLibrary.importImage(assetId, file, file.name)
        : await MediaLibrary.importFile(assetId, file, file.name);

      const sameStreams =
        Boolean(candidate.video) === Boolean(original.video) &&
        Boolean(candidate.audio) === Boolean(original.audio) &&
        Boolean(candidate.image) === Boolean(original.image);
      if (!sameStreams) {
        throw new Error('Replacement must contain the same video, audio, and still-image streams.');
      }

      let requiredSeconds = 0;
      for (const clip of Object.values(get().project().clips)) {
        if (!('assetId' in clip) || clip.assetId !== assetId) continue;
        const sourceIn = T.toSeconds(clip.sourceIn);
        const sourceOut = sourceIn + T.toSeconds(clip.duration) * clip.speed;
        requiredSeconds = Math.max(requiredSeconds, sourceIn, sourceOut);
      }
      const candidateDuration = T.toSeconds(candidate.video?.duration ?? candidate.audio?.duration ?? T.TIME_ZERO);
      if (!candidate.image && candidateDuration + 1e-3 < requiredSeconds) {
        throw new Error(
          `Replacement is too short (${candidateDuration.toFixed(2)} s); this edit uses media through ${requiredSeconds.toFixed(2)} s.`,
        );
      }

      const replacement: Asset = {
        ...candidate,
        id: original.id,
        name: original.name,
        createdAt: original.createdAt,
        folder: original.folder,
        status: { state: 'ready' },
      };

      get().engine?.media.close(assetId);
      decoderWasClosed = true;
      await get().engine?.openAsset(assetId, file, replacement.kind);
      const nextFiles = new Map(get().mediaFiles);
      nextFiles.set(assetId, file);
      set({ mediaFiles: nextFiles });
      get().previews?.dispose();
      set({ previews: null, previewVersion: get().previewVersion + 1 });
      get().run({ type: 'replaceAsset', assetId, asset: replacement }, `Relink "${original.name}"`);
      await deleteProxy(get().project().id, assetId);

      const copied = await saveMedia(
        get().project().id,
        assetId,
        file,
        get().project().settings.copyMediaToOpfsUpToBytes,
      ).catch(() => false);
      const durable = copied ? await requestDurableStorage() : null;
      set({
        status: copied
          ? `Relinked "${original.name}".${durable === false ? ' Browser storage is not guaranteed against eviction.' : ''}`
          : `Relinked "${original.name}", but the source is session-only; choose it again after reopening.`,
      });
      void get().buildPreviews();
      queueAutomaticProxies(get, [assetId]);
    } catch (err) {
      if (decoderWasClosed && previousFile) {
        get().engine?.media.close(assetId);
        await get().engine?.openAsset(assetId, previousFile, original.kind).catch(() => undefined);
      }
      set({
        error: `Could not relink "${original.name}": ${err instanceof Error ? err.message : String(err)}`,
        status: 'Relink failed.',
      });
    }
  },

  generateProxy: async (assetId) => {
    if (proxyControllers.has(assetId)) return;
    const state = get();
    const asset = state.project().assets[assetId];
    if (!asset?.video || asset.kind !== 'video') return;
    const file = state.mediaFiles.get(assetId) ?? await loadMedia(state.project().id, assetId);
    if (!file) {
      set({ error: `Relink "${asset.name}" before generating a proxy.` });
      return;
    }

    const controller = new AbortController();
    proxyControllers.set(assetId, controller);
    const progress = new Map(get().proxyProgress);
    progress.set(assetId, 0);
    set({ proxyProgress: progress, status: `Generating proxy for "${asset.name}"…`, error: null });
    try {
      const result = await encodeProxy(file, asset.video.size, {
        signal: controller.signal,
        onProgress: (fraction) => {
          const next = new Map(get().proxyProgress);
          next.set(assetId, fraction);
          set({ proxyProgress: next });
        },
      });
      await saveProxy(get().project().id, assetId, result.blob);
      await get().engine?.openProxy(assetId, result.blob);
      const current = get().project().assets[assetId];
      if (current) {
        get().run(
          {
            type: 'replaceAsset',
            assetId,
            asset: {
              ...current,
              derived: {
                ...current.derived,
                proxyPath: `proxies/${assetId}`,
                proxySize: result.size,
              },
            },
          },
          `Generate proxy for "${asset.name}"`,
        );
      }
      set({
        status: `Proxy ready for "${asset.name}" — ${result.size.width}×${result.size.height}, ${(result.blob.size / 1e6).toFixed(1)} MB.`,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        set({ error: `Could not generate proxy for "${asset.name}": ${error instanceof Error ? error.message : String(error)}` });
      }
    } finally {
      proxyControllers.delete(assetId);
      const next = new Map(get().proxyProgress);
      next.delete(assetId);
      set({ proxyProgress: next });
    }
  },

  removeProxy: async (assetId) => {
    proxyControllers.get(assetId)?.abort();
    proxyControllers.delete(assetId);
    get().engine?.media.closeProxy(assetId);
    await deleteProxy(get().project().id, assetId);
    const asset = get().project().assets[assetId];
    if (asset?.derived.proxyPath) {
      get().run(
        {
          type: 'replaceAsset',
          assetId,
          asset: {
            ...asset,
            derived: { ...asset.derived, proxyPath: null, proxySize: null },
          },
        },
        `Remove proxy for "${asset.name}"`,
      );
      set({ status: `Removed proxy for "${asset.name}"; preview uses the original.` });
    }
  },

  setProxyMode: (mode) => {
    get().run({ type: 'setProjectProxyMode', mode }, 'Set proxy policy');
    set({
      status: mode === 'never'
        ? 'Automatic proxy generation is off. Existing proxies remain available.'
        : mode === 'always'
          ? 'All imported videos will receive editing proxies.'
          : 'Large videos will receive editing proxies automatically.',
    });
    queueAutomaticProxies(get, Object.keys(get().project().assets) as AssetId[]);
  },

  assetUsage: (assetIds) => {
    const usage = clipsUsingAssets(get().project(), assetIds);
    return new Map([...usage].map(([id, clips]) => [id, clips.length]));
  },

  removeAssets: (assetIds, options) => {
    const project = get().project();
    const usage = clipsUsingAssets(project, assetIds);

    const commands: Command[] = [];
    const removed: AssetId[] = [];
    const blocked: string[] = [];

    for (const assetId of assetIds) {
      const clips = usage.get(assetId) ?? [];
      if (clips.length > 0 && !options?.withClips) {
        blocked.push(project.assets[assetId]?.name ?? assetId);
        continue;
      }
      // Lift rather than ripple: pulling the timeline together is a separate
      // decision from throwing away the source, and never the one being asked for.
      if (clips.length > 0) commands.push({ type: 'removeClips', clipIds: clips, mode: 'lift' });
      commands.push({ type: 'removeAsset', assetId });
      removed.push(assetId);
    }

    if (commands.length > 0) {
      get().runMany(commands, removed.length > 1 ? `Remove ${removed.length} assets` : 'Remove asset');

      // Let go of the bytes as well as the record: the in-memory File and the copy
      // beside the project, which runs to gigabytes and nothing can reach any more.
      const files = new Map(get().mediaFiles);
      for (const assetId of removed) files.delete(assetId);
      set({
        mediaFiles: files,
        selectedAssetIds: get().selectedAssetIds.filter((id) => !removed.includes(id)),
        ...(get().previewAssetId && removed.includes(get().previewAssetId!)
          ? { previewAssetId: null, sourcePreviewTime: T.TIME_ZERO }
          : {}),
      });
      for (const assetId of removed) void deleteMedia(project.id, assetId);
      for (const assetId of removed) void deleteProxy(project.id, assetId);
    }

    if (blocked.length > 0) {
      set({
        error:
          `${blocked.length === 1 ? 'This is' : 'These are'} still used in the timeline: ` +
          `${blocked.join(', ')}. Remove the clips first, or delete the clips too.`,
      });
    }
    return { removed: removed.length, blocked };
  },

  moveAssetsToFolder: (assetIds, folder) => {
    if (assetIds.length === 0) return;
    get().runMany(
      assetIds.map((assetId) => ({ type: 'setAssetFolder' as const, assetId, folder })),
      assetIds.length > 1 ? `Move ${assetIds.length} assets` : 'Move asset',
    );
  },

  /**
   * Rename a folder by rewriting every path that sits at or below it.
   *
   * Folders are paths on the assets rather than entities, so this is the rename:
   * `B-roll` → `Cutaways` also has to carry `B-roll/Day 1` along with it.
   */
  renameAssetFolder: (from, to) => {
    const project = get().project();
    const prefix = `${from}/`;
    const commands: Command[] = [];

    for (const asset of Object.values(project.assets)) {
      if (asset.folder !== from && !asset.folder.startsWith(prefix)) continue;
      commands.push({
        type: 'setAssetFolder',
        assetId: asset.id,
        folder: to ? `${to}${asset.folder.slice(from.length)}` : asset.folder.slice(prefix.length),
      });
    }
    if (commands.length > 0) get().runMany(commands, 'Rename folder');
  },

  setPlayhead: (at) => {
    const clamped = T.max(T.TIME_ZERO, at);
    // Published first and synchronously: the play head and the timecode are drawn
    // straight from this, so a drag follows the pointer without waiting for a render.
    playback.set({ position: clamped });
    commitPlayheadSoon(get);
    // Goes through the engine rather than requestRender so that seeking while
    // playing re-bases the transport instead of being dragged straight back.
    void get().engine?.seek(clamped);
  },

  setZoom: (pixelsPerSecond) => {
    get().runTransient({
      type: 'setView',
      sequenceId: get().sequenceId,
      view: { zoom: Math.max(4, Math.min(2000, pixelsPerSecond)) },
    });
  },

  attachEngine: async (canvas) => {
    let engine = get().engine;
    if (!engine) {
      engine = Engine.create(() => get().project(), get().sequenceId);
      engine.onTelemetry((telemetry) => set({ telemetry: { ...telemetry } }));
      set({ engine });
    }
    const sequence = getSequence(get().project(), get().sequenceId);
    try {
      await engine.attachCanvas(canvas, sequence.size);
      // Re-open any media imported before the canvas existed.
      const assets = get().project().assets;
      for (const [assetId, file] of get().mediaFiles) {
        const kind = assets[assetId]?.kind;
        if (kind) await engine.openAsset(assetId, file, kind);
      }
      queueAutomaticProxies(get, Object.keys(assets) as AssetId[]);
      engine.requestRender(get().playhead());
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  importFiles: async (files, options) => {
    if (files.length === 0) return [];
    set({ status: `Importing ${files.length} file(s)…`, error: null });

    const nextFiles = new Map(get().mediaFiles);
    const commands: Command[] = [];
    const importedIds: AssetId[] = [];
    const failures: string[] = [];
    const sessionOnly: string[] = [];
    const folder = options?.folder ? normaliseFolder(options.folder) : '';

    for (const file of files) {
      const assetId = ids.asset();
      try {
        const probed = isImageFile(file)
          ? await MediaLibrary.importImage(assetId, file, file.name)
          : await MediaLibrary.importFile(assetId, file, file.name);
        // Filed on the way in rather than moved afterwards, so the asset never
        // appears at the root for a frame and the whole import is one undo step.
        const asset = folder ? { ...probed, folder } : probed;
        commands.push({ type: 'addAsset', asset });
        importedIds.push(assetId);
        nextFiles.set(assetId, file);
        await get().engine?.openAsset(assetId, file, asset.kind);
        // Copy beside the project so it reopens after a reload.
        const copied = await saveMedia(
          get().project().id,
          assetId,
          file,
          get().project().settings.copyMediaToOpfsUpToBytes,
        ).catch(() => false);
        if (!copied) sessionOnly.push(file.name);
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (commands.length > 0) {
      set({ mediaFiles: nextFiles });
      get().runMany(commands, `Import ${commands.length} file(s)`);
      queueAutomaticProxies(get, importedIds);
    }
    const durable = commands.length > sessionOnly.length ? await requestDurableStorage() : null;
    const durabilityNote = sessionOnly.length
      ? ` ${sessionOnly.length} source(s) are session-only and must be relinked after reopening.`
      : durable === false
        ? ' Browser storage is not guaranteed against eviction; keep a project-file backup.'
        : '';
    set({
      status: `${commands.length} imported${failures.length ? `, ${failures.length} failed` : ''}.${durabilityNote}`,
      error: failures.length > 0 ? failures.join('\n') : null,
    });
    // Filmstrips and waveforms are built in the background; the timeline picks them
    // up when they land rather than blocking the import on them.
    void get().buildPreviews();
    return importedIds;
  },

  /**
   * Open the system file dialog and import whatever is chosen.
   *
   * Built from a detached <input type=file> rather than `showOpenFilePicker`, which
   * is not available in every context the app runs in (embedded frames especially)
   * and would need a separate fallback anyway.
   */
  importViaPicker: async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,audio/*,image/*';
    input.multiple = true;

    const files = await new Promise<readonly File[]>((resolve) => {
      input.addEventListener('change', () => resolve(input.files ? [...input.files] : []), { once: true });
      // A cancelled dialog fires no 'change' event; 'cancel' covers that.
      input.addEventListener('cancel', () => resolve([]), { once: true });
      input.click();
    });

    if (files.length > 0) await get().importFiles(files);
  },

  /**
   * Append an asset to the first compatible track. Goes through the same planner as
   * dropping, so both routes place clips identically and both create a counterpart
   * track when the asset needs one.
   */
  addAssetToTimeline: async (assetId) => {
    const state = get();
    const project = state.project();
    const asset = project.assets[assetId];
    if (!asset) return;

    const sequence = getSequence(project, state.sequenceId);
    const anchorTrackId = asset.video ? sequence.videoTrackIds[0] : sequence.audioTrackIds[0];
    if (!anchorTrackId) {
      set({ error: 'No compatible track for this asset' });
      return;
    }

    const duration = asset.video?.duration ?? asset.audio?.duration;
    if (!duration || !T.isPositive(duration)) {
      set({ error: `"${asset.name}" has no usable duration` });
      return;
    }

    const placement = planPlacement(project, state.sequenceId, asset, anchorTrackId);
    get().runMany(placement.commands, `Add "${asset.name}"`);
    get().select(placement.clipIds);
    set({ status: `Added "${asset.name}"${placementNotes(placement)}` });
    get().engine?.requestRender(placement.start);
  },

  addTitle: (text) => {
    const state = get();
    const plan = planGenerated(state.project(), state.sequenceId, {
      kind: 'title',
      start: state.playhead(),
      duration: T.time(3),
      text,
      name: text.slice(0, 24) || 'Title',
    });
    state.runMany(plan.commands, 'Add title');
    get().select([plan.clipId]);
    set({
      status: plan.createdTrack
        ? 'Added a title on a new track above — the one below was busy at the playhead.'
        : 'Added a title.',
    });
  },

  splitAtPlayhead: () => {
    const state = get();
    const project = state.project();

    const selected = [
      ...new Set(state.selection.map((id) => project.clips[id]?.trackId)),
    ].filter((id): id is TrackId => id !== undefined);
    const trackIds = selected.length > 0 ? selected : orderedTrackIds(project, state.sequenceId);
    if (trackIds.length === 0) return;

    state.run({ type: 'splitClips', trackIds, at: state.playhead() }, 'Split');
  },

  removeEmptyTracks: () => {
    const state = get();
    const project = state.project();
    const removing = emptyTracksToRemove(project, state.sequenceId);

    if (removing.length === 0) {
      set({ status: 'No empty tracks to remove.' });
      return;
    }

    // The selection is by clip, so an empty track cannot hold one — but the track
    // the Inspector is pointed at can be one of these, and it is about to go.
    if (state.selectedTrackId && removing.includes(state.selectedTrackId)) {
      set({ selectedTrackId: null });
    }

    state.runMany(
      removing.map((trackId) => ({ type: 'removeTrack' as const, trackId })),
      removing.length === 1 ? 'Remove empty track' : 'Remove empty tracks',
    );
    set({
      status:
        removing.length === 1
          ? 'Removed 1 empty track.'
          : `Removed ${removing.length} empty tracks.`,
    });
  },

  addTransitionOnCuts: (cuts, transitionType, duration, label = 'Add transition') => {
    const state = get();
    const project = state.project();
    const sequence = getSequence(project, state.sequenceId);

    const plan = planTransition(project, cuts, {
      duration,
      transitionType,
      minimumClip: T.frameDuration(sequence.frameRate),
    });
    if (plan.commands.length === 0) {
      set({ error: 'Those clips are too short for a transition' });
      return false;
    }

    // Sound has no edge to wipe, so a wipe on the picture still crossfades below.
    const isOnAudio = (command: Command): boolean => {
      if (command.type !== 'addTransition') return false;
      const anchor = command.fromClipId ?? command.toClipId;
      const clip = anchor === null ? undefined : project.clips[anchor];
      return clip !== undefined && project.tracks[clip.trackId]?.kind === 'audio';
    };
    const commands = plan.commands.map((command) =>
      isOnAudio(command) ? { ...command, transitionType: 'dissolve' } : command,
    );

    state.runMany(commands, label);

    // Say so rather than silently eating frames: this shortens the edit.
    if (T.isPositive(plan.shortenedBy)) {
      set({
        error:
          `No spare frames at that cut, so the clips were shortened by ` +
          `${T.formatDuration(plan.shortenedBy, { decimals: 2 })} to make room. Undo to put them back.`,
      });
    }
    return true;
  },

  canAddTransitionNearPlayhead: () => bareCutNearPlayhead(get()) !== null,

  addTransitionNearPlayhead: (transitionType, trackId) => {
    const state = get();
    const project = state.project();

    const best = bareCutNearPlayhead(state, trackId);
    if (!best) {
      set({ error: 'No bare cut near the playhead to put a transition on' });
      return false;
    }

    // Both halves of a linked pair, so the sound crossfades with the picture.
    return state.addTransitionOnCuts(
      pairedCuts(project, best.from, best.to),
      transitionType ?? 'dissolve',
      T.fromSeconds(DEFAULT_TRANSITION_SECONDS, 1000),
    );
  },

  addSolid: (fill) => {
    const state = get();
    const plan = planGenerated(state.project(), state.sequenceId, {
      kind: 'solid',
      start: state.playhead(),
      duration: T.time(3),
      fill,
    });
    state.runMany(plan.commands, 'Add colour');
    get().select([plan.clipId]);
    set({
      status: plan.createdTrack
        ? 'Added a colour on a new track above — the one below was busy at the playhead.'
        : 'Added a colour.',
    });
  },

  /**
   * Place an asset on a track — the drop half of dragging from the media bin.
   *
   * The clip lands after whatever is already on that track rather than under the
   * pointer, so dropping never lands mid-clip or leaves an accidental gap. The
   * pointer chooses the track; the track chooses the time.
   */
  dropAssetOnTrack: (assetId, trackId, start) => {
    const state = get();
    const project = state.project();
    const asset = project.assets[assetId];
    const track = project.tracks[trackId];
    if (!asset || !track) return;

    const duration = asset.video?.duration ?? asset.audio?.duration;
    if (!duration || !T.isPositive(duration)) {
      set({ error: `"${asset.name}" has no usable duration` });
      return;
    }

    if (track.kind === 'video' && !asset.video) {
      set({ error: `"${asset.name}" has no video to place on ${track.name}` });
      return;
    }
    if (track.kind === 'audio' && !asset.audio) {
      set({ error: `"${asset.name}" has no audio to place on ${track.name}` });
      return;
    }

    const placement = planPlacement(project, state.sequenceId, asset, trackId, start ? { start } : {});
    get().runMany(placement.commands, `Add "${asset.name}"`);
    // The clip is the subject now, not the library item it came from. Leaving the
    // media lit meant the thing you had just placed was not the thing selected, and
    // since selection is exclusive this hands the highlight over in one move.
    get().select(placement.clipIds);
    set({ status: `Added "${asset.name}"${placementNotes(placement)}` });
  },

  moveClipsToNewTrack: (kind, index, moves, coalesceKey, partner) => {
    const sequenceId = get().sequenceId;
    const trackId = ids.track();
    const partnerTrackId = partner ? ids.track() : null;
    const partnerClips = new Set(partner?.clipIds ?? []);

    // One batch: addTrack then the move. Two batches would let undo put the clip
    // back while leaving the track it was dropped into sitting there empty.
    //
    // Passing the drag's own coalesce key folds this into the same undo step as the
    // pointer moves that led here, so the whole gesture comes apart in one go.
    //
    // The two indices do not disturb each other: a sequence keeps its video and
    // audio track lists separately, so neither insert shifts the other's position.
    get().runMany(
      [
        { type: 'addTrack', sequenceId, kind, index, trackId },
        ...(partner && partnerTrackId
          ? [
              {
                type: 'addTrack' as const,
                sequenceId,
                kind: partner.kind,
                index: partner.index,
                trackId: partnerTrackId,
              },
            ]
          : []),
        {
          type: 'moveClips',
          moves: moves.map((move) => ({
            clipId: move.clipId,
            toTrackId:
              partnerTrackId && partnerClips.has(move.clipId)
                ? partnerTrackId
                : (move.toTrackId ?? trackId),
            toStart: move.toStart,
          })),
        },
      ],
      partner ? 'Move to new tracks' : `Move to a new ${kind} track`,
      coalesceKey,
    );
  },

  dropAssetOnNewTrack: (assetId, kind, index, start) => {
    const state = get();
    const project = state.project();
    const asset = project.assets[assetId];
    if (!asset) return;

    const duration = asset.video?.duration ?? asset.audio?.duration;
    if (!duration || !T.isPositive(duration)) {
      set({ error: `"${asset.name}" has no usable duration` });
      return;
    }

    const trackId = ids.track();
    const addTrack: Command = { type: 'addTrack', sequenceId: state.sequenceId, kind, index, trackId };

    // Plan against a project that already has the track: the planner works out the
    // append point and any counterpart track from the document, and neither answer
    // is available until this one exists.
    let withTrack: Project;
    try {
      withTrack = apply(project, addTrack, ids);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const placement = planPlacement(withTrack, state.sequenceId, asset, trackId, start ? { start } : {});
    state.runMany([addTrack, ...placement.commands], `Add "${asset.name}"`);
    get().select(placement.clipIds);
    set({
      status: `Added "${asset.name}" on a new ${kind} track${placementNotes(placement)}`,
    });
  },

  captureFrame: async () => {
    const state = get();
    const engine = state.engine;
    if (!engine) {
      set({ error: 'Engine is not ready' });
      return;
    }

    try {
      const project = state.project();
      const sequence = getSequence(project, state.sequenceId);
      const source = state.previewAssetId ? project.assets[state.previewAssetId] : null;
      // One position for both monitors: the channel knows which one is live.
      const at = state.playhead();
      const blob = source
        ? await engine.grabAssetStill(source.id, at)
        : await engine.grabStill(at);
      const frameRate = source?.video?.frameRate ?? sequence.frameRate;
      const stamp = T.toTimecode(at, frameRate);

      /*
       * Two grabs at the same frame would otherwise be the same file twice, which is
       * confusing in a list sorted by name. Counted by name rather than by location,
       * since the still lands wherever the library already is.
       */
      const subject = source ? source.name.replace(/\.[^.]+$/, '') : project.name;
      const base = safeFileName(`${subject} ${stamp}`);
      const taken = Object.values(project.assets).filter((a) => a.name.startsWith(base)).length;
      const fileName = `${base}${taken > 0 ? ` (${taken + 1})` : ''}.png`;

      /*
       * The still also joins the library.
       *
       * It arrives as an ordinary image asset, which means it can be dragged back
       * onto the timeline — a freeze frame of the shot you were looking at, for free,
       * rather than a file that only exists in the downloads folder.
       *
       * Filed alongside everything else rather than in a folder of its own: taking a
       * picture should not quietly reorganise someone's library.
       */
      const [capturedId] = await get().importFiles([
        new File([blob], fileName, { type: 'image/png' }),
      ]);
      if (capturedId) {
        set({ selectedAssetIds: [capturedId], assetSelectionAnchor: capturedId, ...NO_CLIPS });
        window.dispatchEvent(
          new CustomEvent('bvs:reveal-asset', { detail: { assetId: capturedId } }),
        );
      }

      const size = source?.image?.size ?? source?.video?.size ?? sequence.size;

      set({
        status:
          `Captured ${fileName} to the Library — ${size.width}×${size.height}, ` +
          `${(blob.size / 1e6).toFixed(1)} MB.`,
        error: null,
      });
    } catch (err) {
      set({ error: `Could not capture the frame: ${err instanceof Error ? err.message : String(err)}` });
    }
  },

  setDraggingAsset: (assetId) => set({ draggingAssetId: assetId }),

  newProject: () => {
    const { project, sequenceId } = starterProject();
    // Release the old previews' object URLs; nothing references them any more.
    get().previews?.dispose();
    set({
      history: initHistory(project),
      sequenceId,
      selection: [],
      selectedAssetIds: [],
      assetSelectionAnchor: null,
      previewAssetId: null,
      sourceMarks: new Map(),
      mediaFiles: new Map(),
      previews: null,
      previewVersion: 0,
      status: 'New project.',
      error: null,
    });
    get().engine?.setSequence(sequenceId);
    playback.set({ position: T.TIME_ZERO, playing: false, mode: 'program', duration: T.TIME_ZERO });
    autosaver.schedule(project);
    get().engine?.requestRender(T.TIME_ZERO);
  },

  togglePlay: async () => {
    const { engine } = get();
    if (!engine) return;

    if (engine.isPlaying) {
      await engine.pause();
      playback.set({ playing: false });
      // Once, now that it has stopped: the document's copy is for reopening the
      // project, and this is the moment it becomes worth having.
      commitPlayhead(get, playback.get().position);
      set({ status: 'Paused.' });
      return;
    }

    const duration = get().duration();
    if (!T.isPositive(duration)) {
      set({ status: 'Nothing to play yet.' });
      return;
    }

    // Restart from the beginning when the playhead is parked at the end.
    const from = T.gte(get().playhead(), duration) ? T.TIME_ZERO : get().playhead();
    set({ status: 'Playing.' });
    playback.set({ playing: true, duration, mode: 'program', position: from });
    await engine.play(from, (at) => playback.set({ position: at }), duration);
  },

  runExport: async (settings) => {
    const state = get();
    if (!state.engine) {
      set({ error: 'Engine is not ready' });
      return;
    }
    if (exportController) return;
    const sequence = state.project().sequences[state.sequenceId];
    const extension = settings.container === 'mp4' ? 'mp4' : 'webm';
    let destination: ExportDestination | undefined;
    try {
      const chosen = await chooseExportDestination(
        `${sequence?.name || 'sequence'}.${extension}`,
        settings.container,
      );
      if (chosen === 'cancelled') {
        set({ status: 'Export cancelled.' });
        return;
      }
      if (chosen !== 'fallback') destination = chosen;
    } catch (err) {
      set({ error: `Could not open the export destination: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    exportController = new AbortController();
    set({ exportProgress: null, exportBusy: true, error: null, status: 'Exporting…' });

    try {
      await state.engine.pause();
      const result = await exportSequence({
        project: state.project(),
        sequenceId: state.sequenceId,
        media: state.engine.media,
        settings,
        signal: exportController.signal,
        ...(destination ? { destination } : {}),
        onProgress: (progress) => set({ exportProgress: progress }),
      });

      if (result.blob) downloadBlob(result.blob, result.fileName);

      set({
        status: `${destination ? 'Saved' : 'Exported'} ${result.fileName} — ${result.framesEncoded} frames, ${(result.byteLength / 1e6).toFixed(1)} MB.`,
        exportProgress: null,
        exportBusy: false,
      });
    } catch (err) {
      const cancelled = exportController?.signal.aborted === true;
      destination?.cancel();
      set({
        error: cancelled ? null : err instanceof Error ? err.message : String(err),
        exportProgress: null,
        exportBusy: false,
        status: cancelled ? 'Export cancelled.' : 'Export failed.',
      });
    } finally {
      exportController = null;
    }
  },

  cancelExport: () => {
    if (!exportController) return;
    set({ status: 'Cancelling export…' });
    exportController.abort();
  },

  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
  toggleTelemetry: () => set({ showTelemetry: !get().showTelemetry }),

  /**
   * Build filmstrips and waveforms for every ready asset.
   *
   * Runs after import and after a restore, never during an edit — decoding a whole
   * source to rasterise a strip competes with the preview for decoder time.
   */
  buildPreviews: async () => {
    const engine = get().engine;
    if (!engine) return;

    let store = get().previews;
    if (!store) {
      // One counter carries every preview change to the UI: peaks arriving, a
      // thumbnail decoding, a card's poster landing. The lanes paint themselves, so
      // for them this only needs to be a nudge, not a description of what changed.
      store = new PreviewStore(engine.media, () =>
        set({ previewVersion: get().previewVersion + 1 }),
      );
      set({ previews: store });
    }

    for (const asset of Object.values(get().project().assets)) {
      if (asset.status.state !== 'ready') continue;

      // A still is its own thumbnail; there is nothing to decode for the card.
      if (asset.kind === 'image') {
        const file = get().mediaFiles.get(asset.id);
        if (file) store.setPosterUrl(asset.id, URL.createObjectURL(file));
        continue;
      }

      // Peaks are the one preview worth reading ahead of being looked at: the whole
      // file has to be decoded for them, so waiting until a clip is on screen would
      // mean waiting through the decode with a flat clip. Thumbnails are the
      // opposite — the painter asks for the handful under the viewport.
      if (asset.audio) store.ensurePeaks(asset.id, asset.audio.sampleRate, asset.audio.duration);
      store.ensurePoster(asset.id, Boolean(asset.video), asset.audio?.duration ?? null);
    }
  },

  /** Reopen the most recently saved project, if there is one. */
  restoreLastProject: async () => {
    try {
      const loaded = await loadMostRecent();
      if (loaded) await adopt(set, get, loaded, 'Reopened');
    } catch (err) {
      set({ error: `Could not reopen the last project: ${err instanceof Error ? err.message : err}` });
    }
  },

  listStoredProjects: async () => {
    try {
      return await listProjects();
    } catch (err) {
      set({ error: `Could not read the project list: ${err instanceof Error ? err.message : err}` });
      return [];
    }
  },

  openStoredProject: async (id) => {
    if (id === get().project().id) return true;
    try {
      /*
       * Write the project being left before reading the one being opened. The
       * autosaver runs on a debounce, so without this the last few seconds of work
       * would be dropped by the switch — the one moment where losing them is least
       * excusable, since nothing about clicking Open suggests discarding anything.
       */
      await flushAutosave();

      const loaded = await loadProject(id);
      if (!loaded) {
        set({ error: 'That project is no longer in browser storage.' });
        return false;
      }
      await adopt(set, get, loaded, 'Opened');
      return true;
    } catch (err) {
      set({ error: `Could not open that project: ${err instanceof Error ? err.message : err}` });
      return false;
    }
  },

  renameStoredProject: async (id, name) => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    try {
      if (id === get().project().id) {
        // The open document is the source of truth for its own name, and the index
        // is rebuilt from it — so this goes through a command, and is undoable.
        get().run({ type: 'setProjectName', name: trimmed }, 'Rename project');
        // Flushed rather than left to the debounce so the browser listing, which is
        // read straight back from disk, does not show the old name for a second.
        await flushAutosave();
      } else {
        await renameStoredProject(id, trimmed);
      }
    } catch (err) {
      set({ error: `Could not rename that project: ${err instanceof Error ? err.message : err}` });
    }
  },

  deleteStoredProject: async (id) => {
    const wasOpen = id === get().project().id;
    try {
      await deleteProject(id);
    } catch (err) {
      set({ error: `Could not delete that project: ${err instanceof Error ? err.message : err}` });
      return;
    }

    /*
     * Deleting what is on screen has to move off it as well. The autosaver holds the
     * open document and writes it on the next edit, so a project deleted while open
     * would simply reappear — with its media gone, since that is not coming back.
     */
    if (!wasOpen) {
      set({ status: 'Project deleted.' });
      return;
    }
    try {
      const next = await loadMostRecent();
      if (next) {
        await adopt(set, get, next, 'Deleted that project; opened');
        return;
      }
    } catch {
      // Fall through: a broken neighbour is no reason to leave the deleted one up.
    }
    get().newProject();
    set({ status: 'Project deleted. Started a new one.' });
  },

  saveProjectToFile: async (id) => {
    try {
      let project: Project;
      let media: ReadonlyMap<AssetId, File>;

      if (id === get().project().id) {
        // The open project is saved from memory, unwritten edits included — waiting
        // on the debounce would hand over a file a few seconds out of date.
        project = get().project();
        media = get().mediaFiles;
      } else {
        const loaded = await loadProject(id);
        if (!loaded) {
          set({ error: 'That project is no longer in browser storage.' });
          return;
        }
        project = loaded.project;
        media = loaded.media;
      }

      const size = projectFileSize(project, media);
      set({ status: `Packing "${project.name}" (${formatBytes(size)})…`, error: null });

      const blob = writeProjectFile(project, media);
      downloadBlob(blob, projectFileName(project.name));

      const short = Object.keys(project.assets).length - media.size;
      set({
        status:
          `Saved "${project.name}" — ${formatBytes(blob.size)}` +
          (short > 0 ? `, without ${short} file(s) that were never cached.` : '.'),
      });
    } catch (err) {
      set({
        error: `Could not save that project: ${err instanceof Error ? err.message : err}`,
        status: 'Nothing was saved.',
      });
    }
  },

  openProjectFile: async (file) => {
    try {
      set({ status: `Reading ${file.name}…`, error: null });
      const read = await readProjectFile(file);

      /*
       * Filed as a new project rather than restored over whatever shares its id.
       * Opening a file is not meant to overwrite anything, and the same file opened
       * twice — or a copy sent to someone who already has the original — must not
       * quietly replace the work already here.
       */
      const project: Project = { ...read.project, id: ids.project() };

      await flushAutosave();
      await saveProject(project);
      for (const [assetId, media] of read.media) {
        await saveMedia(
          project.id,
          assetId,
          media,
          project.settings.copyMediaToOpfsUpToBytes,
        ).catch(() => false);
      }

      await adopt(set, get, { ...read, project }, 'Opened');
      return true;
    } catch (err) {
      set({
        error: `Could not open ${file.name}: ${err instanceof Error ? err.message : err}`,
        // Cleared, or the status line goes on saying "Reading…" underneath the
        // failure and reads as a job still in progress.
        status: 'Nothing was opened.',
      });
      return false;
    }
  },

  openProjectFileViaPicker: async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = PROJECT_FILE_EXTENSION;

    const file = await new Promise<File | null>((resolve) => {
      input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
      // A cancelled dialog fires no 'change' event; 'cancel' covers that.
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });

    return file ? get().openProjectFile(file) : false;
  },
}));

/**
 * Put a project read from disk on screen.
 *
 * Shared by every route in — restoring on launch, opening from the browser, and
 * falling back after a delete — so all three land in exactly the same state rather
 * than each remembering to reset a different subset of it.
 */
async function adopt(
  set: (partial: Partial<StudioState>) => void,
  get: () => StudioState,
  loaded: LoadedProject,
  verb: string,
): Promise<void> {
  // Repair any time whose denominator has grown past working with, before anything
  // touches the document — one edit on such a value throws, and the throw used to
  // take the whole window with it. Almost always a no-op; see `repairProjectTimes`.
  const repair = repairProjectTimes(loaded.project);

  // Record what could not be found on the assets themselves, before the history
  // is seeded. Done here rather than through `run` because it is not an edit:
  // nobody should be able to undo the discovery that a file has gone.
  let project = repair.project;
  for (const assetId of loaded.missingAssetIds) {
    project = apply(project, { type: 'setAssetStatus', assetId, status: { state: 'missing' } }, ids);
  }

  const proxies = new Map<AssetId, File>();
  for (const asset of Object.values(project.assets)) {
    if (!asset.derived.proxyPath) continue;
    const proxy = await loadProxy(project.id, asset.id);
    if (proxy) {
      proxies.set(asset.id, proxy);
      continue;
    }
    // Project files intentionally omit disposable proxies. Do not leave metadata
    // claiming one exists after such a project is opened on another machine.
    project = apply(
      project,
      {
        type: 'replaceAsset',
        assetId: asset.id,
        asset: {
          ...asset,
          derived: { ...asset.derived, proxyPath: null, proxySize: null },
        },
      },
      ids,
    );
  }

  const sequenceId = project.activeSequenceId;
  get().previews?.dispose();
  set({
    history: initHistory(project),
    sequenceId,
    selection: [],
    selectedTrackId: null,
    selectedTransitionId: null,
    selectionAnchor: null,
    selectedAssetIds: [],
    assetSelectionAnchor: null,
    previewAssetId: null,
    sourceMarks: new Map(),
    mediaFiles: loaded.media,
    previews: null,
    previewVersion: 0,
    error: null,
    // Nothing has been edited yet, so the indicator must not claim a save that
    // belongs to whatever was open before.
    saveState: 'idle',
    // Both notes, not whichever one is checked first: a repair said out loud is the
    // point of doing it — the values moved by up to half a frame — and a missing
    // file must not be what hides that.
    status: [
      `${verb} "${project.name}"`,
      loaded.missingAssetIds.length > 0
        ? ` — ${loaded.missingAssetIds.length} file(s) need re-importing`
        : '',
      repair.repaired > 0 ? ` — ${repair.repaired} time(s) realigned to the frame grid` : '',
      '.',
    ].join(''),
  });

  const engine = get().engine;
  if (!engine) return;

  await engine.pause();
  engine.setSequence(sequenceId);
  playback.set({ playing: false, mode: 'program' });
  adoptPlayheadFrom(project, sequenceId);

  /*
   * Opened one at a time and forgiven individually. A file the decoder will not
   * take is a problem for its own clips, not for the project — a single refusal
   * used to throw out of this loop and leave every asset after it unopened, so one
   * unreadable import cost you the whole reopen.
   */
  const unreadable: AssetId[] = [];
  for (const [assetId, file] of loaded.media) {
    const kind = project.assets[assetId]?.kind;
    if (!kind) continue;
    try {
      await engine.openAsset(assetId, file, kind);
    } catch {
      unreadable.push(assetId);
    }
  }
  for (const [assetId, proxy] of proxies) {
    try {
      await engine.openProxy(assetId, proxy);
    } catch {
      engine.media.closeProxy(assetId);
    }
  }
  queueAutomaticProxies(get, Object.keys(project.assets) as AssetId[]);

  if (unreadable.length > 0) {
    // Same treatment as a file that has gone: the clips stay, and the library says
    // which source needs replacing.
    let marked = get().project();
    for (const assetId of unreadable) {
      marked = apply(marked, { type: 'setAssetStatus', assetId, status: { state: 'missing' } }, ids);
    }
    set({
      history: initHistory(marked),
      status: `${verb} "${marked.name}" — ${unreadable.length} file(s) could not be decoded.`,
    });
  }

  engine.requestRender(get().playhead());
  void get().buildPreviews();
}

/**
 * What a placement changed beyond adding the clip, for the status line.
 *
 * Both of these alter the project in ways nobody asked for directly, so they have to
 * be said out loud — a sequence that silently changed resolution is indistinguishable
 * from a bug.
 */
function placementNotes(placement: PlacementPlan): string {
  const notes: string[] = [];
  if (placement.adoptedFormat) {
    const { size, frameRate } = placement.adoptedFormat;
    notes.push(
      `sequence set to ${size.width}x${size.height} at ` +
        `${T.fpsToNumber(frameRate).toFixed(2)} fps to match it`,
    );
  }
  if (placement.fittedScale !== null) {
    notes.push(`scaled to ${Math.round(placement.fittedScale * 100)}% to fit the frame`);
  }
  if (placement.createdTrackName) {
    notes.push(`created ${placement.createdTrackName} for its other stream`);
  }
  return notes.length > 0 ? ` — ${notes.join(', ')}.` : '.';
}

/** Default export settings derived from the sequence. */
export function defaultExportSettings(project: Project, sequenceId: SequenceId): ExportSettings {
  const sequence = getSequence(project, sequenceId);
  return {
    container: 'mp4',
    size: sequence.size,
    frameRate: sequence.frameRate,
    bitrate: suggestBitrate(sequence.size, sequence.frameRate),
    includeAudio: true,
  };
}

/**
 * The audio track paired with a video track, or vice versa — matched by position,
 * so V2 pairs with A2.
 *
 * Dropping a clip with both streams puts each on its own track, and the pair the
 * user means is the one at the same index, not simply the first audio track.
 * Returns null when the other list is shorter.
 */
export function counterpartTrackId(
  project: Project,
  sequenceId: SequenceId,
  trackId: TrackId,
): TrackId | null {
  const sequence = getSequence(project, sequenceId);
  const videoIndex = sequence.videoTrackIds.indexOf(trackId);
  if (videoIndex >= 0) return sequence.audioTrackIds[videoIndex] ?? null;
  const audioIndex = sequence.audioTrackIds.indexOf(trackId);
  if (audioIndex >= 0) return sequence.videoTrackIds[audioIndex] ?? null;
  return null;
}

/**
 * Where a newly placed clip starts on a track: after whatever is already there,
 * or 0:00 when the track is empty.
 *
 * When the clip also occupies the paired track, both start at the later of the two
 * ends. Placing them at their own track's end would offset a linked video and its
 * audio from each other, which is never what appending means.
 */
export function appendPointFor(
  project: Project,
  sequenceId: SequenceId,
  trackId: TrackId,
  includePartner: boolean,
): Time {
  let end = trackDuration(project, trackId);
  if (includePartner) {
    const partnerId = counterpartTrackId(project, sequenceId, trackId);
    if (partnerId) end = T.max(end, trackDuration(project, partnerId));
  }
  return end;
}

/**
 * The bare cut nearest the playhead, or null when there is none to use.
 *
 * Shared by the command and by whatever offers it, so a button cannot claim a
 * transition is available when running it would only produce an error. Searches the
 * selected clips' tracks when there is a selection, and every track when there is not.
 */
function bareCutNearPlayhead(
  state: StudioState,
  trackId?: TrackId,
): { from: Clip; to: Clip; distanceSeconds: number } | null {
  const project = state.project();
  const at = state.playhead();

  const searched = trackId
    ? [trackId]
    : state.selection.length > 0
      ? [...new Set(state.selection.map((id) => project.clips[id]?.trackId))].filter(
          (id): id is TrackId => id !== undefined,
        )
      : orderedTrackIds(project, state.sequenceId);

  let best: { from: Clip; to: Clip; distanceSeconds: number } | null = null;
  for (const id of searched) {
    const cut = nearestCut(project, id, at);
    if (cut && (!best || cut.distanceSeconds < best.distanceSeconds)) best = cut;
  }
  return best;
}

/**
 * Where a generated clip — a title, a colour — should go.
 *
 * Above the picture rather than through it. The topmost video track is used when it
 * happens to be free at that moment; when something is already there, a new track is
 * made above instead of carving a hole in it. This used to overwrite the top track
 * unconditionally, which was survivable while a new project had a spare one and is
 * not now that it has exactly one.
 */
function planGenerated(
  project: Project,
  sequenceId: SequenceId,
  spec: NewClipSpec,
): { commands: Command[]; createdTrack: boolean; clipId: ClipId } {
  const sequence = getSequence(project, sequenceId);
  const top = sequence.videoTrackIds[sequence.videoTrackIds.length - 1];
  const range = T.rangeFromBounds(spec.start, T.add(spec.start, spec.duration));

  // Named here rather than left to the handler, so the caller can select the thing
  // it just made — the same reason `planPlacement` names the clips it inserts.
  const clipId = spec.clipId ?? ids.clip();
  const clip: NewClipSpec = { ...spec, clipId };

  if (top !== undefined && clipsWithin(project, [top], range).length === 0) {
    return {
      commands: [{ type: 'insertClip', trackId: top, mode: 'overwrite', clip }],
      createdTrack: false,
      clipId,
    };
  }

  const trackId = ids.track();
  return {
    commands: [
      {
        type: 'addTrack',
        sequenceId,
        kind: 'video',
        index: sequence.videoTrackIds.length,
        trackId,
      },
      { type: 'insertClip', trackId, mode: 'overwrite', clip },
    ],
    createdTrack: true,
    clipId,
  };
}

export interface PlacementPlan {
  readonly commands: readonly Command[];
  readonly start: Time;
  /**
   * The clips this plan inserts — one, or two for a linked picture and sound.
   *
   * Named up front so the caller can select what it just made. Reading them back
   * off the document afterwards would mean diffing it, which is guesswork the plan
   * does not need to leave anyone to do.
   */
  readonly clipIds: readonly ClipId[];
  /** Name of a track that had to be created, for the status line. */
  readonly createdTrackName: string | null;
  /** The sequence took its format from this clip, for the status line. */
  readonly adoptedFormat: { readonly size: Size; readonly frameRate: FrameRate } | null;
  /** The clip was scaled to fit a frame it did not match, for the status line. */
  readonly fittedScale: number | null;
}

/**
 * Natural size of an asset's picture, or null when it has none.
 *
 * A still reports through `image`; anything decoded reports through `video`.
 */
function visualSize(asset: Asset): Size | null {
  const size = asset.video?.size ?? asset.image?.size ?? null;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/**
 * The format an empty sequence should take from the first thing put in it, or null
 * to leave it alone.
 *
 * A sequence is created before any media exists, so its resolution is necessarily a
 * guess — and the guess was always 1920x1080. Dropping a 576x360 recording into that
 * drew it at native size in the middle of a frame three times too big, with no way to
 * correct it. Taking the format from the footage is what every editor does with a new
 * sequence, and it is the only answer that neither crops nor upscales.
 *
 * Restricted to video: a still is often a logo or a poster frame at some unrelated
 * size, and letting one dictate the whole project would be worse than the guess. It
 * also only applies while nothing has been cut yet, so it can never resize a sequence
 * someone has started editing.
 */
export function formatToAdopt(
  project: Project,
  sequenceId: SequenceId,
  asset: Asset,
): { size: Size; frameRate: FrameRate } | null {
  /*
   * Decoded footage only, tested on `kind` rather than on the presence of a video
   * stream. A still carries a synthetic one — `importImage` fills it in so an image
   * can be laid on a video track — so asking whether `asset.video` exists lets a
   * 4000x3000 logo declare itself the format of the whole project.
   */
  if (asset.kind !== 'video') return null;

  const sequence = getSequence(project, sequenceId);
  const empty = [...sequence.videoTrackIds, ...sequence.audioTrackIds].every(
    (id) => (project.tracks[id]?.clipIds.length ?? 0) === 0,
  );
  if (!empty) return null;

  const sourceSize = asset.video?.size;
  const size = sourceSize ? encoderSafeSequenceSize(sourceSize) : null;
  if (!size || size.width <= 0 || size.height <= 0) return null;

  const frameRate = asset.video?.frameRate ?? sequence.frameRate;
  const same =
    size.width === sequence.size.width &&
    size.height === sequence.size.height &&
    frameRate.num === sequence.frameRate.num &&
    frameRate.den === sequence.frameRate.den;
  return same ? null : { size, frameRate };
}

/**
 * Scale that fits a picture inside the frame without cropping it.
 *
 * 1 when it already fits exactly, so the common case adds no command at all. Larger
 * sources shrink to contain; smaller ones are left alone rather than blown up —
 * upscaling is lossy, and a clip deliberately placed small should stay small. The
 * value is only a starting point either way; it is an ordinary clip transform the
 * inspector can change.
 */
function fitScale(source: Size, frame: Size): number {
  const scale = Math.min(frame.width / source.width, frame.height / source.height);
  return scale < 1 ? scale : 1;
}

/**
 * Work out how to place an asset on a track: where it starts, and whether a track
 * has to be created for its other stream.
 *
 * An asset with both streams needs a track for each. If the counterpart is missing —
 * dropping video on V2 when only A1 exists — the audio would otherwise be silently
 * discarded, so the missing tracks are created instead. Shared by dropping and by
 * "Add to timeline" so the two cannot disagree.
 */
export function planPlacement(
  project: Project,
  sequenceId: SequenceId,
  asset: Asset,
  trackId: TrackId,
  options: {
    readonly start?: Time;
    readonly sourceIn?: Time;
    readonly duration?: Time;
    readonly mode?: 'insert' | 'overwrite';
  } = {},
): PlacementPlan {
  const sequence = getSequence(project, sequenceId);
  const track = project.tracks[trackId]!;
  const duration = options.duration ?? (asset.video?.duration ?? asset.audio?.duration)!;

  const partnerKind: TrackKind = track.kind === 'video' ? 'audio' : 'video';
  const needsPartner = partnerKind === 'audio' ? Boolean(asset.audio) : Boolean(asset.video);

  const ownList = track.kind === 'video' ? sequence.videoTrackIds : sequence.audioTrackIds;
  const partnerList = partnerKind === 'video' ? sequence.videoTrackIds : sequence.audioTrackIds;
  const index = ownList.indexOf(trackId);

  const commands: Command[] = [];
  let partnerTrackId = counterpartTrackId(project, sequenceId, trackId);
  let createdTrackName: string | null = null;

  /*
   * First footage into an empty sequence sets its format.
   *
   * Done before the clip goes in, so the fit below measures against the frame the
   * sequence is about to have rather than the one it is leaving behind.
   */
  const adoptedFormat = formatToAdopt(project, sequenceId, asset);
  if (adoptedFormat) {
    commands.push({
      type: 'setSequenceSettings',
      sequenceId,
      size: adoptedFormat.size,
      frameRate: adoptedFormat.frameRate,
    });
  }

  if (needsPartner && !partnerTrackId && index >= 0) {
    // Fill the counterpart list up to the same index, so V3 pairs with a new A3.
    const prefix = partnerKind === 'video' ? 'V' : 'A';
    for (let i = partnerList.length; i <= index; i++) {
      const newTrackId = ids.track();
      commands.push({ type: 'addTrack', sequenceId, kind: partnerKind, trackId: newTrackId });
      partnerTrackId = newTrackId;
      createdTrackName = `${prefix}${i + 1}`;
    }
  }

  const usesPartner = needsPartner && Boolean(partnerTrackId);
  // A track that is about to be created is empty, so it cannot move the start.
  const start = options.start ?? appendPointFor(project, sequenceId, trackId, usesPartner && !createdTrackName);
  const linkGroupId = `lg_${asset.id}_${start.num}_${start.den}`;

  // A still becomes an image clip, which trims without a source bound.
  const visualKind = asset.kind === 'image' ? 'image' : 'video';

  /*
   * A picture that does not match the frame is fitted to it.
   *
   * The compositor draws every layer at its own pixel size, so without this a clip
   * that disagrees with the sequence either floats in a surround of black or hangs
   * off the edges. Only bites when the sequence already had a format to keep — the
   * adoption above makes the first clip an exact match, so it scales by 1.
   */
  const source = visualSize(asset);
  const frame = adoptedFormat?.size ?? sequence.size;
  const scale = source ? fitScale(source, frame) : 1;
  const visualClipId = ids.clip();
  const audioClipId = ids.clip();
  const idFor = (kind: 'video' | 'audio' | 'image'): ClipId =>
    kind === 'audio' ? audioClipId : visualClipId;

  const clipFor = (kind: 'video' | 'audio' | 'image'): NewClipSpec => ({
    kind,
    assetId: asset.id,
    start,
    duration,
    ...(options.sourceIn ? { sourceIn: options.sourceIn } : {}),
    name: asset.name,
    // The picture needs its id up front to be scaled in the same batch; the sound
    // is named for the same reason both are: so the caller can select them.
    clipId: idFor(kind),
    ...(usesPartner ? { linkGroupId } : {}),
  });

  const primaryKind = track.kind === 'video' ? visualKind : 'audio';
  const clipIds: ClipId[] = [idFor(primaryKind)];
  commands.push({
    type: 'insertClip',
    trackId,
    mode: options.mode ?? 'overwrite',
    clip: clipFor(primaryKind),
  });
  if (usesPartner && partnerTrackId) {
    const otherKind = partnerKind === 'video' ? visualKind : 'audio';
    clipIds.push(idFor(otherKind));
    commands.push({
      type: 'insertClip',
      trackId: partnerTrackId,
      mode: options.mode ?? 'overwrite',
      clip: clipFor(otherKind),
    });
  }

  const fitted = scale !== 1 && (track.kind === 'video' || usesPartner);
  if (fitted) {
    for (const key of ['transform.scaleX', 'transform.scaleY'] as const) {
      commands.push({
        type: 'setClipParam',
        clipId: visualClipId,
        key,
        param: staticParam(scale),
      });
    }
  }

  return {
    commands,
    start,
    clipIds,
    createdTrackName,
    adoptedFormat,
    fittedScale: fitted ? scale : null,
  };
}

/** Tracks in display order: video top-down (so V2 is above V1), then audio. */
export function orderedTrackIds(project: Project, sequenceId: SequenceId): readonly TrackId[] {
  const sequence = getSequence(project, sequenceId);
  return [...[...sequence.videoTrackIds].reverse(), ...sequence.audioTrackIds];
}

/**
 * The tracks a "remove empty tracks" sweep would take.
 *
 * Shared with the menus, so what they grey out and what the command does cannot
 * drift apart.
 *
 * A stack that is empty all the way down keeps its first track: a sequence with no
 * video lane has nowhere to drop a picture, and the counterpart-filling in
 * `planPlacement` would only have to build one back. Tidying is not worth handing
 * back a sequence you have to repair before using.
 */
export function emptyTracksToRemove(
  project: Project,
  sequenceId: SequenceId,
): readonly TrackId[] {
  const sequence = getSequence(project, sequenceId);
  const removing: TrackId[] = [];

  for (const list of [sequence.videoTrackIds, sequence.audioTrackIds]) {
    const empty = list.filter((trackId) => project.tracks[trackId]?.clipIds.length === 0);
    removing.push(...(empty.length === list.length ? empty.slice(1) : empty));
  }

  return removing;
}
