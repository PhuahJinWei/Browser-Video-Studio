/**
 * Application store.
 *
 * Holds the undo history, the selection and the engine handle. Every document edit
 * goes through `run` (recorded) or `runTransient` (not recorded) — the distinction
 * matters because the playhead lives in the document, and recording it would put
 * sixty entries a second on the undo stack.
 */

import { create } from 'zustand';
import { Engine, type EngineTelemetry } from '../engine/engine';
import { exportSequence, suggestBitrate, type ExportProgress, type ExportSettings } from '../engine/export';
import { MediaLibrary } from '../engine/media';
import { PreviewCache } from '../engine/previews';
import { apply, type Command } from '../model/commands';
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
import { getSequence, sequenceDuration } from '../model/selectors';
import * as T from '../model/time';
import type { AssetId, ClipId, Project, SequenceId, Time, TrackId } from '../model/types';
import { Autosaver, loadMostRecent, saveMedia } from '../storage/projectStore';

const ids = randomIdSource;

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
  engine: Engine | null;
  /** Source blobs, kept so the engine can reopen assets. */
  mediaFiles: ReadonlyMap<AssetId, File>;
  telemetry: EngineTelemetry | null;
  previews: PreviewCache | null;
  /** Bumped whenever a preview finishes, so the timeline re-renders. */
  previewVersion: number;
  exportProgress: ExportProgress | null;
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

  select: (clipIds: readonly ClipId[]) => void;
  toggleSelect: (clipId: ClipId) => void;

  setPlayhead: (at: Time) => void;
  setZoom: (pixelsPerSecond: number) => void;

  attachEngine: (canvas: HTMLCanvasElement) => Promise<void>;
  importFiles: (files: readonly File[]) => Promise<void>;
  addAssetToTimeline: (assetId: AssetId) => Promise<void>;
  addTitle: (text: string) => void;
  dropAssetOnTrack: (assetId: AssetId, trackId: TrackId, at: Time) => void;
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

export const useStudio = create<StudioState>((set, get) => ({
  history: initHistory(initial.project),
  sequenceId: initial.sequenceId,
  selection: [],
  engine: null,
  mediaFiles: new Map(),
  telemetry: null,
  previews: null,
  previewVersion: 0,
  exportProgress: null,
  status: 'Import media to begin.',
  error: null,
  showTelemetry: true,

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

  select: (clipIds) => set({ selection: clipIds }),
  toggleSelect: (clipId) => {
    const selection = get().selection;
    set({
      selection: selection.includes(clipId)
        ? selection.filter((id) => id !== clipId)
        : [...selection, clipId],
    });
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

  importFiles: async (files) => {
    if (files.length === 0) return;
    set({ status: `Importing ${files.length} file(s)…`, error: null });

    const nextFiles = new Map(get().mediaFiles);
    const commands: Command[] = [];
    const failures: string[] = [];

    for (const file of files) {
      const assetId = ids.asset();
      try {
        const asset = await MediaLibrary.importFile(assetId, file, file.name);
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

  /** Append an asset at the playhead, linking its video and audio parts. */
  addAssetToTimeline: async (assetId) => {
    const state = get();
    const project = state.project();
    const asset = project.assets[assetId];
    if (!asset) return;

    const sequence = getSequence(project, state.sequenceId);
    const start = state.playhead();
    const duration = asset.video?.duration ?? asset.audio?.duration;
    if (!duration || !T.isPositive(duration)) {
      set({ error: `"${asset.name}" has no usable duration` });
      return;
    }

    const linkGroupId = `lg_${assetId}`;
    const commands: Command[] = [];

    if (asset.video) {
      const trackId = sequence.videoTrackIds[0];
      if (trackId) {
        commands.push({
          type: 'insertClip',
          trackId,
          mode: 'overwrite',
          clip: { kind: 'video', assetId, start, duration, name: asset.name, linkGroupId },
        });
      }
    }
    if (asset.audio) {
      const trackId = sequence.audioTrackIds[0];
      if (trackId) {
        commands.push({
          type: 'insertClip',
          trackId,
          mode: 'overwrite',
          clip: { kind: 'audio', assetId, start, duration, name: asset.name, linkGroupId },
        });
      }
    }

    if (commands.length === 0) {
      set({ error: 'No compatible track for this asset' });
      return;
    }
    get().runMany(commands, `Add "${asset.name}"`);
    get().engine?.requestRender(start);
  },

  /** Drop a 3-second title on the topmost video track at the playhead. */
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

  /**
   * Place an asset at an exact track and time — the drop half of dragging from the
   * media bin. Dropping onto a video track brings the asset's audio along on the
   * first audio track, linked, the same as the bin's add action.
   */
  dropAssetOnTrack: (assetId, trackId, at) => {
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

    const sequence = getSequence(project, state.sequenceId);
    const start = T.max(T.TIME_ZERO, at);
    const linkGroupId = `lg_${assetId}_${Date.now()}`;
    const commands: Command[] = [];

    if (track.kind === 'video') {
      if (!asset.video) {
        set({ error: `"${asset.name}" has no video track` });
        return;
      }
      commands.push({
        type: 'insertClip',
        trackId,
        mode: 'overwrite',
        clip: { kind: 'video', assetId, start, duration, name: asset.name, linkGroupId },
      });
      const audioTrackId = sequence.audioTrackIds[0];
      if (asset.audio && audioTrackId) {
        commands.push({
          type: 'insertClip',
          trackId: audioTrackId,
          mode: 'overwrite',
          clip: { kind: 'audio', assetId, start, duration, name: asset.name, linkGroupId },
        });
      }
    } else {
      if (!asset.audio) {
        set({ error: `"${asset.name}" has no audio track` });
        return;
      }
      commands.push({
        type: 'insertClip',
        trackId,
        mode: 'overwrite',
        clip: { kind: 'audio', assetId, start, duration, name: asset.name },
      });
    }

    get().runMany(commands, `Add "${asset.name}"`);
  },

  newProject: () => {
    const { project, sequenceId } = starterProject();
    // Release the old previews' object URLs; nothing references them any more.
    get().previews?.dispose();
    set({
      history: initHistory(project),
      sequenceId,
      selection: [],
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

      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);

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
      cache = new PreviewCache(engine.media);
      set({ previews: cache });
    }

    const assets = Object.values(get().project().assets);
    for (const asset of assets) {
      if (asset.status.state !== 'ready') continue;
      await cache.ensure(asset.id, asset.video?.duration ?? null, asset.audio?.duration ?? null);
      set({ previewVersion: get().previewVersion + 1 });
    }
  },

  /** Reopen the most recently saved project, if there is one. */
  restoreLastProject: async () => {
    try {
      const loaded = await loadMostRecent();
      if (!loaded) return;

      const sequenceId = loaded.project.activeSequenceId;
      get().previews?.dispose();
      set({
        history: initHistory(loaded.project),
        sequenceId,
        selection: [],
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

/** Tracks in display order: video top-down (so V2 is above V1), then audio. */
export function orderedTrackIds(project: Project, sequenceId: SequenceId): readonly TrackId[] {
  const sequence = getSequence(project, sequenceId);
  return [...[...sequence.videoTrackIds].reverse(), ...sequence.audioTrackIds];
}
