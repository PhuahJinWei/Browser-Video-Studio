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
import type {
  Asset,
  AssetId,
  Clip,
  ClipId,
  Project,
  SequenceId,
  Time,
  TimeRange,
  TrackId,
  TrackKind,
  TransitionId,
} from '../model/types';
import { Autosaver, deleteMedia, loadMostRecent, saveMedia } from '../storage/projectStore';

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
    videoTrackIds: [ids.track(), ids.track()],
    audioTrackIds: [ids.track(), ids.track()],
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
  /** Rebuild filmstrips at a density suited to the current zoom. Debounced. */
  refreshFilmstripDensity: () => void;

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
}

/**
 * Autosave. Lives outside the store because it is a side-effect owner, not state:
 * every recorded edit schedules a debounced write of the current document.
 */
const autosaver = new Autosaver(800, (error) => {
  useStudio.setState({ error: `Autosave failed: ${error.message}` });
});

/**
 * Write any pending edit immediately.
 *
 * Without this, anything done inside the debounce window is lost when the tab
 * closes. `pagehide` is the reliable signal — `beforeunload` is skipped when a tab
 * is discarded or the page is restored from the back/forward cache.
 */
export function flushAutosave(): void {
  const state = useStudio.getState();
  autosaver.schedule(state.project());
  void autosaver.flush();
}

const initial = starterProject();

/**
 * Long enough that spinning the wheel through several zoom levels costs one
 * rebuild rather than one per level.
 */
const DENSITY_DEBOUNCE_MS = 400;
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
    get().refreshFilmstripDensity();
  },

  /**
   * Ask for filmstrips fine enough for the current zoom.
   *
   * Debounced, because zooming arrives as a stream of events and each rebuild is a
   * decode pass. The wait is deliberately longer than a wheel-spin, so spinning
   * through several zoom levels costs one rebuild at the level you stop on rather
   * than one at each level you pass through.
   */
  refreshFilmstripDensity: () => {
    if (densityTimer !== null) clearTimeout(densityTimer);
    densityTimer = setTimeout(() => {
      densityTimer = null;
      const state = get();
      const cache = state.previews;
      if (!cache) return;

      const project = state.project();
      const zoom = getSequence(project, state.sequenceId).view.zoom;

      // Density is per asset, but speed is per clip, so a slowed clip of an asset
      // asks for more than a full-speed one. Take whichever wants the most.
      const wanted = new Map<AssetId, number>();
      for (const clip of Object.values(project.clips)) {
        // Only decoded video has a strip: stills and generated clips have nothing
        // to walk, and audio has a waveform instead.
        if (clip.kind !== 'video') continue;
        const density = densityForZoom(zoom, clip.speed);
        wanted.set(clip.assetId, Math.max(wanted.get(clip.assetId) ?? 0, density));
      }

      // One asset at a time. Each rebuild is a run of seeks, and firing them all at
      // once would have every asset's decode competing for the same hardware — the
      // strip you are actually looking at finishing last.
      const run = ++densityRun;
      void (async () => {
        for (const [assetId, density] of wanted) {
          // A newer zoom has taken over; its own pass covers what is left.
          if (run !== densityRun) return;
          const asset = project.assets[assetId];
          if (!asset?.video) continue;

          await cache.ensureDensity(assetId, asset.video.duration, density);
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
      for (const [assetId, file] of get().mediaFiles) await engine.openAsset(assetId, file);
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
        await get().engine?.openAsset(assetId, file);
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
    set({
      status: placement.createdTrackName
        ? `Added "${asset.name}" — created ${placement.createdTrackName} for its other stream.`
        : `Added "${asset.name}".`,
    });
    get().engine?.requestRender(placement.start);
  },

  addTitle: (text) => {
    const state = get();
    const sequence = getSequence(state.project(), state.sequenceId);
    const trackId = sequence.videoTrackIds[sequence.videoTrackIds.length - 1];
    if (!trackId) {
      set({ error: 'Add a video track first' });
      return;
    }
    state.run(
      {
        type: 'insertClip',
        trackId,
        mode: 'overwrite',
        clip: {
          kind: 'title',
          start: state.playhead(),
          duration: T.time(3),
          text,
          name: text.slice(0, 24) || 'Title',
        },
      },
      'Add title',
    );
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

  addTransitionNearPlayhead: (transitionType, trackId) => {
    const state = get();
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
    const sequence = getSequence(state.project(), state.sequenceId);
    const trackId = sequence.videoTrackIds[sequence.videoTrackIds.length - 1];
    if (!trackId) {
      set({ error: 'Add a video track first' });
      return;
    }
    state.run(
      {
        type: 'insertClip',
        trackId,
        mode: 'overwrite',
        clip: { kind: 'solid', start: state.playhead(), duration: T.time(3), fill },
      },
      'Add colour',
    );
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
    set({
      status: placement.createdTrackName
        ? `Added "${asset.name}" — created ${placement.createdTrackName} for its ${
            track.kind === 'video' ? 'audio' : 'video'
          }.`
        : `Added "${asset.name}".`,
    });
  },

  moveClipsToNewTrack: (kind, index, moves, coalesceKey) => {
    const trackId = ids.track();
    // One batch: addTrack then the move. Two batches would let undo put the clip
    // back while leaving the track it was dropped into sitting there empty.
    //
    // Passing the drag's own coalesce key folds this into the same undo step as the
    // pointer moves that led here, so the whole gesture comes apart in one go.
    get().runMany(
      [
        { type: 'addTrack', sequenceId: get().sequenceId, kind, index, trackId },
        {
          type: 'moveClips',
          moves: moves.map((move) => ({
            clipId: move.clipId,
            toTrackId: move.toTrackId ?? trackId,
            toStart: move.toStart,
          })),
        },
      ],
      `Move to a new ${kind} track`,
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
      status: placement.createdTrackName
        ? `Added "${asset.name}" on a new ${kind} track — and ${placement.createdTrackName} for its other stream.`
        : `Added "${asset.name}" on a new ${kind} track.`,
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
    }
  },

  /** Reopen the most recently saved project, if there is one. */
  restoreLastProject: async () => {
    try {
      const loaded = await loadMostRecent();
      if (!loaded) return;

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
        selectedAssetIds: [],
        mediaFiles: loaded.media,
        previews: null,
        previewVersion: 0,
        status:
          loaded.missingAssetIds.length > 0
            ? `Reopened "${loaded.project.name}" — ${loaded.missingAssetIds.length} file(s) need re-importing.`
            : `Reopened "${loaded.project.name}".`,
      });

      const engine = get().engine;
      if (engine) {
        engine.setSequence(sequenceId);
        for (const [assetId, file] of loaded.media) await engine.openAsset(assetId, file);
        engine.requestRender(get().playhead());
        void get().buildPreviews();
      }
    } catch (err) {
      set({ error: `Could not reopen the last project: ${err instanceof Error ? err.message : err}` });
    }
  },
}));

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

export interface PlacementPlan {
  readonly commands: readonly Command[];
  readonly start: Time;
  /** Name of a track that had to be created, for the status line. */
  readonly createdTrackName: string | null;
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

  const clipFor = (kind: 'video' | 'audio' | 'image'): NewClipSpec => ({
    kind,
    assetId: asset.id,
    start,
    duration,
    name: asset.name,
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

  return { commands, start, createdTrackName };
}

/** Tracks in display order: video top-down (so V2 is above V1), then audio. */
export function orderedTrackIds(project: Project, sequenceId: SequenceId): readonly TrackId[] {
  const sequence = getSequence(project, sequenceId);
  return [...[...sequence.videoTrackIds].reverse(), ...sequence.audioTrackIds];
}
