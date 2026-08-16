# Browser Video Studio

A non-linear video editor that runs entirely in the browser. No backend, no uploads, no accounts — media never leaves the machine.

Built on **WebCodecs** (hardware decode/encode), **WebGPU** (effects and compositing), **OPFS** (multi-GB local storage) and **AudioWorklet** (sample-accurate audio). Deployed as a static site on GitHub Pages.

> Chromium 121+ only, by design. The app reports what it needs at boot rather than silently half-working.

## Status

Early. The pure model layer is landing first; the editor UI arrives with L1.

| | |
|---|---|
| ✅ | Project data model ([`src/model/types.ts`](src/model/types.ts)) |
| ✅ | Exact rational time arithmetic + SMPTE timecode ([`src/model/time.ts`](src/model/time.ts)) |
| ⬜ | Commands, selectors, undo/redo |
| ⬜ | L1: import, indexing, timeline, playback, export |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and the L1–L5 roadmap, and [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) for the document schema.

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

## Design notes

**Time is exact.** Positions and durations are rational `{num, den}` seconds, never float seconds. 29.97 fps is `30000/1001`; accumulating it as a float drifts, and drift in an NLE means A/V desync. `src/model/time.ts` does all arithmetic on Numbers with `Number.isSafeInteger` guards on every intermediate, falling back to BigInt when a guard trips, and throwing `TimeOverflowError` rather than ever returning a wrong answer.

**The document is separate from the engine.** `Project` is plain immutable JSON edited through pure commands — testable in Node with no browser, no GPU, no media. The engine turns `(document, time)` into pixels and samples. Playback and export share that path, so what you see is what you get.

**Audio is a first-class citizen, not a later feature.** The audio clock is the master clock during playback; mixing happens in a worker with plain DSP (not a WebAudio graph) so playback and export are bit-identical.

**No `SharedArrayBuffer`.** GitHub Pages cannot set the COOP/COEP headers that `SharedArrayBuffer` requires, so nothing in L1–L3 depends on it.

## Licence

Not yet chosen.
