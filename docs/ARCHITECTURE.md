# Browser Video Studio — Architecture

Status: **v0.2 — L1 built and running.** Target: Chromium-latest only. Hosting: GitHub Pages (static, no backend, no custom headers).

> ## Where the build diverged from this design
>
> This document was written before implementation. Three decisions changed once the code met the browser, and the reasons are worth keeping:
>
> 1. **Mediabunny replaces mp4box.js + mp4-muxer + webm-muxer.** It covers demux, seek-accurate decode, mux and encode across MP4/MOV/MKV/WebM/MP3/WAV/FLAC/OGG behind one API. `VideoSampleSink.getSample(t)` does keyframe-seek-and-decode-forward internally, which deletes the entire hand-rolled sample-index and decoder-session plan in §5.1–5.2. §11's `workers/indexer/` never needed to exist.
> 2. **Audio mixes in an `OfflineAudioContext`, not a hand-written mixer feeding an AudioWorklet.** §6 argued for hand-rolled DSP so playback and export would be identical. Offline rendering achieves the same thing — playback and export call one function, `renderAudioRange` — while getting correct resampling and sample-accurate scheduling for free. A worklet is only needed if effects must run *in* the audio thread, which nothing in L1–L3 requires.
> 3. **The engine runs on the main thread, not in workers.** Decode and encode are already off-thread inside WebCodecs, and GPU work is on the GPU. The worker split in §3 remains the right destination for L3+ (proxy generation and AI inference genuinely need it), but it bought nothing in L1 and would have made the first working version much slower to reach. The document/engine boundary is intact, so moving the engine behind a worker RPC later does not touch the UI.
>
> What survived contact unchanged: rational time, the immutable document + pure commands, snapshot undo, the effect registry, audio as a first-class citizen from day one, and the "no `SharedArrayBuffer`" rule.
>
> Four defects reached a running browser that types and tests could not catch — a WGSL uniform-control-flow violation that rendered black, a frame-rate snap tolerance too loose to tell 29.97 from 30, `requestAnimationFrame` starving the transport clock, and two `GPUDevice`s racing over one canvas. All four are recorded in the git history. The lesson, made permanent in the code: **the compositor now checks shader compilation info at startup and listens for `uncapturederror`**, because a GPU pipeline that fails validation reports success at every layer above it.

## 1. Goals & non-goals

**Goals**
- A real NLE (non-linear editor) that runs 100% client-side: multi-track video + audio, frame-accurate trim/split/move, GPU effects, sample-accurate audio, export to MP4/WebM.
- *No ceilings*: the data model and engine must not require a rewrite to add keyframes, nesting, AI effects, colour management, or plugins later.
- Ships in layers (L1..L5, see §9). Every layer is a usable product.
- Observable: the pipeline exposes live telemetry ("show me what the browser is doing").

**Non-goals (for now)**
- Cross-browser support (Firefox/Safari). Feature-detect and show a clear message.
- Collaboration / cloud projects / accounts.
- Codecs the OS can't decode natively (ProRes, DNx…) — flagged as unsupported until an optional WASM fallback exists (L3+).
- HDR / wide-gamut correctness before L5 (but the model carries `colorSpace` from day one).

## 2. Platform stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | Whole codebase; engine + UI share types |
| Bundler / dev | Vite | Worker bundling, WASM, fast HMR, static output for Pages |
| UI | React + Zustand (or equivalent) | Mainstream; UI is a thin editor over the document, engine is framework-agnostic |
| Decode/Encode | **WebCodecs** (`VideoDecoder`, `VideoEncoder`, `AudioDecoder`, `AudioEncoder`) | Hardware codecs, frame-level access |
| Demux | mp4box.js (MP4/MOV), webm/matroska demuxer (jswebm or own EBML reader) | WebCodecs takes chunks, not files |
| Mux | mp4-muxer, webm-muxer | Same reason, output side |
| GPU | **WebGPU** (WGSL compute + render) | Colour conversion, effects, compositing, scopes |
| Audio playback | **AudioWorklet** ring-buffer sink | Sample-accurate, off main thread |
| Storage | **OPFS** (`createSyncAccessHandle` in workers) + IndexedDB (small metadata) | Multi-GB proxies/caches, fast sync IO |
| Parallelism | Dedicated Workers + transferables (`VideoFrame`, `AudioData`, `ArrayBuffer`) | No `SharedArrayBuffer` required ⇒ works on GitHub Pages without COOP/COEP |
| Optional | `coi-serviceworker` to enable SAB later for multithreaded ffmpeg.wasm | Only if/when we need exotic codec fallback |
| AI | ONNX Runtime Web (WebGPU EP) / Transformers.js | Segmentation, Whisper captions (L4). Models fetched from CDN and cached in Cache Storage/OPFS |

**Hard rule:** nothing in L1–L3 may depend on `SharedArrayBuffer`.

## 3. Top-level shape

```
┌──────────────────────────────────────────────────────────────────┐
│ UI (main thread, React)                                          │
│  Timeline · Preview canvas · Media bin · Inspector · Export UI   │
│  Telemetry panel                                                 │
│        │ commands (edit document)          ▲ frames / meters     │
├────────▼───────────────────────────────────┴─────────────────────┤
│ Document layer (main thread, pure TS)                            │
│  Project document (immutable) · Commands · Undo/redo · Autosave  │
│  Selectors (clip-at-time, track flattening, effect stacks)       │
├──────────────────────────────────────────────────────────────────┤
│ Engine API (main thread facade)  → talks to workers via RPC      │
│  requestFrame(t) · play(t0) · pause · seek · export(range,cfg)   │
├──────────────────────────────────────────────────────────────────┤
│ Workers                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────┐ ┌───────────┐  │
│  │ MediaIndexer │ │ VideoWorker* │ │ AudioWorker│ │ Exporter  │  │
│  │ demux, index,│ │ demux+decode │ │ decode+mix │ │ orchestr. │  │
│  │ proxy, thumbs│ │ per source   │ │ → Worklet  │ │ + encode  │  │
│  └──────────────┘ └──────────────┘ └────────────┘ └───────────┘  │
│        ┌──────────────────────────┐   ┌──────────────────────┐   │
│        │ Compositor (WebGPU)      │   │ AI Worker (ONNX)     │   │
│        │ effects → composite →    │   │ segmentation, etc.   │   │
│        │ canvas / VideoFrame out  │   └──────────────────────┘   │
│        └──────────────────────────┘                              │
├──────────────────────────────────────────────────────────────────┤
│ Storage: OPFS (media cache, proxies, waveforms, thumbs, model    │
│ cache) · IndexedDB (project list, prefs)                         │
└──────────────────────────────────────────────────────────────────┘
```

Two independent halves:

- **Document** = *what* the edit is. Pure data. No media, no GPU. Testable in Node.
- **Engine** = turns (document, time) → pixels+samples, and (document, range) → file.

The UI never touches media directly; it dispatches commands to the document and asks the engine for frames.

## 4. Time

- All timeline positions/durations are **rational `Time = { num: number, den: number }`**, normalised, with helpers (`add`, `sub`, `cmp`, `toSeconds`, `toFrames(fps)`, `toSamples(rate)`). Never floats-of-seconds. Numbers stay well within 2^53 for any sane project. (Alternative considered: fixed integer ticks — rejected because no single tick rate divides 29.97 fps, 24 fps, 48 kHz and 44.1 kHz cleanly; rationals are exact for all of them.)
- Sequence has a **frame rate** (rational, e.g. 30000/1001) and an **audio sample rate** (int, 48000). Video is snapped to frame boundaries; audio positions are snapped to sample boundaries. Clip in/out points are stored in *source* time (rational), independent of sequence rate.
- **The audio clock is the master clock during playback.** Video frames are presented against `AudioContext.currentTime`-derived timeline position. Never the reverse.
- Source media may be VFR; the indexer records exact per-sample timestamps from the container so we never assume constant frame duration.

## 5. Media pipeline (video)

### 5.1 Import
1. User picks a file (`showOpenFilePicker` / drag-drop). We keep a `FileSystemFileHandle` (persistable in IndexedDB) and *also* copy the file into OPFS (`media/<assetId>/original`) so projects survive the user moving files. (Configurable: reference-only for huge files.)
2. **MediaIndexer worker** demuxes: tracks, codec strings, `avcC/hvcC` descriptions, per-sample `{pts, dts, duration, isKey, byteOffset, size}` table → stored as a compact binary index in OPFS.
3. Generates in background: **thumbnails** (sprite strips per N seconds), **waveform peaks** (multi-resolution min/max per channel), and — for sources above a threshold (e.g. > 1080p or non-HW-decodable) — a **proxy** (low-res H.264/AV1 re-encode via WebCodecs) also in OPFS.
4. Emits `Asset` (see data model) with `status: 'indexing' | 'ready' | 'error'` and progress; UI shows it in the media bin immediately.

### 5.2 Decode (per source)
- One `VideoDecoderSession` per (asset, quality) in a worker. Random seek = find previous keyframe in index → feed chunks from there → discard frames until target pts. Keeps a small **LRU frame cache** (closed on evict) and a **look-ahead** window during playback.
- Frames leave the worker as transferred `VideoFrame`s to the Compositor worker (or, ideally, decode happens *in* the compositor worker to avoid transfers — decision: **VideoWorker == Compositor worker per sequence**; multiple sources decode in the same worker with separate decoders. Split out only if profiling says so).

### 5.3 Compose (WebGPU)
For a requested sequence time `t`:
1. Document selectors give the **render list**: for each visible video track (bottom→top), the clip covering `t`, its source time, its effect stack (with keyframe-evaluated params), its transform, opacity, blend mode.
2. For each layer: `importExternalTexture(videoFrame)` → convert to linear working RGBA float16 texture (colour matrix per source colour space) → run effect passes (each effect = WGSL compute or fragment pass, ping-pong textures) → composite onto the sequence canvas with transform/blend.
3. Output: to an `OffscreenCanvas` (preview) or read back into a `VideoFrame` (export). Scopes (L5) run as extra compute passes on the composite.

Effects are a **registry**: `{ id, params schema, wgsl, uniforms layout }`. New effect = new entry. AI effects (L4) are effects whose pass reads an extra mask texture supplied by the AI worker.

### 5.4 Playback loop
- `Transport` in the engine drives everything: audio worklet is primed with mixed samples ahead of the play head; on each `requestAnimationFrame` the main thread reads the audio clock, computes timeline time, and asks the compositor for the frame for that time (worker keeps decoders warm and pre-decodes ahead based on play direction/speed). Dropped frames are counted (telemetry).

## 6. Media pipeline (audio)

- **AudioWorker**: `AudioDecoder` per source → `AudioData` → converted to float32 planar at **sequence sample rate** (resampled if needed — simple polyphase; quality passes later).
- **Mixer** (in AudioWorker): for a range `[t0, t1)` produce interleaved f32 mix: sum over audio tracks → clips → (gain, pan, fades, keyframed) → track gain → master. Track/clip mute/solo respected. Optional per-clip effect chain (L3: EQ, compressor — implemented as pure DSP in the worker, not WebAudio nodes, so playback == export bit-for-bit).
- **Playback**: mixer pushes blocks into an `AudioWorkletProcessor` via `MessagePort` (ring buffer in the worklet, no SAB). Worklet reports its playhead sample count back → this is the master clock.
- **Export**: same mixer produces the whole range offline → `AudioEncoder` (AAC/Opus) → muxer.

## 7. Export

`Exporter` worker orchestrates:
```
for each frame time in range:      Compositor.render(t) → VideoFrame → VideoEncoder
concurrently:                       Mixer.render(range)  → AudioEncoder
both:                               → Muxer (mp4-muxer / webm-muxer) → OPFS temp → download / File System Access save
```
- Encoder queue backpressure (`encodeQueueSize`) drives render pacing.
- Codec matrix: H.264 + AAC (MP4, default), VP9/AV1 + Opus (WebM), HEVC/AV1 in MP4 where `VideoEncoder.isConfigSupported` says yes.
- Presets: match sequence, 1080p, 4K, "web small". Bitrate/CRF-ish via `bitrateMode` where available.
- Export emits per-stage progress (decode/composite/encode/mux) + fps + memory estimate → telemetry panel.

## 8. Document layer

- **Immutable `Project` object** (§ data model). Edits go through **Commands** (`trimClip`, `splitClip`, `moveClip`, `rippleDelete`, `setParam`, `addKeyframe`…). Each command produces a new document + an inverse for undo. Commands are pure functions ⇒ unit-testable, and replayable.
- **Selectors** (memoised): `clipsAt(track, t)`, `renderListAt(t)`, `audioSegments(range)`, `evaluateParams(effect, t)`.
- **Persistence**: autosave the document JSON to OPFS `projects/<id>/project.json` (debounced) + snapshot history; project list in IndexedDB. Export/import `.bvsproj` (zip: project.json + optional media).
- **Versioning**: `schemaVersion` on the document; migrations directory. Non-negotiable from v1.

## 9. Delivery layers

| Layer | Scope |
|---|---|
| **L1 — built** | Import (mp4/mov/webm/mkv/mp3/wav/flac/ogg), timeline with N video + N audio tracks, trim/split/move/ripple, snapping, playback with A/V sync, transform/opacity/crop/blend, titles, GPU colour + blur effects, export H.264+AAC / VP9+Opus, undo/redo with gesture coalescing, OPFS autosave, live pipeline telemetry. clip filmstrips and waveforms. |
| L2 | Effect registry + GPU effects (color, blur, sharpen, LUT, crop, transform), transitions (cross-dissolve, wipes), keyframes + curves, audio gain/pan/fades, text/titles (canvas → texture), export presets |
| L3 | Proxies + quality toggle, nested sequences, speed/retime, audio DSP (EQ, compressor, ducking), markers, larger-format import (WASM demux/decode fallback opt-in via coi-serviceworker) |
| L4 | On-device AI: person segmentation (bg blur/remove), Whisper captions, scene cut detection, silence removal, auto-reframe |
| L5 | Node-graph effect editor, GPU scopes (waveform/vectorscope/histogram), colour management (709/2020/HLG/PQ), plugin shaders |

## 10. Cross-cutting rules

1. **Frame ownership**: every `VideoFrame`/`AudioData` has exactly one owner; the owner closes it. Use `using`/`try-finally` and a `FramePool` with leak counters exposed in telemetry.
2. **Workers own the heavy objects.** Main thread never holds decoders, encoders, or GPU device for media (UI-only WebGPU allowed for scopes).
3. **RPC**: a tiny typed `postMessage` RPC (`comlink`-style) with cancellation tokens; every long op is cancellable (seek storms, export abort).
4. **Determinism**: playback and export must produce the same pixels/samples for the same document and time. No WebAudio graph for mixing, no `<video>` element for decode.
5. **Feature detection at boot**: WebGPU, WebCodecs configs, OPFS, AudioWorklet. Show a capability report, don't half-work.
6. **Memory budget**: configurable (default ~1.5 GB); frame caches and proxies respect it; telemetry shows usage.
7. **Everything observable**: engine emits `TelemetryEvent`s (stage, fps, queue depths, GPU timings via timestamp queries where available, memory estimates).

## 11. Repository layout (as built)

```
/                        Vite app root
  src/
    model/               the document — pure, no browser APIs, runs in Node
      types.ts           data model + invariants
      time.ts            exact rational time + SMPTE timecode
      params.ts          keyframe evaluation
      selectors.ts       renderListAt, audioSegments, snapping
      commands/          types, internal (draft + timeline surgery), handlers, index
      history.ts         snapshot undo with gesture coalescing
      validate.ts        invariants, executable
      factories.ts, ids.ts, fixtures.ts
    engine/              (document, time) -> pixels and sound
      media.ts           Mediabunny wrapper keyed by AssetId
      compositor.ts      WebGPU; compositor.wgsl.ts holds the shaders
      audio.ts           OfflineAudioContext mixing + playback scheduling
      effects.ts         registry: params, UI schema, compositor uniforms
      titles.ts          text -> canvas, cached by visual content
      engine.ts          facade: render coalescing, transport
      export.ts          frame walk -> encode -> mux
    storage/             opfs.ts, projectStore.ts (autosave + media copies)
    ui/                  React: App, Timeline, Preview, MediaBin, Inspector, ExportDialog, store
    dev/testMedia.ts     synthetic clips for testing; never imported by the app
    capabilities.ts      boot-time feature detection
  docs/                  ARCHITECTURE.md, DATA_MODEL.md
```

Model tests run in Node under Vitest. The engine is verified in a real Chromium against clips generated by `dev/testMedia.ts` — WebGPU and WebCodecs cannot be meaningfully faked, and every engine bug found so far was invisible to types and unit tests.

## 12. Open decisions (tracked as ADRs)

- ADR-001 Time representation: rational `{num,den}` (chosen) vs integer ticks.
- ADR-002 Decode inside compositor worker vs separate workers (start: same worker).
- ADR-003 UI framework (React default; engine must stay agnostic).
- ADR-004 Copy media into OPFS by default vs reference-only (start: copy ≤ 2 GB, reference above, user-overridable).
- ADR-005 When to introduce coi-serviceworker (not before L3).
