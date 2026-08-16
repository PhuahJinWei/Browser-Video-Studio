/**
 * The command vocabulary.
 *
 * Commands are plain serialisable data, not closures, so they can be logged, replayed,
 * and eventually sent over a wire for collaboration. `apply()` turns one into a new
 * document; it never mutates the old one.
 *
 * Undo is snapshot-based rather than inverse-command-based: with normalised immutable
 * maps a snapshot costs one object plus structural sharing, and hand-written inverses
 * are a classic source of subtle NLE corruption (restoring a rippled delete has to put
 * back clips, effect instances *and* transitions, in order).
 */

import type {
  Asset,
  AssetId,
  AssetStatus,
  BlendMode,
  ClipId,
  CrossfadeCurve,
  EffectInstanceId,
  MarkerId,
  Param,
  ParamMap,
  ParamValue,
  SequenceId,
  Time,
  TrackId,
  TrackKind,
  Transition,
  TransitionId,
} from '../types';

/** What a new clip should be made of. The clip's id comes from the `IdSource`. */
export type NewClipSpec =
  | {
      readonly kind: 'video' | 'image' | 'nested' | 'audio';
      readonly assetId: AssetId;
      readonly start: Time;
      readonly duration: Time;
      readonly sourceIn?: Time;
      readonly speed?: number;
      readonly name?: string;
      readonly streamIndex?: number;
      readonly linkGroupId?: string;
      readonly clipId?: ClipId;
    }
  | {
      readonly kind: 'title';
      readonly start: Time;
      readonly duration: Time;
      readonly text: string;
      readonly name?: string;
      readonly clipId?: ClipId;
    }
  | {
      readonly kind: 'solid';
      readonly start: Time;
      readonly duration: Time;
      readonly fill: string;
      readonly name?: string;
      readonly clipId?: ClipId;
    };

export interface ClipMove {
  readonly clipId: ClipId;
  readonly toTrackId: TrackId;
  readonly toStart: Time;
}

export type EffectOwner =
  | { readonly kind: 'clip'; readonly clipId: ClipId }
  | { readonly kind: 'track'; readonly trackId: TrackId };

export type TrackProps = Partial<{
  readonly name: string;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly locked: boolean;
  readonly hidden: boolean;
  readonly height: number;
}>;

export type ClipProps = Partial<{
  readonly name: string;
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly color: string | null;
  readonly linkGroupId: string | null;
}>;

/**
 * Animatable properties that live on the clip itself rather than in an effect.
 * Dotted keys address a channel of a composite structure.
 */
export type ClipParamKey =
  | 'opacity'
  | 'gainDb'
  | 'pan'
  | 'transform.x'
  | 'transform.y'
  | 'transform.scaleX'
  | 'transform.scaleY'
  | 'transform.rotation'
  | 'transform.anchorX'
  | 'transform.anchorY'
  | 'crop.left'
  | 'crop.top'
  | 'crop.right'
  | 'crop.bottom';

export type ViewProps = Partial<{
  readonly playhead: Time;
  readonly zoom: number;
  readonly scrollX: Time;
  readonly inPoint: Time | null;
  readonly outPoint: Time | null;
}>;

export type Command =
  // -- tracks ---------------------------------------------------------------
  | {
      readonly type: 'addTrack';
      readonly sequenceId: SequenceId;
      readonly kind: TrackKind;
      readonly name?: string;
      /** Insertion index within that kind's list. Appends when omitted. */
      readonly index?: number;
      readonly trackId?: TrackId;
    }
  | { readonly type: 'removeTrack'; readonly trackId: TrackId }
  | { readonly type: 'setTrackProps'; readonly trackId: TrackId; readonly props: TrackProps }
  /** Track-level gain and pan, which are animatable and so are not plain props. */
  | {
      readonly type: 'setTrackParam';
      readonly trackId: TrackId;
      readonly key: 'gainDb' | 'pan';
      readonly param: Param<number>;
    }
  | { readonly type: 'moveTrack'; readonly trackId: TrackId; readonly toIndex: number }

  // -- clips ----------------------------------------------------------------
  | {
      readonly type: 'insertClip';
      readonly trackId: TrackId;
      readonly clip: NewClipSpec;
      /** 'overwrite' replaces what is there; 'insert' ripples later clips right. */
      readonly mode?: 'overwrite' | 'insert';
    }
  | {
      readonly type: 'removeClips';
      readonly clipIds: readonly ClipId[];
      /** 'lift' leaves a gap; 'ripple' closes it. */
      readonly mode?: 'lift' | 'ripple';
    }
  | {
      readonly type: 'moveClips';
      readonly moves: readonly ClipMove[];
      /**
       * 'overwrite' trims or splits whatever the clips land on (the old behaviour).
       * 'block' refuses the move instead — dropping a clip on top of another must
       * not silently resize it; resizing is a trim, and trims are explicit.
       * Defaults to 'block'.
       */
      readonly mode?: 'overwrite' | 'block';
    }
  | {
      readonly type: 'trimClip';
      readonly clipId: ClipId;
      readonly edge: 'in' | 'out';
      /** New timeline position of that edge. */
      readonly to: Time;
      /** Shift following clips by the same delta. */
      readonly ripple?: boolean;
    }
  | { readonly type: 'slipClip'; readonly clipId: ClipId; readonly by: Time }
  | {
      readonly type: 'splitClips';
      readonly trackIds: readonly TrackId[];
      readonly at: Time;
    }
  | { readonly type: 'setClipProps'; readonly clipId: ClipId; readonly props: ClipProps }
  | {
      readonly type: 'setClipParam';
      readonly clipId: ClipId;
      readonly key: ClipParamKey;
      readonly param: Param<number>;
    }
  | {
      readonly type: 'setClipFade';
      readonly clipId: ClipId;
      readonly edge: 'in' | 'out';
      readonly duration: Time;
    }
  | { readonly type: 'setClipBlendMode'; readonly clipId: ClipId; readonly blendMode: BlendMode }
  /** Recolour a fill clip. Any CSS colour; alpha is honoured. */
  | { readonly type: 'setSolidFill'; readonly clipId: ClipId; readonly fill: string }
  /**
   * Put a transition across the cut between two adjacent clips.
   *
   * `duration` is a request, not a demand: it is shortened to whatever the two
   * clips can actually supply rather than refused outright.
   */
  | {
      readonly type: 'addTransition';
      readonly fromClipId: ClipId;
      readonly toClipId: ClipId;
      readonly duration: Time;
      readonly transitionType?: string;
      readonly alignment?: Transition['alignment'];
    }
  | { readonly type: 'removeTransition'; readonly transitionId: TransitionId }
  | {
      readonly type: 'setTransitionType';
      readonly transitionId: TransitionId;
      readonly transitionType: string;
    }
  /** Where the overlap sits relative to the cut. Re-fits the duration. */
  | {
      readonly type: 'setTransitionAlignment';
      readonly transitionId: TransitionId;
      readonly alignment: Transition['alignment'];
    }
  /**
   * Move the cut between two adjacent clips without moving anything else.
   *
   * One clip gains exactly what the other gives up, so the pair covers the same
   * span and nothing downstream shifts. `to` is clamped to what the two clips
   * can actually supply.
   */
  | {
      readonly type: 'rollEdit';
      readonly fromClipId: ClipId;
      readonly toClipId: ClipId;
      readonly to: Time;
    }
  /** Gain shape for the audio crossfade. Video ignores it. */
  | {
      readonly type: 'setTransitionCurve';
      readonly transitionId: TransitionId;
      readonly curve: CrossfadeCurve;
    }
  /** Wipe edge feather, 0..0.5 as a fraction of the sweep. */
  | {
      readonly type: 'setTransitionSoftness';
      readonly transitionId: TransitionId;
      readonly softness: number;
    }
  /** Also shortened to fit. */
  | {
      readonly type: 'setTransitionDuration';
      readonly transitionId: TransitionId;
      readonly duration: Time;
    }
  | { readonly type: 'setClipSpeed'; readonly clipId: ClipId; readonly speed: number }
  /** Break the video/audio link on every clip in these clips' groups. */
  | { readonly type: 'unlinkClips'; readonly clipIds: readonly ClipId[] }
  /** Put these clips into one link group so they move and trim together. */
  | { readonly type: 'linkClips'; readonly clipIds: readonly ClipId[] }
  /** Put these clips into one group. Groups select, move and trim as a unit. */
  | { readonly type: 'groupClips'; readonly clipIds: readonly ClipId[] }
  /** Dissolve the groups these clips belong to. */
  | { readonly type: 'ungroupClips'; readonly clipIds: readonly ClipId[] }

  // -- effects --------------------------------------------------------------
  | {
      readonly type: 'addEffect';
      readonly owner: EffectOwner;
      readonly effectType: string;
      readonly params?: ParamMap;
      readonly index?: number;
      readonly effectId?: EffectInstanceId;
    }
  | { readonly type: 'removeEffect'; readonly effectId: EffectInstanceId }
  | { readonly type: 'moveEffect'; readonly effectId: EffectInstanceId; readonly toIndex: number }
  | {
      readonly type: 'setEffectParam';
      readonly effectId: EffectInstanceId;
      readonly key: string;
      readonly param: Param<ParamValue>;
    }
  | {
      readonly type: 'setEffectEnabled';
      readonly effectId: EffectInstanceId;
      readonly enabled: boolean;
    }

  // -- assets ---------------------------------------------------------------
  | { readonly type: 'addAsset'; readonly asset: Asset }
  | { readonly type: 'removeAsset'; readonly assetId: AssetId }
  | {
      readonly type: 'setAssetStatus';
      readonly assetId: AssetId;
      readonly status: AssetStatus;
    }

  // -- markers --------------------------------------------------------------
  | {
      readonly type: 'addMarker';
      readonly sequenceId: SequenceId;
      readonly at: Time;
      readonly name?: string;
      readonly markerId?: MarkerId;
    }
  | { readonly type: 'removeMarker'; readonly markerId: MarkerId }

  // -- view -----------------------------------------------------------------
  | {
      readonly type: 'setView';
      readonly sequenceId: SequenceId;
      readonly view: ViewProps;
    };

export type CommandType = Command['type'];
