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

## Commands

Commands are **plain serialisable data**, applied by a pure function:

```ts
apply(project, command, ids?) => Project       // src/model/commands/
applyAll(project, commands, ids?) => Project   // all-or-nothing batch
```

`apply` never mutates its input and never reads the clock (`modifiedAt` is stamped by the persistence layer). It takes an `IdSource` so that entity creation is deterministic — tests use `sequentialIdSource()`, and a future collaboration layer can record the ids a command consumed so peers replay it identically.

**Undo is snapshot-based, not inverse-command-based.** With normalised immutable maps a snapshot costs one object plus structural sharing, whereas hand-written inverses are a classic source of NLE corruption — undoing a ripple delete has to restore clips, their effect instances *and* their transitions, in order. `commitDraft` reuses the original entity map whenever a command did not touch it, so a `setView` on every playhead tick does not invalidate memoisation keyed on `project.clips`.

### Implemented

| Group | Commands |
|---|---|
| Tracks | `addTrack`, `removeTrack`, `setTrackProps`, `moveTrack` |
| Clips | `insertClip` (overwrite \| insert), `removeClips` (lift \| ripple), `moveClips`, `trimClip` (in/out, ripple), `slipClip`, `splitClips`, `setClipProps` |
| Effects | `addEffect`, `removeEffect`, `moveEffect`, `setEffectParam`, `setEffectEnabled` |
| Assets | `addAsset`, `removeAsset`, `setAssetStatus` |
| Markers | `addMarker`, `removeMarker` |
| View | `setView` |

Semantics worth pinning down:

- **Overwrite** deletes covered clips, trims clips overlapping an edge, and *splits* a clip the new one lands inside. Trimming a head advances `sourceIn` so the picture does not jump.
- **Ripple trim in** keeps the clip where it is and pulls the rest of the track; **ripple trim out** pushes it.
- **Splitting shifts the right-hand half's keyframes** by −delta and gives it *cloned* effect instances, so a parameter's value at any absolute time is unchanged by the split. This is the single easiest thing to get wrong.
- Clips may not start before zero; drags clamp, `insertClip` throws.
- Locked tracks and locked clips reject edits.

### Later

`slideClip`, `joinClips`, `linkClips`/`unlinkClips`, `relinkAsset`, keyframe-level commands (`addKeyframe`, `moveKeyframe`, `removeKeyframe`), transitions (`addTransition`, `setTransition`, `removeTransition`), `setSequenceSettings`.

Broken transitions are pruned automatically after every clip edit, so the transition entity is already safe to introduce.

## Selectors

Pure queries in `src/model/selectors.ts`. The two that matter are:

- **`renderListAt(project, seqId, t)`** → the compositor's input: ordered bottom-to-top layers of `{ clip, sourceTime, transform, opacity, crop, blendMode, effects, trackEffects }`, with hidden tracks, disabled clips and disabled effects already filtered out and all animation evaluated.
- **`audioSegments(project, seqId, range)`** → the mixer's input: `{ clip, timelineRange, sourceStart, speed, effects, trackEffects }` per audible clip, clipped to the range and filtered by mute/solo. Gain, pan and fades stay as *parameters* on the clip so the mixer evaluates them per block rather than per segment.

Supporting: `clipAt`, `clipsInRange`, `gapAt`, `trackClips`, `trackDuration`, `sequenceDuration`, `clipSourceTimeAt`, `clipTrimHandles`, `audibleTrackIds`, `visibleTrackIds`, `snapPoints`, `findSnap`.

Memoisation is deliberately absent for now — these are cheap over an immutable document, and caching before profiling would hide the real costs. `commitDraft`'s map reuse means identity-keyed memos can be dropped in later without touching call sites.

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
