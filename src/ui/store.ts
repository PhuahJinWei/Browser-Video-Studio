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
import { exportSequence, suggestBitrate, type ExportProgress, type ExportSettings } from '../engine/export';
import { isImageFile, MediaLibrary } from '../engine/media';
import {
  densityForZoom,
  PreviewCache,
  waveformDensityForZoom,
} from '../engine/previews';
import { apply, type Command, type NewClipSpec } from '../model/commands';
import { normaliseFolder } from '../model/commands/handlers';
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
import { staticParam } from '../model/params';
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
  Autosaver,
  deleteMedia,
  deleteProject,
  listProjects,
  loadMostRecent,
  loadProject,
  renameProject as renameStoredProject,
  saveMedia,
  type LoadedProject,
  type ProjectSummary,
  type SaveState,
} from '../storage/projectStore';

const ids = randomIdSource;

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

/** Files above this size are not copied into OPFS; reopening asks for them again. */
const MEDIA_COPY_LIMIT_BYTES = 2_000_000_000;


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
  engine: Engine | null;
  /** Source blobs, kept so the engine can reopen assets. */
  mediaFiles: ReadonlyMap<AssetId, File>;
  telemetry: EngineTelemetry | null;
  previews: PreviewCache | null;
  /** Bumped whenever a preview finishes, so the timeline re-renders. */
  previewVersion: number;
  exportProgress: ExportProgress | null;
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
  /** Build filmstrip and waveform tiles for the current zoom and visible range. */
  refreshPreviewDensity: (visible?: {
    readonly startSeconds: number;
    readonly endSeconds: number;
  }) => void;

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
  dropAssetOnNewTrack: (assetId: AssetId, kind: TrackKind, index: number) => void;

  /** Save the frame under the playhead as a PNG, at full sequence resolution. */
  grabScreenshot: () => Promise<void>;

  attachEngine: (canvas: HTMLCanvasElement) => Promise<void>;
  /** `folder` files the imports straight into a media-bin folder as they land. */
  importFiles: (
    files: readonly File[],
    options?: { readonly folder?: string },
  ) => Promise<void>;
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
  dropAssetOnTrack: (assetId: AssetId, trackId: TrackId) => void;
  setDraggingAsset: (assetId: AssetId | null) => void;
  newProject: () => void;
  togglePlay: () => Promise<void>;
  runExport: (settings: ExportSettings) => Promise<void>;
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
 * A short settling pause avoids starting work at every wheel notch. Tiles and tier
 * fallbacks make aborts cheap now, so this can stay below the delay people perceive.
 */
const DENSITY_DEBOUNCE_MS = 100;
let densityTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped per pass, so an older sweep stops when a newer zoom starts one. */
let densityRun = 0;

export const useStudio = create<StudioState>((set, get) => ({
  history: initHistory(initial.project),
  sequenceId: initial.sequenceId,
  selection: [],
  selectedTrackId: null,
  selectedTransitionId: null,
  selectionAnchor: null,
  selectedAssetIds: [],
  assetSelectionAnchor: null,
  engine: null,
  mediaFiles: new Map(),
  telemetry: null,
  previews: null,
  previewVersion: 0,
  exportProgress: null,
  draggingAssetId: null,
  status: 'Import media to begin.',
  error: null,
  saveState: 'idle',
  // Off to begin with. The panel is worth having — it is the only window onto
  // where a frame's time actually goes — but it sits over the picture, and the
  // picture is what you open the app to look at.
  showTelemetry: false,

  project: () => current(get().history),
  playhead: () => getSequence(get().project(), get().sequenceId).view.playhead,
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
    autosaver.schedule(current(history));
    get().engine?.refresh();
  },
  redoEdit: () => {
    const history = redo(get().history);
    set({ history, selection: [] });
    autosaver.schedule(current(history));
    get().engine?.refresh();
  },
  canUndoEdit: () => canUndo(get().history),
  canRedoEdit: () => canRedo(get().history),

  selectExact: (clipIds) =>
    set({ selection: clipIds, selectedTrackId: null, selectedTransitionId: null }),

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
    });
  },

  // ------------------------------------------------------------------ library

  selectAssets: (assetIds) =>
    set({ selectedAssetIds: assetIds, assetSelectionAnchor: assetIds[0] ?? null }),

  toggleSelectAsset: (assetId) => {
    const current = get().selectedAssetIds;
    set({
      selectedAssetIds: current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId],
      assetSelectionAnchor: assetId,
    });
  },

  selectAssetRangeTo: (assetId, ordered) => {
    const anchor = get().assetSelectionAnchor ?? get().selectedAssetIds[0];
    const from = anchor === undefined ? -1 : ordered.indexOf(anchor);
    const to = ordered.indexOf(assetId);

    // Nothing to measure from, or the anchor has been filtered out of view.
    if (from < 0 || to < 0) {
      set({ selectedAssetIds: [assetId], assetSelectionAnchor: assetId });
      return;
    }
    set({
      selectedAssetIds: ordered.slice(Math.min(from, to), Math.max(from, to) + 1),
      // The anchor stays put, so shift-clicking again re-measures from it.
      assetSelectionAnchor: anchor ?? null,
    });
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
      });
      for (const assetId of removed) void deleteMedia(project.id, assetId);
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
    get().runTransient({ type: 'setView', sequenceId: get().sequenceId, view: { playhead: clamped } });
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
    get().refreshPreviewDensity();
  },

  /** Ask for filmstrip and waveform tiles fine enough for the current viewport. */
  refreshPreviewDensity: (visible) => {
    if (densityTimer !== null) clearTimeout(densityTimer);
    densityTimer = setTimeout(() => {
      densityTimer = null;
      const state = get();
      const cache = state.previews;
      if (!cache) return;

      const project = state.project();
      const zoom = getSequence(project, state.sequenceId).view.zoom;

      type DensityRequest = {
        density: number;
        prioritySeconds?: number;
        priorityDistance: number;
      };
      const videoWanted = new Map<AssetId, DensityRequest>();
      const audioWanted = new Map<AssetId, DensityRequest>();
      const visibleCentre = visible
        ? (visible.startSeconds + visible.endSeconds) / 2
        : null;
      for (const clip of Object.values(project.clips)) {
        if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
        const asset = project.assets[clip.assetId];
        if (!asset) continue;

        let candidateSeconds: number | undefined;
        let candidateDistance = Number.POSITIVE_INFINITY;
        if (visible && visibleCentre !== null) {
          const start = T.toSeconds(clip.start);
          const end = start + T.toSeconds(clip.duration);
          if (start < visible.endSeconds && end > visible.startSeconds) {
            const timelineAt = Math.max(start, Math.min(end, visibleCentre));
            candidateDistance = Math.abs(timelineAt - visibleCentre);
            candidateSeconds =
              T.toSeconds(clip.sourceIn) +
              (timelineAt - start) * (Math.abs(clip.speed) || 1);
          }
        }

        if (clip.kind === 'audio') {
          if (!asset.audio) continue;
          const density = waveformDensityForZoom(
            zoom,
            clip.speed,
            typeof window === 'undefined' ? 1 : window.devicePixelRatio,
          );
          const current = audioWanted.get(clip.assetId);
          const useCandidate = candidateDistance <
            (current?.priorityDistance ?? Number.POSITIVE_INFINITY);
          audioWanted.set(clip.assetId, {
            density: Math.max(current?.density ?? 0, density),
            ...(useCandidate && candidateSeconds !== undefined
              ? { prioritySeconds: candidateSeconds }
              : current?.prioritySeconds !== undefined
                ? { prioritySeconds: current.prioritySeconds }
                : {}),
            priorityDistance: useCandidate
              ? candidateDistance
              : current?.priorityDistance ?? Number.POSITIVE_INFINITY,
          });
          continue;
        }

        if (!asset.video) continue;
        const track = project.tracks[clip.trackId];
        const { width, height } = asset.video.size;
        const starter = cache.getFilmstrip(clip.assetId);
        const frameAspect = starter && starter.frameWidth > 0 && starter.frameHeight > 0
          ? starter.frameWidth / starter.frameHeight
          : width > 0 && height > 0
            ? width / height
            : 16 / 9;
        // The row separator plus the clip's two border pixels do not contain image;
        // using the content box makes each CSS cell match the source aspect on screen.
        const previewHeight = Math.max(1, Math.max(36, track?.height ?? 36) - 3);
        const density = densityForZoom(
          zoom,
          clip.speed,
          frameAspect,
          previewHeight,
        );
        const current = videoWanted.get(clip.assetId);
        const useCandidate = candidateDistance <
          (current?.priorityDistance ?? Number.POSITIVE_INFINITY);
        videoWanted.set(clip.assetId, {
          density: Math.max(current?.density ?? 0, density),
          ...(useCandidate && candidateSeconds !== undefined
            ? { prioritySeconds: candidateSeconds }
            : current?.prioritySeconds !== undefined
              ? { prioritySeconds: current.prioritySeconds }
              : {}),
          priorityDistance: useCandidate
            ? candidateDistance
            : current?.priorityDistance ?? Number.POSITIVE_INFINITY,
        });
      }

      // One asset at a time. Concurrent range decodes compete for the same demuxer
      // and hardware, making the preview actually on screen finish last.
      const run = ++densityRun;
      void (async () => {
        // Waveform ranges are quick and fix the currently visible blur first.
        for (const [assetId, request] of audioWanted) {
          if (run !== densityRun) return;
          const asset = project.assets[assetId];
          if (!asset?.audio) continue;
          await cache.ensureWaveformDensity(
            assetId,
            asset.audio.duration,
            request.density,
            request.prioritySeconds,
          );
          set({ previewVersion: get().previewVersion + 1 });
        }

        for (const [assetId, request] of videoWanted) {
          // A newer zoom has taken over; its own pass covers what is left.
          if (run !== densityRun) return;
          const asset = project.assets[assetId];
          if (!asset?.video) continue;

          await cache.ensureDensity(
            assetId,
            asset.video.duration,
            request.density,
            request.prioritySeconds,
          );
          set({ previewVersion: get().previewVersion + 1 });
        }
      })();
    }, DENSITY_DEBOUNCE_MS);
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
      engine.requestRender(get().playhead());
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  importFiles: async (files, options) => {
    if (files.length === 0) return;
    set({ status: `Importing ${files.length} file(s)…`, error: null });

    const nextFiles = new Map(get().mediaFiles);
    const commands: Command[] = [];
    const failures: string[] = [];
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
        nextFiles.set(assetId, file);
        await get().engine?.openAsset(assetId, file, asset.kind);
        // Copy beside the project so it reopens after a reload.
        await saveMedia(get().project().id, assetId, file, MEDIA_COPY_LIMIT_BYTES).catch(() => false);
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (commands.length > 0) {
      set({ mediaFiles: nextFiles });
      get().runMany(commands, `Import ${commands.length} file(s)`);
    }
    set({
      status: `${commands.length} imported${failures.length ? `, ${failures.length} failed` : ''}.`,
      error: failures.length > 0 ? failures.join('\n') : null,
    });
    // Filmstrips and waveforms are built in the background; the timeline picks them
    // up when they land rather than blocking the import on them.
    void get().buildPreviews();
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
  dropAssetOnTrack: (assetId, trackId) => {
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

    const placement = planPlacement(project, state.sequenceId, asset, trackId);
    get().runMany(placement.commands, `Add "${asset.name}"`);
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

  dropAssetOnNewTrack: (assetId, kind, index) => {
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

    const placement = planPlacement(withTrack, state.sequenceId, asset, trackId);
    state.runMany([addTrack, ...placement.commands], `Add "${asset.name}"`);
    set({
      status: `Added "${asset.name}" on a new ${kind} track${placementNotes(placement)}`,
    });
  },

  grabScreenshot: async () => {
    const state = get();
    const engine = state.engine;
    if (!engine) {
      set({ error: 'Engine is not ready' });
      return;
    }

    try {
      const at = state.playhead();
      const project = state.project();
      const sequence = getSequence(project, state.sequenceId);

      const blob = await engine.grabStill(at);
      const stamp = T.toTimecode(at, sequence.frameRate);

      /*
       * Two grabs at the same frame would otherwise be the same file twice, which is
       * confusing in a list sorted by name. Counted by name rather than by location,
       * since the still lands wherever the library already is.
       */
      const base = safeFileName(`${project.name} ${stamp}`);
      const taken = Object.values(project.assets).filter((a) => a.name.startsWith(base)).length;
      const fileName = `${base}${taken > 0 ? ` (${taken + 1})` : ''}.png`;

      downloadBlob(blob, fileName);

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
      await get().importFiles([new File([blob], fileName, { type: 'image/png' })]);

      set({
        status:
          `Saved ${fileName} — ${sequence.size.width}×${sequence.size.height}, ` +
          `${(blob.size / 1e6).toFixed(1)} MB, and added to the library.`,
        error: null,
      });
    } catch (err) {
      set({ error: `Could not save the frame: ${err instanceof Error ? err.message : String(err)}` });
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
      mediaFiles: new Map(),
      previews: null,
      previewVersion: 0,
      status: 'New project.',
      error: null,
    });
    get().engine?.setSequence(sequenceId);
    autosaver.schedule(project);
    get().engine?.requestRender(T.TIME_ZERO);
  },

  togglePlay: async () => {
    const { engine } = get();
    if (!engine) return;

    if (engine.isPlaying) {
      await engine.pause();
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
    await engine.play(
      from,
      (at) => {
        get().runTransient({ type: 'setView', sequenceId: get().sequenceId, view: { playhead: at } });
      },
      duration,
    );
  },

  runExport: async (settings) => {
    const state = get();
    if (!state.engine) {
      set({ error: 'Engine is not ready' });
      return;
    }
    await state.engine.pause();
    set({ exportProgress: null, error: null, status: 'Exporting…' });

    try {
      const result = await exportSequence({
        project: state.project(),
        sequenceId: state.sequenceId,
        media: state.engine.media,
        settings,
        onProgress: (progress) => set({ exportProgress: progress }),
      });

      downloadBlob(result.blob, result.fileName);

      set({
        status: `Exported ${result.fileName} — ${result.framesEncoded} frames, ${(result.blob.size / 1e6).toFixed(1)} MB.`,
        exportProgress: null,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        exportProgress: null,
        status: 'Export failed.',
      });
    }
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

    let cache = get().previews;
    if (!cache) {
      // Progress reuses the version counter the finished previews already ride on,
      // so a moving bar re-renders the bin and the lanes by the same route.
      cache = new PreviewCache(engine.media, () =>
        set({ previewVersion: get().previewVersion + 1 }),
      );
      set({ previews: cache });
    }

    const assets = Object.values(get().project().assets);

    // Mark the whole queue before starting on it. Previews are built one asset at a
    // time, so without this the tenth import shows nothing at all until the ninth
    // has finished — which looks like it failed rather than like it is waiting.
    for (const asset of assets) {
      if (asset.status.state !== 'ready' || asset.kind === 'image') continue;
      cache.markQueued(asset.id, Boolean(asset.video), Boolean(asset.audio));
    }

    for (const asset of assets) {
      if (asset.status.state !== 'ready') continue;

      // Stills have no frames to walk; the file itself is the thumbnail.
      if (asset.kind === 'image') {
        const file = get().mediaFiles.get(asset.id);
        const size = asset.image?.size;
        if (file && size) cache.setStillPoster(asset.id, URL.createObjectURL(file), size);
        set({ previewVersion: get().previewVersion + 1 });
        continue;
      }

      await cache.ensure(asset.id, asset.video?.duration ?? null, asset.audio?.duration ?? null);
      set({ previewVersion: get().previewVersion + 1 });
      /*
       * Zoom may have changed while the first strip was still decoding. In that
       * case the density request arrived before its starter preview existed. Re-read
       * the current viewport now that the filmstrip and waveform can be upgraded.
       */
      if (asset.video || asset.audio) get().refreshPreviewDensity();
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
  // Record what could not be found on the assets themselves, before the history
  // is seeded. Done here rather than through `run` because it is not an edit:
  // nobody should be able to undo the discovery that a file has gone.
  let project = loaded.project;
  for (const assetId of loaded.missingAssetIds) {
    project = apply(project, { type: 'setAssetStatus', assetId, status: { state: 'missing' } }, ids);
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
    mediaFiles: loaded.media,
    previews: null,
    previewVersion: 0,
    error: null,
    // Nothing has been edited yet, so the indicator must not claim a save that
    // belongs to whatever was open before.
    saveState: 'idle',
    status:
      loaded.missingAssetIds.length > 0
        ? `${verb} "${project.name}" — ${loaded.missingAssetIds.length} file(s) need re-importing.`
        : `${verb} "${project.name}".`,
  });

  const engine = get().engine;
  if (!engine) return;

  await engine.pause();
  engine.setSequence(sequenceId);

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
  clip: NewClipSpec,
): { commands: Command[]; createdTrack: boolean } {
  const sequence = getSequence(project, sequenceId);
  const top = sequence.videoTrackIds[sequence.videoTrackIds.length - 1];
  const range = T.rangeFromBounds(clip.start, T.add(clip.start, clip.duration));

  if (top !== undefined && clipsWithin(project, [top], range).length === 0) {
    return {
      commands: [{ type: 'insertClip', trackId: top, mode: 'overwrite', clip }],
      createdTrack: false,
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
  };
}

export interface PlacementPlan {
  readonly commands: readonly Command[];
  readonly start: Time;
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

  const size = asset.video?.size;
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
): PlacementPlan {
  const sequence = getSequence(project, sequenceId);
  const track = project.tracks[trackId]!;
  const duration = (asset.video?.duration ?? asset.audio?.duration)!;

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
  const start = appendPointFor(project, sequenceId, trackId, usesPartner && !createdTrackName);
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

  const clipFor = (kind: 'video' | 'audio' | 'image'): NewClipSpec => ({
    kind,
    assetId: asset.id,
    start,
    duration,
    name: asset.name,
    // Only the picture needs an id up front, to scale it in the same batch.
    ...(kind === 'audio' ? {} : { clipId: visualClipId }),
    ...(usesPartner ? { linkGroupId } : {}),
  });

  commands.push({
    type: 'insertClip',
    trackId,
    mode: 'overwrite',
    clip: clipFor(track.kind === 'video' ? visualKind : 'audio'),
  });
  if (usesPartner && partnerTrackId) {
    commands.push({
      type: 'insertClip',
      trackId: partnerTrackId,
      mode: 'overwrite',
      clip: clipFor(partnerKind === 'video' ? visualKind : 'audio'),
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
