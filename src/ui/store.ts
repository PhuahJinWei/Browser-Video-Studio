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

const ids = randomIdSource;

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
  togglePlay: () => Promise<void>;
  runExport: (settings: ExportSettings) => Promise<void>;
  setStatus: (status: string) => void;
  setError: (error: string | null) => void;
  toggleTelemetry: () => void;
}

const initial = starterProject();

export const useStudio = create<StudioState>((set, get) => ({
  history: initHistory(initial.project),
  sequenceId: initial.sequenceId,
  selection: [],
  engine: null,
  mediaFiles: new Map(),
  telemetry: null,
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
      get().engine?.refresh();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  runMany: (commands, label, coalesceKey) => {
    try {
      let project = get().project();
      for (const command of commands) project = apply(project, command, ids);
      set({
        history: push(get().history, project, {
          label,
          ...(coalesceKey !== undefined ? { coalesceKey } : {}),
        }),
        error: null,
      });
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
    set({ history: undo(get().history), selection: [] });
    get().engine?.refresh();
  },
  redoEdit: () => {
    set({ history: redo(get().history), selection: [] });
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
    get().engine?.requestRender(clamped);
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
