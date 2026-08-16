/**
 * Browser Video Studio — Project data model (source of truth).
 *
 * Rules:
 *  - Plain JSON-serialisable data. No classes, no Dates, no Maps, no functions.
 *  - Immutable at runtime: commands produce new objects (structural sharing).
 *  - Entities are stored normalised in Record<Id, Entity> maps and referenced by Id.
 *  - Times are rational (never float seconds). See `Time`.
 *  - Additive evolution: bump SCHEMA_VERSION and add a migration; never repurpose a field.
 */

export const SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Opaque string ids (nanoid/uuid). Branded to avoid mixing them up. */
export type Id<T extends string> = string & { readonly __brand: T };
export type ProjectId = Id<'project'>;
export type AssetId = Id<'asset'>;
export type SequenceId = Id<'sequence'>;
export type TrackId = Id<'track'>;
export type ClipId = Id<'clip'>;
export type EffectInstanceId = Id<'effect'>;
export type TransitionId = Id<'transition'>;
export type MarkerId = Id<'marker'>;

/**
 * Exact rational time in seconds: num/den. Always normalised (den > 0, gcd == 1).
 * A duration and a position share this type; context decides.
 */
export interface Time {
  readonly num: number;
  readonly den: number;
}

/** Rational frame rate, e.g. { num: 30000, den: 1001 } for 29.97. */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

/** Half-open range [start, start+duration) on the sequence timeline. */
export interface TimeRange {
  readonly start: Time;
  readonly duration: Time;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * 2D transform applied to a layer, in sequence pixels / degrees.
 * Anchor is normalised [0..1] relative to the layer's own bounds.
 * This is the *evaluated* form produced by selectors; the document stores
 * `AnimatableTransform2D`.
 */
export interface Transform2D {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number; // degrees
  readonly anchorX: number;
  readonly anchorY: number;
}

/** Document form of a transform: every channel independently keyframeable. */
export interface AnimatableTransform2D {
  readonly x: Param<number>;
  readonly y: Param<number>;
  readonly scaleX: Param<number>;
  readonly scaleY: Param<number>;
  readonly rotation: Param<number>;
  readonly anchorX: Param<number>;
  readonly anchorY: Param<number>;
}

/** Normalised [0..1] insets from each edge. Evaluated form. */
export interface Crop {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Document form of a crop. */
export interface AnimatableCrop {
  readonly left: Param<number>;
  readonly top: Param<number>;
  readonly right: Param<number>;
  readonly bottom: Param<number>;
}

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'darken' | 'lighten' | 'difference';

/** Colour description carried from day one; only 'bt709' is *interpreted* before L5. */
export interface ColorSpace {
  readonly primaries: 'bt709' | 'bt2020' | 'p3' | 'srgb' | 'unknown';
  readonly transfer: 'bt709' | 'srgb' | 'linear' | 'pq' | 'hlg' | 'unknown';
  readonly matrix: 'bt709' | 'bt2020-ncl' | 'bt601' | 'rgb' | 'unknown';
  readonly fullRange: boolean;
}

// ---------------------------------------------------------------------------
// Animatable parameters
// ---------------------------------------------------------------------------

export type Interpolation = 'hold' | 'linear' | 'bezier';

export interface Keyframe<V = number> {
  /** Time relative to the *clip start* on the timeline (so moving a clip moves its keyframes). */
  readonly at: Time;
  readonly value: V;
  readonly interp: Interpolation;
  /** Bezier handles (only when interp === 'bezier'); normalised (0..1, 0..1) like CSS easing. */
  readonly ease?: readonly [number, number, number, number];
}

/** A parameter is either a static value or a keyframe track. Vectors keyframe as tuples. */
export type Param<V = number> =
  | { readonly kind: 'static'; readonly value: V }
  | { readonly kind: 'keyframed'; readonly keyframes: readonly Keyframe<V>[] };

export type ParamValue = number | boolean | string | readonly number[]; // e.g. [r,g,b,a]
export type ParamMap = Readonly<Record<string, Param<ParamValue>>>;

// ---------------------------------------------------------------------------
// Assets (imported media)
// ---------------------------------------------------------------------------

export type AssetKind = 'video' | 'audio' | 'image' | 'sequence' /* nested */;

export interface AssetVideoStream {
  readonly codec: string;            // WebCodecs codec string, e.g. 'avc1.64001f'
  readonly size: Size;               // coded/display size
  readonly frameRate: FrameRate | null; // null => VFR / unknown; indexer holds exact pts table
  readonly duration: Time;
  readonly colorSpace: ColorSpace;
  readonly rotation: 0 | 90 | 180 | 270; // container rotation metadata
  readonly hwDecodable: boolean;     // result of VideoDecoder.isConfigSupported at import
}

export interface AssetAudioStream {
  readonly codec: string;            // e.g. 'mp4a.40.2', 'opus'
  readonly sampleRate: number;
  readonly channels: number;
  readonly duration: Time;
}

export type AssetStatus =
  | { readonly state: 'importing'; readonly progress: number }
  | { readonly state: 'indexing'; readonly progress: number }
  | { readonly state: 'ready' }
  | { readonly state: 'missing' }   // source not found & no OPFS copy
  | { readonly state: 'error'; readonly message: string };

/**
 * Where the bytes live. We prefer an OPFS copy; a FileSystemFileHandle (persisted in
 * IndexedDB, keyed by assetId) is kept as origin/reference for large files.
 */
export interface AssetSource {
  readonly fileName: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly opfsPath: string | null;    // 'media/<assetId>/original' when copied
  readonly hasFileHandle: boolean;     // handle stored out-of-band in IDB
  readonly contentHash: string | null; // for de-dup / relink (sha-256 of first+last N MB + length)
}

/** Derived data produced by the indexer, all living in OPFS under media/<assetId>/. */
export interface AssetDerived {
  readonly indexPath: string | null;     // binary sample index (pts/dts/key/offset/size)
  readonly thumbsPath: string | null;    // sprite strips + json
  readonly waveformPath: string | null;  // multi-res peaks
  readonly proxyPath: string | null;     // low-res re-encode
  readonly proxySize: Size | null;
}

export interface Asset {
  readonly id: AssetId;
  readonly kind: AssetKind;
  readonly name: string;
  readonly createdAt: number;             // epoch ms (metadata only; never used for timeline math)
  readonly source: AssetSource | null;    // null for kind === 'sequence'
  readonly video: AssetVideoStream | null;
  readonly audio: AssetAudioStream | null;
  readonly image: { readonly size: Size } | null;
  readonly nestedSequenceId: SequenceId | null; // kind === 'sequence'
  readonly derived: AssetDerived;
  readonly status: AssetStatus;
  readonly folder: string;                // media-bin folder path, e.g. 'B-roll/Day 1'
}

// ---------------------------------------------------------------------------
// Effects & transitions
// ---------------------------------------------------------------------------

/**
 * An effect *instance* on a clip/track. `effectType` keys into the effect registry
 * (engine-side: WGSL/DSP + param schema). The document only stores params.
 */
export interface EffectInstance {
  readonly id: EffectInstanceId;
  readonly effectType: string;   // e.g. 'color.basic', 'blur.gaussian', 'audio.gain', 'ai.bg-blur'
  readonly enabled: boolean;
  readonly params: ParamMap;
}

export interface Transition {
  readonly id: TransitionId;
  readonly transitionType: string; // e.g. 'dissolve', 'wipe.left'
  readonly trackId: TrackId;
  /** Transition sits across the cut between these two adjacent clips on the same track. */
  readonly fromClipId: ClipId;
  readonly toClipId: ClipId;
  readonly duration: Time;
  readonly alignment: 'centered' | 'start' | 'end';
  readonly params: ParamMap;
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export type ClipKind = 'video' | 'audio' | 'image' | 'title' | 'nested' | 'gap' /* reserved */;

/**
 * A clip is a placement of a slice of a source on a track.
 *
 *   timeline: [start, start + duration)
 *   source:   [sourceIn, sourceIn + duration * speed)   (in source time)
 *
 * `duration` is timeline duration. Source span is derived; keep the model minimal.
 * Reverse playback: speed < 0 (source span goes backwards from sourceIn).
 */
export interface ClipBase {
  readonly id: ClipId;
  readonly kind: ClipKind;
  readonly trackId: TrackId;
  readonly name: string;
  readonly start: Time;
  readonly duration: Time;
  readonly enabled: boolean;      // disabled = invisible/silent but kept
  readonly locked: boolean;
  readonly color: string | null;  // label colour
  readonly effects: readonly EffectInstanceId[]; // ordered stack, applied bottom→top
  /** Linked clips move/trim together (e.g. a video clip and its own audio). */
  readonly linkGroupId: string | null;
}

export interface MediaClipFields {
  readonly assetId: AssetId;
  readonly sourceIn: Time;        // in source timebase
  readonly speed: number;         // 1 = normal; L3 speed ramps become Param<number>
}

export interface VideoClip extends ClipBase, MediaClipFields {
  readonly kind: 'video' | 'image' | 'nested';
  readonly transform: AnimatableTransform2D;
  readonly opacity: Param<number>;
  readonly blendMode: BlendMode;
  readonly crop: AnimatableCrop;
  /** Which stream of the asset (multi-stream containers). 0 default. */
  readonly streamIndex: number;
}

export interface AudioClip extends ClipBase, MediaClipFields {
  readonly kind: 'audio';
  readonly gainDb: Param<number>;   // 0 = unity
  readonly pan: Param<number>;      // -1..1
  readonly fadeIn: Time;
  readonly fadeOut: Time;
  readonly channelMap: 'stereo' | 'left' | 'right' | 'mono-sum';
  readonly streamIndex: number;
}

/** Title/text clip rendered by the engine to a texture. Rich text model kept simple for L2. */
export interface TitleClip extends ClipBase {
  readonly kind: 'title';
  readonly text: string;
  readonly style: {
    readonly fontFamily: string;
    readonly fontSizePx: number;
    readonly fontWeight: number;
    readonly color: string;         // css colour
    readonly align: 'left' | 'center' | 'right';
    readonly background: string | null;
  };
  readonly transform: AnimatableTransform2D;
  readonly opacity: Param<number>;
}

export type Clip = VideoClip | AudioClip | TitleClip;

// ---------------------------------------------------------------------------
// Tracks & sequences
// ---------------------------------------------------------------------------

export type TrackKind = 'video' | 'audio';

export interface Track {
  readonly id: TrackId;
  readonly kind: TrackKind;
  readonly name: string;
  readonly clipIds: readonly ClipId[]; // ordered by start; non-overlapping (invariant enforced by commands)
  readonly muted: boolean;
  readonly solo: boolean;
  readonly locked: boolean;
  readonly hidden: boolean;            // video only: exclude from render
  readonly height: number;             // UI hint (px)
  /** Track-level effects (audio: EQ/comp; video: adjustment layer semantics). */
  readonly effects: readonly EffectInstanceId[];
  readonly gainDb: Param<number>;      // audio tracks
  readonly pan: Param<number>;         // audio tracks
}

export interface Marker {
  readonly id: MarkerId;
  readonly at: Time;
  readonly duration: Time;             // 0 for point markers
  readonly name: string;
  readonly color: string;
  readonly kind: 'comment' | 'chapter' | 'todo';
}

export interface Sequence {
  readonly id: SequenceId;
  readonly name: string;
  readonly frameRate: FrameRate;
  readonly size: Size;                 // canvas size in px
  readonly sampleRate: number;         // 48000
  readonly channels: 2;                // stereo for now; model allows widening
  readonly colorSpace: ColorSpace;     // working/output space; bt709 until L5
  /** Bottom→top for video (index 0 = bottom layer). Audio order is just UI order. */
  readonly videoTrackIds: readonly TrackId[];
  readonly audioTrackIds: readonly TrackId[];
  readonly transitionIds: readonly TransitionId[];
  readonly markerIds: readonly MarkerId[];
  readonly masterGainDb: Param<number>;
  /** UI/session state that is worth persisting but not part of the edit. */
  readonly view: {
    readonly playhead: Time;
    readonly zoom: number;             // px per second
    readonly scrollX: Time;
    readonly inPoint: Time | null;
    readonly outPoint: Time | null;
  };
}

// ---------------------------------------------------------------------------
// Project root
// ---------------------------------------------------------------------------

export interface Project {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly id: ProjectId;
  readonly name: string;
  readonly createdAt: number;
  readonly modifiedAt: number;

  readonly assets: Readonly<Record<AssetId, Asset>>;
  readonly sequences: Readonly<Record<SequenceId, Sequence>>;
  readonly tracks: Readonly<Record<TrackId, Track>>;
  readonly clips: Readonly<Record<ClipId, Clip>>;
  readonly effects: Readonly<Record<EffectInstanceId, EffectInstance>>;
  readonly transitions: Readonly<Record<TransitionId, Transition>>;
  readonly markers: Readonly<Record<MarkerId, Marker>>;

  readonly activeSequenceId: SequenceId;

  readonly settings: {
    readonly proxyMode: 'auto' | 'always' | 'never';
    readonly memoryBudgetBytes: number;
    readonly copyMediaToOpfsUpToBytes: number;
  };
}

// ---------------------------------------------------------------------------
// Export configuration (not part of Project; passed to the engine)
// ---------------------------------------------------------------------------

export interface ExportConfig {
  readonly sequenceId: SequenceId;
  readonly range: TimeRange | null;    // null = whole sequence
  readonly container: 'mp4' | 'webm';
  readonly video: {
    readonly codec: string;            // e.g. 'avc1.640028', 'vp09.00.10.08', 'av01.0.08M.08', 'hvc1.1.6.L120.B0'
    readonly size: Size;
    readonly frameRate: FrameRate;
    readonly bitrate: number;          // bps target
    readonly bitrateMode: 'constant' | 'variable' | 'quantizer';
    readonly hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software';
    readonly latencyMode: 'quality' | 'realtime';
    readonly keyFrameIntervalFrames: number;
  } | null;                            // null = audio-only export
  readonly audio: {
    readonly codec: 'mp4a.40.2' | 'opus';
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitrate: number;
  } | null;                            // null = video-only export
  readonly useProxies: false;          // export always uses originals
}

// ---------------------------------------------------------------------------
// Invariants (enforced by commands + validated in tests)
// ---------------------------------------------------------------------------
/**
 * 1. Every Id referenced from a sequence/track/clip exists in the corresponding map.
 * 2. Track.clipIds are sorted by clip.start and pairwise non-overlapping.
 * 3. A clip's trackId matches the track whose clipIds contains it, and kinds are compatible
 *    (video/image/title/nested → video track; audio → audio track).
 * 4. Clip.duration > 0; Times normalised.
 * 5. Transitions reference two clips that are adjacent on the same track; duration ≤ available handles.
 * 6. Effect instances are referenced by exactly one owner (clip or track).
 * 7. Nested sequences form a DAG (no sequence contains itself transitively).
 */
