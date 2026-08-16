# Browser Video Studio

A non-linear video editor that runs entirely in the browser. No backend, no uploads, no accounts — media never leaves the machine.

Built on **WebCodecs** (hardware decode/encode), **WebGPU** (effects and compositing), **OPFS** (local project storage) and **Web Audio** (sample-accurate mixing), with [Mediabunny](https://mediabunny.dev) handling containers. Deployed as a static site on GitHub Pages.

> Chromium 121+ only, by design. The app reports what it needs at boot rather than silently half-working.

## What works

Import → edit → play → export, end to end, entirely on your machine.

- **Import** MP4, MOV, MKV, WebM, MP3, WAV, FLAC, OGG — drop files anywhere on the media panel, or use File › Import. Probed for codec, resolution, frame rate and audio layout.
- **Timeline** with any number of video and audio tracks. Drag media in from the bin — the pointer picks the track, and the clip appends after whatever is already on it. Move clips between tracks, trim, split, ripple delete, snap to clip edges and the playhead. Moving a clip onto another stops at its edge rather than resizing it. Linked video/audio move together. Per-track mute, solo, lock, hide.
- **Filmstrips and waveforms** on clips, rasterised once per asset and positioned by CSS, so trimming and moving cost nothing. Clips shimmer while theirs is still being decoded, and the library card shows how far along it is.
- **Drag readout.** Moving, trimming or scrubbing shows a timecode that follows the pointer, reporting the position *after* snapping and after being clamped off a neighbour — so it always agrees with where the clip actually went. A marker line shows what a drag caught.
- **Drop into the gap to make a track.** Drag a clip (or media from the library) above the video stack or below the audio and it lands on a track created for it. The track is only made on release, and it collapses into the same undo step as the move.
- **Fades and transitions on the clips themselves.** A fade button at each outer edge and a transition button on every bare cut, all on one line across the track. Clicking a fade adds or removes it, and a linked pair fades together. Per-clip audio gain sits on the same row; a keyframed gain is left alone rather than flattened.
- **Light and dark themes**, light by default, remembered between sessions. Clip colours, the preview backdrop and the beds behind filmstrips stay constant in both — they are the material being edited, not the furniture around it.
- **A ruler that reads like one**: labelled majors, short minors to count between, and individual frames once the zoom is deep enough to show them. It fills the pane rather than stopping where the sequence happens to end.
- **Logarithmic zoom** in the status bar, so the 20–200 px/s band most editing happens in gets a third of the travel instead of a twentieth.
- **Save the current frame** as a PNG at full sequence resolution (`Shift+S`), read back from the compositor rather than the canvas so it is never a blank or stale frame. The still also joins the library, so it can be dragged straight back onto the timeline as a freeze frame.
- **Hover for detail.** Clips carry no label — the filmstrip or waveform says what they are. Resting on a clip or a library card gives the name, kind, position, length and which part of the source is on screen, the things a one-line label never fitted.
- **Keyboard follows focus.** `Ctrl+A`, `Delete`, `Escape` and `Enter` act on the library when it has focus and on the timeline otherwise, and selecting all in the library means the assets you can actually see rather than every asset in the project.
- **Library** with folders, a search that looks across all of them, multi-select (click, Ctrl, Shift), and grid or list view. Deleting media that is still cut into the timeline says so and offers to take the clips too, rather than silently refusing. Media that could not be found when a project reopened is marked, on the card and on the clip.
- **Preview** composited on the GPU — transform, opacity, crop, eight blend modes, colour adjustment and gaussian blur.
- **Titles** rendered to a canvas and composited like any other layer.
- **Playback** with A/V sync driven by the audio clock. Seeking mid-playback re-bases the transport and keeps rolling.
- **Fullscreen preview**, falling back to an in-page focus mode where the browser disallows fullscreen.
- **Export** to MP4 (H.264 + AAC) or WebM (VP9 + Opus) at any resolution and bitrate.
- **Group and link.** Clicking a clip selects everything linked or grouped with it, so delete and the inspector act on the whole unit; Alt-click isolates one member. Ctrl+G / Ctrl+Shift+G group and ungroup.
- **Undo/redo** where a whole drag collapses into one step.
- **Autosave** to OPFS — reload the page and your project comes back, media included.
- **A live pipeline panel** showing decode, composite and encode timings as they happen.
- **Menu bar** (File / Edit / Clip / Track / View / Help) plus right-click menus, sharing one implementation so both behave the same.

### Not yet built

Transitions, keyframe editing UI (the model supports keyframes; nothing exposes them yet), proxies for 4K, nested sequences, speed ramps, and everything in L4–L5 below.

## Develop

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

`npm run typecheck` type-checks without emitting; `npm run build` produces the static site in `dist/`.

Testing the engine needs real media. `src/dev/testMedia.ts` generates a test-pattern clip in the browser so no binary fixtures are checked in and ffmpeg is not required:

```js
const m = await import('/src/dev/testMedia.ts');
await window.__studio.getState().importFiles([await m.makeTestClip()]);
```

## Design notes

**Time is exact.** Positions and durations are rational `{num, den}` seconds, never float seconds. 29.97 fps is `30000/1001`; accumulating it as a float drifts, and drift in an NLE means A/V desync. All arithmetic runs on Numbers with `Number.isSafeInteger` guards on every intermediate, falling back to BigInt when a guard trips, and throwing rather than ever returning a wrong answer.

**The document is separate from the engine.** `Project` is plain immutable JSON edited through pure commands — testable in Node with no browser, GPU or media. The engine turns `(document, time)` into pixels and sound. Playback and export share that path, so what you see is what you get.

**Audio is a first-class citizen, not a later feature.** The audio clock is the master during playback. Mixing runs in an `OfflineAudioContext`, and playback and export call the same function, so they cannot drift apart.

**Undo is snapshot-based.** With normalised immutable maps a snapshot costs one object plus structural sharing, whereas hand-written inverse commands are a classic source of NLE corruption — undoing a ripple delete has to restore clips, their effect instances *and* their transitions, in order.

**No `SharedArrayBuffer`.** GitHub Pages cannot set the COOP/COEP headers it requires, so nothing depends on it.

**GPU failures are made loud.** A WebGPU pipeline that fails validation reports success at every layer above it and simply draws nothing. Shader compilation info is checked at startup and an `uncapturederror` listener is installed, because the first version of this compositor rendered black for an hour while every timing counter said it was working.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, where the build diverged from it and why, and the L1–L5 roadmap. [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) covers the document schema.

## Roadmap

| | |
|---|---|
| **L1** | ✅ Built — import, timeline, playback, effects, export, autosave |
| **L2** | Transitions, keyframe editor, text styling, multi-select marquee |
| **L3** | Proxies for 4K, nested sequences, speed ramps, audio DSP, WASM codec fallback |
| **L4** | On-device AI: background segmentation, Whisper captions, scene detection, silence removal |
| **L5** | Node-graph effects, GPU scopes, colour management |

## Licence

Not yet chosen.
