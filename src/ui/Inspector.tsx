/**
 * Inspector.
 *
 * Effect controls are generated from the effect registry, so a new effect type gets a
 * UI for free. Every edit goes through a command with a coalesce key, so dragging a
 * slider is one undo step rather than one per pixel.
 */

import { useId, useState } from 'react';
import { defaultParams, EFFECT_REGISTRY, effectDefinition, listEffects } from '../engine/effects';
import type { Command } from '../model/commands';
import { DEFAULT_TRANSITION_SECONDS, TRANSITION_LABELS } from './transitions';
import type { ClipParamKey } from '../model/commands';
import { staticParam } from '../model/params';
import {
  isAudioClip,
  isMediaClip,
  isSyntheticClip,
  isVisualClip,
  maxTransitionDuration,
  pairedTransitions,
  selectionUnit,
  transitionCurve,
  transitionSoftness,
  transitionSpan,
} from '../model/selectors';
import * as T from '../model/time';
import { TRANSITION_TYPES } from '../model/types';
import type {
  AudioClip,
  BlendMode,
  Clip,
  ClipId,
  CrossfadeCurve,
  EffectInstance,
  Param,
  Project,
  SolidClip,
  TitleClip,
  Track,
  Transition,
  VideoClip,
} from '../model/types';
import {
  formatGain,
  formatPan,
  formatPercent,
  GAIN_PERCENT_MAX,
  GAIN_PERCENT_UNITY,
  gainDbToPercent,
  percentToGainDb,
} from './format';
import { Fader, quantizeRangeValue } from './Fader';
import { useStudio } from './store';

const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'add',
  'darken',
  'lighten',
  'difference',
];

export function Inspector(): React.JSX.Element {
  const history = useStudio((s) => s.history);
  const selection = useStudio((s) => s.selection);
  const selectedTrackId = useStudio((s) => s.selectedTrackId);
  const selectedTransitionId = useStudio((s) => s.selectedTransitionId);
  const project = history.present.project;
  const track = selectedTrackId ? project.tracks[selectedTrackId] : undefined;
  const transition = selectedTransitionId ? project.transitions[selectedTransitionId] : undefined;

  const selected = selection.map((id) => project.clips[id]).filter((c): c is Clip => Boolean(c));

  /**
   * A linked or grouped selection is one thing to the user, so the inspector treats
   * it as one subject: the visual half supplies the picture controls and the audio
   * half the sound controls. Without this, selection expanding to a unit would leave
   * the inspector permanently showing "2 clips selected" and nothing editable.
   */
  const unit = asSingleUnit(project, selection);

  return (
    <div className="panel">
      <div className="panel-head">Inspector</div>
      <div className="panel-body">
        {transition && <TransitionInspector transition={transition} />}
        {!transition && track && <TrackInspector track={track} />}
        {/*
          Nothing selected is not nothing to show. The sequence's own format was
          unreachable — fixed at whatever the starter guessed — and this is the panel
          already asking "what are you looking at", so it belongs here rather than
          behind a dialog nobody opens.
        */}
        {!transition && !track && !unit && (
          <>
            {selected.length > 1 && <p className="hint">{selected.length} clips selected.</p>}
            <SequenceInspector />
          </>
        )}
        {!transition && !track && unit && <UnitInspector unit={unit} />}
      </div>
    </div>
  );
}

/** The rates worth offering; anything else can be typed into a project file. */
const FRAME_RATES: readonly { label: string; value: T.FrameRate }[] = [
  { label: '23.976', value: T.FPS_23_976 },
  { label: '24', value: T.FPS_24 },
  { label: '25', value: T.FPS_25 },
  { label: '29.97', value: T.FPS_29_97 },
  { label: '30', value: T.FPS_30 },
  { label: '50', value: T.FPS_50 },
  { label: '59.94', value: T.FPS_59_94 },
  { label: '60', value: T.FPS_60 },
];

const SIZE_PRESETS: readonly { label: string; width: number; height: number }[] = [
  { label: '4K', width: 3840, height: 2160 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '720p', width: 1280, height: 720 },
  { label: 'Vertical', width: 1080, height: 1920 },
  { label: 'Square', width: 1080, height: 1080 },
];

/**
 * The sequence's own format.
 *
 * Shown when nothing is selected, which is also when someone is most likely to be
 * asking why their footage has black all around it. The first clip into an empty
 * sequence sets these automatically; this is how to disagree with that, and the only
 * way to change them at all after something has been cut.
 */
function SequenceInspector(): React.JSX.Element {
  const run = useStudio((s) => s.run);
  const history = useStudio((s) => s.history);
  const sequenceId = useStudio((s) => s.sequenceId);
  const project = history.present.project;
  const sequence = project.sequences[sequenceId]!;
  const { size, frameRate } = sequence;

  const setSize = (width: number, height: number): void => {
    // Encoders reject odd dimensions for most codecs, and a zero is meaningless.
    const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
    run(
      { type: 'setSequenceSettings', sequenceId, size: { width: even(width), height: even(height) } },
      'Set sequence size',
    );
  };

  // Matching the media is the common case, so it gets a button rather than arithmetic.
  const videoAssets = Object.values(project.assets).filter((a) => a.video?.size);
  const firstVideo = videoAssets[0];
  const matches =
    firstVideo?.video &&
    firstVideo.video.size.width === size.width &&
    firstVideo.video.size.height === size.height;

  return (
    <>
      <p className="unit-badge">Sequence · nothing selected</p>

      <div className="field">
        <label>Resolution</label>
        <div className="value-row">
          <input
            type="number"
            min={2}
            step={2}
            value={size.width}
            onChange={(event) => setSize(Number(event.target.value), size.height)}
          />
          <span className="hint">×</span>
          <input
            type="number"
            min={2}
            step={2}
            value={size.height}
            onChange={(event) => setSize(size.width, Number(event.target.value))}
          />
        </div>
      </div>

      <div className="bin-filters" style={{ padding: '0 0 8px' }}>
        {SIZE_PRESETS.map((preset) => (
          <button
            key={preset.label}
            className={`bin-filter${
              preset.width === size.width && preset.height === size.height ? ' on' : ''
            }`}
            onClick={() => setSize(preset.width, preset.height)}
          >
            {preset.label}
          </button>
        ))}
        {firstVideo?.video && (
          <button
            className={`bin-filter${matches ? ' on' : ''}`}
            title={`Match "${firstVideo.name}" — ${firstVideo.video.size.width}×${firstVideo.video.size.height}`}
            onClick={() => {
              const media = firstVideo.video!;
              run(
                {
                  type: 'setSequenceSettings',
                  sequenceId,
                  size: media.size,
                  ...(media.frameRate ? { frameRate: media.frameRate } : {}),
                },
                'Match sequence to media',
              );
            }}
          >
            Match media
          </button>
        )}
      </div>

      <div className="field">
        <label>Frame rate</label>
        <select
          value={`${frameRate.num}/${frameRate.den}`}
          onChange={(event) => {
            const found = FRAME_RATES.find((r) => `${r.value.num}/${r.value.den}` === event.target.value);
            if (found) {
              run(
                { type: 'setSequenceSettings', sequenceId, frameRate: found.value },
                'Set sequence frame rate',
              );
            }
          }}
        >
          {/* A project opened with an unusual rate keeps it rather than snapping. */}
          {!FRAME_RATES.some((r) => r.value.num === frameRate.num && r.value.den === frameRate.den) && (
            <option value={`${frameRate.num}/${frameRate.den}`}>
              {T.fpsToNumber(frameRate).toFixed(3)} (current)
            </option>
          )}
          {FRAME_RATES.map((rate) => (
            <option key={rate.label} value={`${rate.value.num}/${rate.value.den}`}>
              {rate.label} fps
            </option>
          ))}
        </select>
      </div>

      <p className="hint">
        Clip positions are stored in exact seconds, so changing the rate re-counts
        timecode and export without moving anything.
      </p>
    </>
  );
}

const ALIGNMENTS: readonly { value: Transition['alignment']; label: string; hint: string }[] = [
  { value: 'centered', label: 'Centre on cut', hint: 'Half from each clip' },
  { value: 'start', label: 'Start at cut', hint: 'All from the outgoing clip' },
  { value: 'end', label: 'End at cut', hint: 'All from the incoming clip' },
];

/**
 * Transition properties.
 *
 * Every edit goes to the whole paired set, so a linked A/V pair can never end up
 * with a 2 s picture wipe over a 1 s audio crossfade.
 */
function TransitionInspector({ transition }: { transition: Transition }): React.JSX.Element {
  const run = useStudio((s) => s.run);
  const runMany = useStudio((s) => s.runMany);
  const endGesture = useStudio((s) => s.endGesture);
  const history = useStudio((s) => s.history);
  const project = history.present.project;

  const paired = pairedTransitions(project, transition);
  const track = project.tracks[transition.trackId];
  const from = transition.fromClipId === null ? null : project.clips[transition.fromClipId];
  const to = transition.toClipId === null ? null : project.clips[transition.toClipId];
  // Against black on one side, so there is no alignment to choose and no cut.
  const againstBlack = !from || !to;
  const span = transitionSpan(project, transition);
  const isAudio = track?.kind === 'audio';
  const isWipe = transition.transitionType.startsWith('wipe.');
  // Only worth showing when one of the paired transitions actually carries sound.
  const affectsAudio = paired.some((t) => project.tracks[t.trackId]?.kind === 'audio');

  const longest = from && to ? maxTransitionDuration(project, from, to, transition.alignment) : null;

  const applyToPair = (
    build: (t: Transition) => Command,
    label: string,
    coalesceKey?: string,
  ): void => runMany(paired.map(build), label, coalesceKey);

  return (
    <>
      <div className="field">
        <label>Transition</label>
        <p className="hint" style={{ margin: 0 }}>
          {from ? from.name : 'black'} → {to ? to.name : 'black'} on {track?.name ?? '?'}
          {paired.length > 1 && <> · picture and sound</>}
        </p>
      </div>

      <div className="field">
        <label>Style</label>
        <select
          value={transition.transitionType}
          disabled={isAudio}
          onChange={(event) =>
            applyToPair(
              (t) => ({
                type: 'setTransitionType' as const,
                transitionId: t.id,
                // Sound has no edge to wipe, so it stays a crossfade underneath.
                transitionType:
                  project.tracks[t.trackId]?.kind === 'audio' ? 'dissolve' : event.target.value,
              }),
              'Set transition style',
            )
          }
        >
          {TRANSITION_TYPES.map((type) => (
            <option key={type} value={type}>
              {TRANSITION_LABELS[type]}
            </option>
          ))}
        </select>
        {isAudio && <p className="hint">Sound crossfades; there is no edge to wipe.</p>}
      </div>

      <Slider
        label="Duration"
        // Not a neutral so much as the length a transition is created at, which is
        // the value someone reaching for this slider is most likely heading back to.
        neutral={DEFAULT_TRANSITION_SECONDS}
        neutralSnapSteps={3}
        value={T.toSeconds(transition.duration)}
        min={0.04}
        max={Math.max(0.04, longest ? T.toSeconds(longest) : 4)}
        step={0.02}
        unit=" s"
        onChange={(value) =>
          applyToPair(
            (t) => ({
              type: 'setTransitionDuration' as const,
              transitionId: t.id,
              duration: T.fromSeconds(value, 1000),
            }),
            'Set transition length',
            `transition-duration:${transition.id}`,
          )
        }
        onCommit={endGesture}
      />
      {longest && (
        <p className="hint">
          Up to {T.formatDuration(longest, { decimals: 2 })} here — limited by the
          material either side of the cut.
        </p>
      )}

      {!againstBlack && (
      <div className="field">
        <label>Alignment</label>
        <select
          value={transition.offset === null ? transition.alignment : 'custom'}
          onChange={(event) =>
            applyToPair(
              (t) => ({
                type: 'setTransitionAlignment' as const,
                transitionId: t.id,
                alignment: event.target.value as Transition['alignment'],
              }),
              'Set transition alignment',
            )
          }
        >
          {ALIGNMENTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} — {option.hint}
            </option>
          ))}
          {/* Only reachable by dragging; picking any preset above leaves it. */}
          {transition.offset !== null && (
            <option value="custom">Custom — dragged off the presets</option>
          )}
        </select>
        {span && (
          <p className="hint">
            {T.formatDuration(span.start, { decimals: 2 })} →{' '}
            {T.formatDuration(T.rangeEnd(span), { decimals: 2 })}
          </p>
        )}
      </div>
      )}

      {affectsAudio && (
        <div className="field">
          <label>Audio crossfade</label>
          <select
            value={transitionCurve(transition)}
            onChange={(event) =>
              applyToPair(
                (t) => ({
                  type: 'setTransitionCurve' as const,
                  transitionId: t.id,
                  curve: event.target.value as CrossfadeCurve,
                }),
                'Set crossfade curve',
              )
            }
          >
            <option value="equal-power">Constant power — different material</option>
            <option value="linear">Constant gain — same or similar material</option>
          </select>
          <p className="hint">
            Sound sums where picture layers, so both sides ramp. Constant power holds
            the loudness steady across two different shots; constant gain suits
            material that is alike, where constant power would swell in the middle.
          </p>
        </div>
      )}

      {isWipe && (
        <Slider
          label="Edge softness"
          neutral={0}
          value={transitionSoftness(transition) * 100}
          min={0}
          max={20}
          step={0.2}
          unit="%"
          onChange={(value) =>
            run(
              { type: 'setTransitionSoftness', transitionId: transition.id, softness: value / 100 },
              'Set edge softness',
              `transition-softness:${transition.id}`,
            )
          }
          onCommit={endGesture}
        />
      )}

      <div className="field">
        <div className="value-row">
          <button
            className="danger"
            onClick={() =>
              applyToPair(
                (t) => ({ type: 'removeTransition' as const, transitionId: t.id }),
                'Remove transition',
              )
            }
          >
            {paired.length > 1 ? `Remove (${paired.length})` : 'Remove'}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Track properties: volume and pan, which the mixer already applies, plus the
 * track's own effect stack — both were reachable in the model but had no UI.
 */
function TrackInspector({ track }: { track: Track }): React.JSX.Element {
  const run = useStudio((s) => s.run);
  const endGesture = useStudio((s) => s.endGesture);
  const history = useStudio((s) => s.history);
  const project = history.present.project;

  const effects = track.effects
    .map((id) => project.effects[id])
    .filter((e): e is EffectInstance => e !== undefined);

  const setTrackParam = (key: 'gainDb' | 'pan', value: number, label: string): void =>
    run(
      { type: 'setTrackParam', trackId: track.id, key, param: staticParam(value) },
      label,
      `${key}:${track.id}`,
    );
  const setProps = (props: Record<string, boolean>, label: string): void =>
    run({ type: 'setTrackProps', trackId: track.id, props }, label);

  return (
    <>
      <div className="field">
        <label>Track name</label>
        <input
          type="text"
          value={track.name}
          onChange={(event) =>
            run(
              { type: 'setTrackProps', trackId: track.id, props: { name: event.target.value } },
              'Rename track',
              `rename:${track.id}`,
            )
          }
          onBlur={endGesture}
        />
      </div>

      <p className="unit-badge">
        {track.kind === 'video' ? 'Video track' : 'Audio track'} · {track.clipIds.length}{' '}
        clip{track.clipIds.length === 1 ? '' : 's'}
      </p>

      {track.kind === 'audio' ? (
        <>
          <Slider
            label="Volume"
            neutral={GAIN_PERCENT_UNITY}
            neutralSnapSteps={5}
            value={Math.round(gainDbToPercent(staticValue(track.gainDb, 0)))}
            min={0}
            max={GAIN_PERCENT_MAX}
            step={1}
            format={formatPercent}
            detail={(percent) => formatGain(percentToGainDb(percent))}
            onChange={(percent) =>
              setTrackParam('gainDb', percentToGainDb(percent), 'Set track volume')
            }
            onCommit={endGesture}
          />
          <Slider
            label="Pan"
            neutral={0}
            neutralSnapSteps={4}
            value={staticValue(track.pan, 0)}
            min={-1}
            max={1}
            step={0.01}
            format={formatPan}
            onChange={(value) => setTrackParam('pan', value, 'Set track pan')}
            onCommit={endGesture}
          />
        </>
      ) : (
        <p className="hint">Volume and pan apply to audio tracks.</p>
      )}

      <div className="field">
        <div className="value-row">
          {track.kind === 'audio' ? (
            <>
              <button onClick={() => setProps({ muted: !track.muted }, 'Mute track')}>
                {track.muted ? 'Unmute' : 'Mute'}
              </button>
              <button onClick={() => setProps({ solo: !track.solo }, 'Solo track')}>
                {track.solo ? 'Unsolo' : 'Solo'}
              </button>
            </>
          ) : (
            <button onClick={() => setProps({ hidden: !track.hidden }, 'Hide track')}>
              {track.hidden ? 'Show' : 'Hide'}
            </button>
          )}
          <button onClick={() => setProps({ locked: !track.locked }, 'Lock track')}>
            {track.locked ? 'Unlock' : 'Lock'}
          </button>
        </div>
      </div>

      <Slider
        label="Height"
        value={track.height}
        min={36}
        max={160}
        step={4}
        unit=" px"
        onChange={(height) =>
          run(
            {
              type: 'setTrackProps',
              trackId: track.id,
              props: { height },
            },
            'Set track height',
            `height:${track.id}`,
          )
        }
        onCommit={endGesture}
      />

      <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '14px 0' }} />

      <div className="field">
        <label>Track effects</label>
        {effects.length === 0 && <p className="hint">None.</p>}
        {effects.map((effect) => (
          <EffectCard key={effect.id} effect={effect} />
        ))}
        <select
          value=""
          onChange={(event) => {
            const type = event.target.value;
            if (!type) return;
            run(
              {
                type: 'addEffect',
                owner: { kind: 'track', trackId: track.id },
                effectType: type,
                params: defaultParams(type),
              },
              `Add ${EFFECT_REGISTRY[type]?.label ?? type}`,
            );
          }}
        >
          <option value="">Add effect…</option>
          {listEffects()
            .filter((definition) =>
              track.kind === 'audio'
                ? definition.category === 'audio'
                : definition.category !== 'audio',
            )
            .map((definition) => (
              <option key={definition.type} value={definition.type}>
                {definition.label}
              </option>
            ))}
        </select>
      </div>
    </>
  );
}

/** The clips of one link/group unit, split by the role each plays. */
interface SelectedUnit {
  readonly clips: readonly Clip[];
  readonly visual: VideoClip | TitleClip | SolidClip | null;
  readonly audio: AudioClip | null;
  /** The clip that names the unit and owns its timing. */
  readonly primary: Clip;
  readonly isUnit: boolean;
}

function asSingleUnit(project: Project, selection: readonly ClipId[]): SelectedUnit | null {
  if (selection.length === 0) return null;
  const clips = selection.map((id) => project.clips[id]).filter((c): c is Clip => Boolean(c));
  if (clips.length === 0) return null;

  // Every selected clip must belong to the same unit for this to be one subject.
  const expected = new Set(selectionUnit(project, clips[0]!.id));
  if (clips.length !== expected.size || !clips.every((c) => expected.has(c.id))) return null;

  const visual = clips.find(isVisualClip) ?? null;
  const audio = clips.find(isAudioClip) ?? null;
  return {
    clips,
    visual,
    audio,
    primary: visual ?? audio ?? clips[0]!,
    isUnit: clips.length > 1,
  };
}

/** Static numeric value of a parameter, or a fallback when it is keyframed. */
function staticValue(param: Param<number>, fallback: number): number {
  return param.kind === 'static' ? param.value : fallback;
}

function UnitInspector({ unit }: { unit: SelectedUnit }): React.JSX.Element {
  const run = useStudio((s) => s.run);
  const runMany = useStudio((s) => s.runMany);
  const endGesture = useStudio((s) => s.endGesture);
  const history = useStudio((s) => s.history);
  const project = history.present.project;

  const clip = unit.primary;
  // Effects from every member, so a linked pair shows its video and audio
  // effects in one list rather than hiding half of them.
  const effects = unit.clips
    .flatMap((c) => c.effects)
    .map((id) => project.effects[id])
    .filter((e): e is EffectInstance => e !== undefined);

  const paramSetter =
    (targetId: ClipId) =>
    (key: ClipParamKey, value: number, label: string): void =>
      run(
        { type: 'setClipParam', clipId: targetId, key, param: staticParam(value) },
        label,
        `${key}:${targetId}`,
      );

  return (
    <>
      <div className="field">
        <label>Name</label>
        <input
          type="text"
          value={clip.name}
          onChange={(event) =>
            runMany(
              unit.clips.map((c) => ({
                type: 'setClipProps' as const,
                clipId: c.id,
                props: { name: event.target.value },
              })),
              'Rename clip',
              `rename:${clip.id}`,
            )
          }
          onBlur={endGesture}
        />
      </div>

      {unit.isUnit && (
        <p className="unit-badge">
          {unit.clips.some((c) => c.groupId) ? 'Grouped' : 'Linked'} · {unit.clips.length}{' '}
          clips edited together
        </p>
      )}

      <div className="field">
        <label>Timing</label>
        <p className="hint" style={{ margin: 0 }}>
          {T.formatDuration(clip.start, { decimals: 2 })} →{' '}
          {T.formatDuration(T.add(clip.start, clip.duration), { decimals: 2 })} ·{' '}
          {T.formatDuration(clip.duration, { decimals: 2 })}
          {isMediaClip(clip) && (
            <>
              <br />
              source @ {T.formatDuration(clip.sourceIn, { decimals: 2 })} · {clip.speed}×
            </>
          )}
        </p>
      </div>

      <div className="field">
        <div className="value-row">
          <button
            onClick={() =>
              runMany(
                unit.clips.map((c) => ({
                  type: 'setClipProps' as const,
                  clipId: c.id,
                  props: { enabled: !clip.enabled },
                })),
                clip.enabled ? 'Disable clip' : 'Enable clip',
              )
            }
          >
            {clip.enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            onClick={() =>
              runMany(
                unit.clips.map((c) => ({
                  type: 'setClipProps' as const,
                  clipId: c.id,
                  props: { locked: !clip.locked },
                })),
                clip.locked ? 'Unlock clip' : 'Lock clip',
              )
            }
          >
            {clip.locked ? 'Unlock' : 'Lock'}
          </button>
          <button
            onClick={() =>
              run({ type: 'removeClips', clipIds: unit.clips.map((c) => c.id) }, 'Delete clip')
            }
          >
            Delete
          </button>
        </div>
      </div>

      {unit.visual && (
        <VisualControls
          clip={unit.visual}
          setParam={paramSetter(unit.visual.id)}
          onCommit={endGesture}
        />
      )}
      {unit.audio && (
        <>
          {unit.visual && <p className="section-label">Audio</p>}
          <AudioControls
            clip={unit.audio}
            setParam={paramSetter(unit.audio.id)}
            onCommit={endGesture}
          />
        </>
      )}

      <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '14px 0' }} />

      <div className="field">
        <label>Effects</label>
        {effects.length === 0 && <p className="hint">None.</p>}
        {effects.map((effect) => (
          <EffectCard key={effect.id} effect={effect} />
        ))}
        <select
          value=""
          onChange={(event) => {
            const type = event.target.value;
            if (!type) return;
            // Audio effects belong on the audio half of a linked pair.
            const target =
              EFFECT_REGISTRY[type]?.category === 'audio'
                ? (unit.audio ?? clip)
                : (unit.visual ?? clip);
            run(
              {
                type: 'addEffect',
                owner: { kind: 'clip', clipId: target.id },
                effectType: type,
                params: defaultParams(type),
              },
              `Add ${EFFECT_REGISTRY[type]?.label ?? type}`,
            );
          }}
        >
          <option value="">Add effect…</option>
          {listEffects()
            .filter((definition) =>
              definition.category === 'audio' ? Boolean(unit.audio) : Boolean(unit.visual),
            )
            .map((definition) => (
              <option key={definition.type} value={definition.type}>
                {definition.label}
              </option>
            ))}
        </select>
      </div>
    </>
  );
}

interface ControlProps {
  setParam: (key: ClipParamKey, value: number, label: string) => void;
  onCommit: () => void;
}

function VisualControls({
  clip,
  setParam,
  onCommit,
}: ControlProps & { clip: VideoClip | TitleClip | SolidClip }): React.JSX.Element {
  const run = useStudio((s) => s.run);
  const { transform } = clip;
  // Generated layers already fill the frame, so there is no source to crop into.
  const framed: VideoClip | null = isSyntheticClip(clip) ? null : clip;
  // Blending, though, is the point of a fill: a colour over footage is a tint.
  const blended: VideoClip | SolidClip | null = clip.kind === 'title' ? null : clip;

  return (
    <>
      <Slider
        label="Opacity"
        neutral={1}
        neutralSnapSteps={4}
        value={staticValue(clip.opacity, 1)}
        min={0}
        max={1}
        step={0.01}
        format={(v) => formatPercent(v * 100)}
        onChange={(value) => setParam('opacity', value, 'Set opacity')}
        onCommit={onCommit}
      />
      <Slider
        label="Scale"
        // 0 to 200%, so 100% lands in the middle of the travel rather than a quarter
        // of the way along — the same reason the volume sliders are counted in
        // percent. Caps enlargement at 2x, which is already past where upscaling
        // stops looking like anything.
        neutral={1}
        neutralSnapSteps={4}
        value={staticValue(transform.scaleX, 1)}
        min={0}
        max={2}
        step={0.01}
        format={(v) => formatPercent(v * 100)}
        onChange={(value) => {
          setParam('transform.scaleX', value, 'Set scale');
          setParam('transform.scaleY', value, 'Set scale');
        }}
        onCommit={onCommit}
      />
      <Slider
        label="Position X"
        neutral={0}
        value={staticValue(transform.x, 0)}
        min={-1920}
        max={1920}
        step={1}
        unit=" px"
        precisionInput
        onChange={(value) => setParam('transform.x', value, 'Move layer')}
        onCommit={onCommit}
      />
      <Slider
        label="Position Y"
        neutral={0}
        value={staticValue(transform.y, 0)}
        min={-1080}
        max={1080}
        step={1}
        unit=" px"
        precisionInput
        onChange={(value) => setParam('transform.y', value, 'Move layer')}
        onCommit={onCommit}
      />
      <Slider
        label="Rotation"
        neutral={0}
        neutralSnapSteps={4}
        value={staticValue(transform.rotation, 0)}
        min={-180}
        max={180}
        step={0.5}
        unit="°"
        precisionInput
        onChange={(value) => setParam('transform.rotation', value, 'Rotate layer')}
        onCommit={onCommit}
      />

      {framed && (
        <>
          <Slider
            label="Crop left"
            neutral={0}
            value={staticValue(framed.crop.left, 0)}
            min={0}
            max={0.49}
            step={0.005}
            format={(v) => formatPercent(v * 100)}
        onChange={(value) => setParam('crop.left', value, 'Crop')}
            onCommit={onCommit}
          />
          <Slider
            label="Crop right"
            neutral={0}
            value={staticValue(framed.crop.right, 0)}
            min={0}
            max={0.49}
            step={0.005}
            format={(v) => formatPercent(v * 100)}
        onChange={(value) => setParam('crop.right', value, 'Crop')}
            onCommit={onCommit}
          />
        </>
      )}

      {clip.kind === 'solid' && (
        <div className="field">
          <label>Fill</label>
          <div className="value-row">
            <input
              type="color"
              value={cssHex(clip.fill)}
              onChange={(event) =>
                run(
                  { type: 'setSolidFill', clipId: clip.id, fill: event.target.value },
                  'Set fill',
                )
              }
            />
            <span className="hint">{clip.fill}</span>
          </div>
        </div>
      )}

      {blended && (
        <div className="field">
          <label>Blend mode</label>
          <select
            value={blended.blendMode}
            onChange={(event) =>
              run(
                {
                  type: 'setClipBlendMode',
                  clipId: blended.id,
                  blendMode: event.target.value as BlendMode,
                },
                'Set blend mode',
              )
            }
          >
            {BLEND_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </div>
      )}
    </>
  );
}

/**
 * Best-effort hex for `<input type="color">`, which accepts nothing else.
 * The model keeps the author's original string, so `rebeccapurple` still renders.
 */
function cssHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return '#000000';
  ctx.fillStyle = '#000000';
  ctx.fillStyle = color;
  const resolved = ctx.fillStyle;
  return typeof resolved === 'string' && resolved.startsWith('#') ? resolved : '#000000';
}

function AudioControls({
  clip,
  setParam,
  onCommit,
}: ControlProps & { clip: AudioClip }): React.JSX.Element {
  const run = useStudio((s) => s.run);

  return (
    <>
      <Slider
        label="Gain"
        neutral={GAIN_PERCENT_UNITY}
        neutralSnapSteps={5}
        value={Math.round(gainDbToPercent(staticValue(clip.gainDb, 0)))}
        min={0}
        max={GAIN_PERCENT_MAX}
        step={1}
        format={formatPercent}
        detail={(percent) => formatGain(percentToGainDb(percent))}
        onChange={(percent) => setParam('gainDb', percentToGainDb(percent), 'Set gain')}
        onCommit={onCommit}
      />
      <Slider
        label="Pan"
        neutral={0}
        neutralSnapSteps={4}
        value={staticValue(clip.pan, 0)}
        min={-1}
        max={1}
        step={0.01}
        format={formatPan}
        onChange={(value) => setParam('pan', value, 'Set pan')}
        onCommit={onCommit}
      />
      <Slider
        label="Fade in"
        neutral={0}
        value={T.toSeconds(clip.fadeIn)}
        min={0}
        max={5}
        step={0.05}
        unit=" s"
        onChange={(value) =>
          run(
            { type: 'setClipFade', clipId: clip.id, edge: 'in', duration: T.fromSeconds(value, 1000) },
            'Set fade in',
            `fadein:${clip.id}`,
          )
        }
        onCommit={onCommit}
      />
      <Slider
        label="Fade out"
        neutral={0}
        value={T.toSeconds(clip.fadeOut)}
        min={0}
        max={5}
        step={0.05}
        unit=" s"
        onChange={(value) =>
          run(
            { type: 'setClipFade', clipId: clip.id, edge: 'out', duration: T.fromSeconds(value, 1000) },
            'Set fade out',
            `fadeout:${clip.id}`,
          )
        }
        onCommit={onCommit}
      />
    </>
  );
}

function EffectCard({ effect }: { effect: EffectInstance }): React.JSX.Element {
  const run = useStudio((s) => s.run);
  const endGesture = useStudio((s) => s.endGesture);
  const definition = effectDefinition(effect.effectType);

  return (
    <div className="effect-card">
      <div className="effect-head">
        <span>{definition?.label ?? effect.effectType}</span>
        <span className="spacer" />
        <button
          className={`icon${effect.enabled ? ' on' : ''}`}
          title="Toggle effect"
          onClick={() =>
            run(
              { type: 'setEffectEnabled', effectId: effect.id, enabled: !effect.enabled },
              'Toggle effect',
            )
          }
        >
          {effect.enabled ? 'On' : 'Off'}
        </button>
        <button
          className="icon"
          title="Remove effect"
          onClick={() => run({ type: 'removeEffect', effectId: effect.id }, 'Remove effect')}
        >
          ×
        </button>
      </div>

      {definition &&
        Object.entries(definition.params).map(([key, schema]) => {
          const param = effect.params[key];
          const value =
            param?.kind === 'static' && typeof param.value === 'number'
              ? param.value
              : schema.default;
          return (
            <Slider
              key={key}
              label={schema.label}
              value={value}
              min={schema.min}
              max={schema.max}
              step={schema.step}
              unit={schema.unit ? ` ${schema.unit}` : ''}
              // The registry already declares what each parameter means by default,
              // so every effect control gets its mark without knowing about any of them.
              neutral={schema.default}
              neutralSnapSteps={4}
              onChange={(next) =>
                run(
                  { type: 'setEffectParam', effectId: effect.id, key, param: staticParam(next) },
                  `Set ${schema.label}`,
                  `param:${effect.id}:${key}`,
                )
              }
              onCommit={endGesture}
            />
          );
        })}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  format,
  detail,
  neutral,
  neutralSnapSteps = 0,
  precisionInput = false,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /**
   * Overrides the readout without touching the track.
   *
   * The slider's own value stays in whatever unit the document stores, so the
   * spacing of the travel is unchanged — only the number under it is translated.
   * That matters for gain: decibels are already logarithmic, and re-scaling the
   * track to percent would crowd every quiet adjustment into its bottom sliver.
   */
  format?: (value: number) => string;
  /** Fuller value for the readout's tooltip, where there is room for both units. */
  detail?: (value: number) => string;
  /**
   * The value this control is expected to sit at — unity, centre, none.
   *
   * Marked on the track so it is obvious both that a parameter has been changed and
   * where it came from. Omitted where there is no such value: a duration or a
   * position has no natural resting point to point at.
   */
  neutral?: number;
  /** Pointer detent around neutral, measured in slider steps. */
  neutralSnapSteps?: number;
  /** Adds typed entry where the range contains more precision than dragging can expose. */
  precisionInput?: boolean;
  onChange: (value: number) => void;
  onCommit: () => void;
}): React.JSX.Element {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0;
  const renderValue = format ?? ((next: number) => `${next.toFixed(decimals)}${unit}`);

  const commitTyped = (raw: string): void => {
    const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
    if (Number.isFinite(parsed)) onChange(quantizeRangeValue(parsed, min, max, step));
    setDraft(null);
    onCommit();
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="value-row">
        <Fader
          id={id}
          min={min}
          max={max}
          step={step}
          value={value}
          neutralSnapSteps={neutralSnapSteps}
          format={renderValue}
          onChange={onChange}
          onCommit={onCommit}
          {...(neutral === undefined
            ? {}
            : { neutral, onReset: () => onChange(neutral) })}
        />
        {precisionInput ? (
          <input
            className="range-number"
            type="number"
            min={min}
            max={max}
            step={step}
            value={draft ?? value.toFixed(decimals)}
            aria-label={`${label} value`}
            {...(detail ? { title: detail(value) } : {})}
            onFocus={() => setDraft(String(value))}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commitTyped(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.currentTarget.value = String(value);
                event.currentTarget.blur();
              }
              event.stopPropagation();
            }}
          />
        ) : (
          <output {...(detail ? { title: detail(value) } : {})}>{renderValue(value)}</output>
        )}
      </div>
    </div>
  );
}
