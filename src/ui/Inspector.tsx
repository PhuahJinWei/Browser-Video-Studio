/**
 * Inspector.
 *
 * Effect controls are generated from the effect registry, so a new effect type gets a
 * UI for free. Every edit goes through a command with a coalesce key, so dragging a
 * slider is one undo step rather than one per pixel.
 */

import { defaultParams, EFFECT_REGISTRY, effectDefinition, listEffects } from '../engine/effects';
import type { Command } from '../model/commands';
import { TRANSITION_LABELS } from './transitions';
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
import { formatGain, formatGainPercent } from './format';
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
        {!transition && !track && !unit && (
          <p className="hint">
            {selected.length > 1
              ? `${selected.length} clips selected.`
              : 'Select a clip, a track header or a transition to edit its properties.'}
          </p>
        )}
        {!transition && !track && unit && <UnitInspector unit={unit} />}
      </div>
    </div>
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
            value={staticValue(track.gainDb, 0)}
            min={-60}
            max={12}
            step={0.5}
            format={formatGainPercent}
            detail={formatGain}
            onChange={(value) => setTrackParam('gainDb', value, 'Set track volume')}
            onCommit={endGesture}
          />
          <Slider
            label="Pan"
            value={staticValue(track.pan, 0)}
            min={-1}
            max={1}
            step={0.01}
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

      <div className="field">
        <label>Height</label>
        <div className="value-row">
          <input
            type="range"
            min={36}
            max={160}
            step={4}
            value={track.height}
            onChange={(event) =>
              run(
                {
                  type: 'setTrackProps',
                  trackId: track.id,
                  props: { height: Number(event.target.value) },
                },
                'Set track height',
                `height:${track.id}`,
              )
            }
            onPointerUp={endGesture}
          />
          <output>{track.height}px</output>
        </div>
      </div>

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
        value={staticValue(clip.opacity, 1)}
        min={0}
        max={1}
        step={0.01}
        onChange={(value) => setParam('opacity', value, 'Set opacity')}
        onCommit={onCommit}
      />
      <Slider
        label="Scale"
        value={staticValue(transform.scaleX, 1)}
        min={0.05}
        max={4}
        step={0.01}
        unit="×"
        onChange={(value) => {
          setParam('transform.scaleX', value, 'Set scale');
          setParam('transform.scaleY', value, 'Set scale');
        }}
        onCommit={onCommit}
      />
      <Slider
        label="Position X"
        value={staticValue(transform.x, 0)}
        min={-1920}
        max={1920}
        step={1}
        unit=" px"
        onChange={(value) => setParam('transform.x', value, 'Move layer')}
        onCommit={onCommit}
      />
      <Slider
        label="Position Y"
        value={staticValue(transform.y, 0)}
        min={-1080}
        max={1080}
        step={1}
        unit=" px"
        onChange={(value) => setParam('transform.y', value, 'Move layer')}
        onCommit={onCommit}
      />
      <Slider
        label="Rotation"
        value={staticValue(transform.rotation, 0)}
        min={-180}
        max={180}
        step={0.5}
        unit="°"
        onChange={(value) => setParam('transform.rotation', value, 'Rotate layer')}
        onCommit={onCommit}
      />

      {framed && (
        <>
          <Slider
            label="Crop left"
            value={staticValue(framed.crop.left, 0)}
            min={0}
            max={0.49}
            step={0.005}
            onChange={(value) => setParam('crop.left', value, 'Crop')}
            onCommit={onCommit}
          />
          <Slider
            label="Crop right"
            value={staticValue(framed.crop.right, 0)}
            min={0}
            max={0.49}
            step={0.005}
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
        value={staticValue(clip.gainDb, 0)}
        min={-60}
        max={12}
        step={0.5}
        format={formatGainPercent}
        detail={formatGain}
        onChange={(value) => setParam('gainDb', value, 'Set gain')}
        onCommit={onCommit}
      />
      <Slider
        label="Pan"
        value={staticValue(clip.pan, 0)}
        min={-1}
        max={1}
        step={0.01}
        onChange={(value) => setParam('pan', value, 'Set pan')}
        onCommit={onCommit}
      />
      <Slider
        label="Fade in"
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
  onChange: (value: number) => void;
  onCommit: () => void;
}): React.JSX.Element {
  const decimals = step < 0.01 ? 3 : step < 1 ? 2 : 0;
  return (
    <div className="field">
      <label>{label}</label>
      <div className="value-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
        />
        <output {...(detail ? { title: detail(value) } : {})}>
          {format ? format(value) : `${value.toFixed(decimals)}${unit}`}
        </output>
      </div>
    </div>
  );
}
