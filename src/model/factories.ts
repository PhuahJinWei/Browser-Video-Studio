/**
 * Entity constructors with sensible defaults.
 *
 * These build well-formed entities but do not wire them into a `Project` — that is
 * the commands layer's job, because only it can maintain the cross-entity invariants.
 */

import { staticParam } from './params';
import * as T from './time';
import type {
  AnimatableCrop,
  AnimatableTransform2D,
  Asset,
  AssetId,
  AudioClip,
  ClipId,
  ColorSpace,
  EffectInstance,
  EffectInstanceId,
  FrameRate,
  Marker,
  MarkerId,
  ParamMap,
  Project,
  ProjectId,
  Sequence,
  SequenceId,
  Size,
  SolidClip,
  Time,
  TitleClip,
  Track,
  TrackId,
  TrackKind,
  Transform2D,
  VideoClip,
} from './types';
import { SCHEMA_VERSION } from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const SDR_BT709: ColorSpace = Object.freeze({
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  fullRange: false,
});

export const IDENTITY_TRANSFORM: Transform2D = Object.freeze({
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
});

export function defaultTransform(): AnimatableTransform2D {
  return {
    x: staticParam(0),
    y: staticParam(0),
    scaleX: staticParam(1),
    scaleY: staticParam(1),
    rotation: staticParam(0),
    anchorX: staticParam(0.5),
    anchorY: staticParam(0.5),
  };
}

export function defaultCrop(): AnimatableCrop {
  return {
    left: staticParam(0),
    top: staticParam(0),
    right: staticParam(0),
    bottom: staticParam(0),
  };
}

export const HD_1080: Size = Object.freeze({ width: 1920, height: 1080 });

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export interface CreateTrackOptions {
  readonly id: TrackId;
  readonly kind: TrackKind;
  readonly name?: string;
  readonly height?: number;
}

/** One model-level default for every timeline track kind. */
export const DEFAULT_TRACK_HEIGHT = 100;

export function createTrack(opts: CreateTrackOptions): Track {
  return {
    id: opts.id,
    kind: opts.kind,
    name: opts.name ?? (opts.kind === 'video' ? 'Video' : 'Audio'),
    clipIds: [],
    muted: false,
    solo: false,
    locked: false,
    hidden: false,
    // Equal defaults give waveforms enough vertical resolution and make mixed A/V
    // lanes predictable; either kind can still be collapsed to 36px by the user.
    height: opts.height ?? DEFAULT_TRACK_HEIGHT,
    effects: [],
    gainDb: staticParam(0),
    pan: staticParam(0),
  };
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export interface CreateMediaClipOptions {
  readonly id: ClipId;
  readonly trackId: TrackId;
  readonly assetId: AssetId;
  readonly start: Time;
  readonly duration: Time;
  readonly sourceIn?: Time;
  readonly speed?: number;
  readonly name?: string;
  readonly streamIndex?: number;
  readonly linkGroupId?: string;
}

export function createVideoClip(
  opts: CreateMediaClipOptions & { readonly kind?: 'video' | 'image' | 'nested' },
): VideoClip {
  return {
    id: opts.id,
    kind: opts.kind ?? 'video',
    trackId: opts.trackId,
    name: opts.name ?? 'Clip',
    start: opts.start,
    duration: opts.duration,
    enabled: true,
    locked: false,
    color: null,
    effects: [],
    linkGroupId: opts.linkGroupId ?? null,
    groupId: null,
    assetId: opts.assetId,
    sourceIn: opts.sourceIn ?? T.TIME_ZERO,
    speed: opts.speed ?? 1,
    speedRamp: null,
    transform: defaultTransform(),
    opacity: staticParam(1),
    blendMode: 'normal',
    crop: defaultCrop(),
    streamIndex: opts.streamIndex ?? 0,
  };
}

export function createAudioClip(opts: CreateMediaClipOptions): AudioClip {
  return {
    id: opts.id,
    kind: 'audio',
    trackId: opts.trackId,
    name: opts.name ?? 'Audio',
    start: opts.start,
    duration: opts.duration,
    enabled: true,
    locked: false,
    color: null,
    effects: [],
    linkGroupId: opts.linkGroupId ?? null,
    groupId: null,
    assetId: opts.assetId,
    sourceIn: opts.sourceIn ?? T.TIME_ZERO,
    speed: opts.speed ?? 1,
    speedRamp: null,
    gainDb: staticParam(0),
    pan: staticParam(0),
    fadeIn: T.TIME_ZERO,
    fadeOut: T.TIME_ZERO,
    channelMap: 'stereo',
    streamIndex: opts.streamIndex ?? 0,
  };
}

export interface CreateSolidClipOptions {
  readonly id: ClipId;
  readonly trackId: TrackId;
  readonly start: Time;
  readonly duration: Time;
  readonly fill: string;
  readonly name?: string;
}

export function createSolidClip(opts: CreateSolidClipOptions): SolidClip {
  return {
    id: opts.id,
    kind: 'solid',
    trackId: opts.trackId,
    name: opts.name ?? 'Colour',
    start: opts.start,
    duration: opts.duration,
    enabled: true,
    locked: false,
    color: null,
    effects: [],
    linkGroupId: null,
    groupId: null,
    fill: opts.fill,
    transform: defaultTransform(),
    opacity: staticParam(1),
    blendMode: 'normal',
  };
}

export interface CreateTitleClipOptions {
  readonly id: ClipId;
  readonly trackId: TrackId;
  readonly start: Time;
  readonly duration: Time;
  readonly text: string;
  readonly name?: string;
}

export function createTitleClip(opts: CreateTitleClipOptions): TitleClip {
  return {
    id: opts.id,
    kind: 'title',
    trackId: opts.trackId,
    name: opts.name ?? (opts.text.slice(0, 40) || 'Title'),
    start: opts.start,
    duration: opts.duration,
    enabled: true,
    locked: false,
    color: null,
    effects: [],
    linkGroupId: null,
    groupId: null,
    text: opts.text,
    style: {
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSizePx: 72,
      fontWeight: 600,
      color: '#ffffff',
      align: 'center',
      background: null,
    },
    transform: defaultTransform(),
    opacity: staticParam(1),
  };
}

// ---------------------------------------------------------------------------
// Effects & markers
// ---------------------------------------------------------------------------

export function createEffect(
  id: EffectInstanceId,
  effectType: string,
  params: ParamMap = {},
): EffectInstance {
  return { id, effectType, enabled: true, params };
}

export interface CreateMarkerOptions {
  readonly id: MarkerId;
  readonly at: Time;
  readonly name?: string;
  readonly duration?: Time;
  readonly color?: string;
  readonly kind?: Marker['kind'];
}

export function createMarker(opts: CreateMarkerOptions): Marker {
  return {
    id: opts.id,
    at: opts.at,
    duration: opts.duration ?? T.TIME_ZERO,
    name: opts.name ?? '',
    color: opts.color ?? '#e3b341',
    kind: opts.kind ?? 'comment',
  };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface CreatePlaceholderAssetOptions {
  readonly id: AssetId;
  readonly name: string;
  readonly kind: Asset['kind'];
  readonly videoDuration?: Time;
  readonly audioDuration?: Time;
  readonly size?: Size;
  readonly frameRate?: FrameRate;
  readonly sampleRate?: number;
}

/**
 * Build a ready `Asset` without going through the indexer. Real imports come from
 * the MediaIndexer worker; this exists for nested sequences, generated media and tests.
 */
export function createAsset(opts: CreatePlaceholderAssetOptions): Asset {
  const size = opts.size ?? HD_1080;
  return {
    id: opts.id,
    kind: opts.kind,
    name: opts.name,
    createdAt: 0,
    source: null,
    video:
      opts.videoDuration === undefined
        ? null
        : {
            codec: 'avc1.640028',
            size,
            frameRate: opts.frameRate ?? T.FPS_25,
            duration: opts.videoDuration,
            colorSpace: SDR_BT709,
            rotation: 0,
            hwDecodable: true,
          },
    audio:
      opts.audioDuration === undefined
        ? null
        : {
            codec: 'mp4a.40.2',
            sampleRate: opts.sampleRate ?? 48000,
            channels: 2,
            duration: opts.audioDuration,
          },
    image: opts.kind === 'image' ? { size } : null,
    nestedSequenceId: null,
    derived: {
      indexPath: null,
      thumbsPath: null,
      waveformPath: null,
      proxyPath: null,
      proxySize: null,
    },
    status: { state: 'ready' },
    folder: '',
  };
}

// ---------------------------------------------------------------------------
// Sequences & projects
// ---------------------------------------------------------------------------

export interface CreateSequenceOptions {
  readonly id: SequenceId;
  readonly name?: string;
  readonly frameRate?: FrameRate;
  readonly size?: Size;
  readonly sampleRate?: number;
}

export function createSequence(opts: CreateSequenceOptions): Sequence {
  return {
    id: opts.id,
    name: opts.name ?? 'Sequence',
    frameRate: opts.frameRate ?? T.FPS_25,
    size: opts.size ?? HD_1080,
    sampleRate: opts.sampleRate ?? 48000,
    channels: 2,
    colorSpace: SDR_BT709,
    videoTrackIds: [],
    audioTrackIds: [],
    transitionIds: [],
    markerIds: [],
    masterGainDb: staticParam(0),
    view: {
      playhead: T.TIME_ZERO,
      zoom: 100,
      scrollX: T.TIME_ZERO,
      inPoint: null,
      outPoint: null,
    },
  };
}

export interface CreateProjectOptions {
  readonly id: ProjectId;
  readonly sequenceId: SequenceId;
  readonly name?: string;
  readonly frameRate?: FrameRate;
  readonly size?: Size;
  readonly sampleRate?: number;
  /** Track ids for the starter layout. Pass [] for an empty sequence. */
  readonly videoTrackIds?: readonly TrackId[];
  readonly audioTrackIds?: readonly TrackId[];
}

/** A new, empty, valid project with one sequence and the given starter tracks. */
export function createProject(opts: CreateProjectOptions): Project {
  const videoTrackIds = opts.videoTrackIds ?? [];
  const audioTrackIds = opts.audioTrackIds ?? [];

  const tracks: Record<TrackId, Track> = {};
  videoTrackIds.forEach((id, i) => {
    tracks[id] = createTrack({ id, kind: 'video', name: `V${i + 1}` });
  });
  audioTrackIds.forEach((id, i) => {
    tracks[id] = createTrack({ id, kind: 'audio', name: `A${i + 1}` });
  });

  const sequence: Sequence = {
    ...createSequence({
      id: opts.sequenceId,
      name: opts.name ?? 'Sequence',
      ...(opts.frameRate ? { frameRate: opts.frameRate } : {}),
      ...(opts.size ? { size: opts.size } : {}),
      ...(opts.sampleRate ? { sampleRate: opts.sampleRate } : {}),
    }),
    videoTrackIds,
    audioTrackIds,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    id: opts.id,
    name: opts.name ?? 'Untitled project',
    createdAt: 0,
    modifiedAt: 0,
    assets: {},
    sequences: { [opts.sequenceId]: sequence },
    tracks,
    clips: {},
    effects: {},
    transitions: {},
    markers: {},
    activeSequenceId: opts.sequenceId,
    settings: {
      proxyMode: 'auto',
      memoryBudgetBytes: 1_500_000_000,
      copyMediaToOpfsUpToBytes: 2_000_000_000,
    },
  };
}
