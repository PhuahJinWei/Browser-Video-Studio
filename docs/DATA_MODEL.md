# Data Model

The authoritative definition lives in [`src/model/types.ts`](../src/model/types.ts). This document explains the *why* and the mechanics around it.

## Design principles

1. **Document, not app state.** `Project` describes the edit only. Media bytes, decoders, caches, GPU state are engine concerns keyed by `AssetId`. UI-only state (selection, drag, panel layout) lives outside the document; a small `view` block per sequence is persisted for convenience.
2. **Normalised + immutable.** Entities in `Record<Id, Entity>` maps, referenced by branded ids. Commands return new objects with structural sharing ⇒ cheap undo/redo (keep previous roots), cheap memoised selectors, trivial autosave diffing.
3. **Rational time.** `Time = {num, den}`; no float seconds anywhere in the model. Frame/sample snapping happens in commands, using the sequence's `frameRate` / `sampleRate`.
4. **Everything animatable is a `Param<V>`.** Static now, keyframed later, without a schema change. Keyframe times are relative to the clip start so clips move as a unit.
5. **Registries live in code, params live in data.** Effects/transitions store `effectType` + `params` only. The engine's registry supplies the shader/DSP and the param schema (types, ranges, defaults, UI). Renaming or removing an effect type = a migration.
6. **Additive evolution.** `schemaVersion` + `migrations/`. Fields are never repurposed.

## Entity graph

```
Project
 ├── assets{}          Asset (source + streams + derived + status)
 ├── sequences{}       Sequence (fps, size, sampleRate, colorSpace, track order, view)
 │     ├── videoTrackIds[]  ─┐
 │     ├── audioTrackIds[]  ─┴─► tracks{}  Track (clipIds[] ordered, mute/solo/lock, effects[])
 │     │                                       └─► clips{}   VideoClip | AudioClip | TitleClip
 │     │                                                         ├─ assetId ─► assets{}
 │     │                                                         └─ effects[] ─► effects{}
 │     ├── transitionIds[] ─► transitions{} (fromClipId, toClipId)
 │     └── markerIds[]     ─► markers{}
 └── effects{}         EffectInstance (effectType, params)
```

Nesting: an `Asset` of kind `'sequence'` points at another `Sequence`; a `VideoClip` of kind `'nested'` references that asset. Must remain a DAG.

## Clip time math

```
timeline span:  [clip.start, clip.start + clip.duration)
source span:    [clip.sourceIn, clip.sourceIn + clip.duration * clip.speed)
source time at timeline t:  sourceIn + (t - clip.start) * speed
```
- `speed < 0` = reverse. `speed` becomes a `Param<number>` in L3 (speed ramps); then source time = sourceIn + ∫speed dt, evaluated by a selector with a cached integral table.
- Trim-in changes `start`, `duration`, `sourceIn` together; trim-out changes `duration` only. Slip changes `sourceIn` only. Slide changes `start` and neighbours.
- **Handles**: how far a clip can be extended = source stream duration bounds; transitions consume handles.

## Commands (all pure `(project, args) => { next, inverse }`)

L1 command set:
- `importAsset`, `updateAssetStatus`, `removeAsset`, `relinkAsset`
- `addTrack`, `removeTrack`, `reorderTracks`, `setTrackFlags`
- `insertClip` (overwrite | insert/ripple), `removeClips` (lift | ripple)
- `moveClips` (with linked-clip and snap resolution), `trimClip` (in/out, ripple option), `slipClip`, `slideClip`
- `splitClips(at)`, `joinClips`
- `setClipProps` (enabled, name, color, opacity/transform static), `linkClips`, `unlinkClips`
- `addEffect`, `removeEffect`, `reorderEffects`, `setParam`, `addKeyframe`, `moveKeyframe`, `removeKeyframe`
- `addTransition`, `setTransition`, `removeTransition`
- `addMarker`, `setMarker`, `removeMarker`
- `setSequenceSettings`, `setView`

Commands validate invariants (in dev builds, full validation after every command; in prod, targeted).

## Selectors (memoised on object identity)

- `trackClipsSorted(trackId)`, `clipAt(trackId, t)`, `clipsInRange(seqId, range)`
- `renderListAt(seqId, t)` → ordered layers `{ clip, sourceTime, evaluatedParams, transform, opacity, blend, transitionBlendWith? }` — the compositor's input.
- `audioSegments(seqId, range)` → per audio track, list of `{ clip, sourceRange, gainCurve, panCurve }` — the mixer's input.
- `evalParam(param, tRelative)` — keyframe interpolation.
- `sequenceDuration(seqId)`, `snapPoints(seqId)` (clip edges, markers, playhead).

## Persistence

- `projects/<projectId>/project.json` in OPFS, debounced autosave (500 ms) + rotating snapshots (`history/<ts>.json`, keep last N).
- `IndexedDB`: project index (id, name, modifiedAt, thumbnail), `FileSystemFileHandle`s keyed by assetId, user prefs.
- Portable export `.bvsproj` = zip { `project.json`, optional `media/` }.

## Deliberate omissions (for now) and where they'd go

| Later feature | Where it slots in |
|---|---|
| Speed ramps | `MediaClipFields.speed: Param<number>` |
| Multi-channel audio buses / sends | `Track.busId`, new `Bus` entity in `Project` |
| Adjustment layers | `VideoClip.kind = 'adjustment'`, no assetId |
| Masks / rotoscoping | `EffectInstance.mask?: MaskRef` + `masks{}` map |
| Node graph effects | new `EffectInstance.effectType = 'graph'`, params contain graph JSON |
| Colour management | `Sequence.colorSpace` already exists; add per-clip `inputColorSpaceOverride` |
| Captions | `TitleClip` today; later `CaptionTrack` with cue list |
| Collaboration | commands are already serialisable ops ⇒ CRDT/OT layer on top |
