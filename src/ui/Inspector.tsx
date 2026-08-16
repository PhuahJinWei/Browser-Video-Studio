/**
 * Inspector.
 *
 * Effect controls are generated from the effect registry, so a new effect type gets a
 * UI for free. Every edit goes through a command with a coalesce key, so dragging a
 * slider is one undo step rather than one per pixel.
 */

import { defaultParams, EFFECT_REGISTRY, effectDefinition, listEffects } from '../engine/effects';
import type { ClipParamKey } from '../model/commands';
import { staticParam } from '../model/params';
import { isAudioClip, isMediaClip, isVisualClip, selectionUnit } from '../model/selectors';
import * as T from '../model/time';
import type {
  AudioClip,
  BlendMode,
  Clip,
  ClipId,
  EffectInstance,
  Param,
  Project,
  TitleClip,
  Track,
  VideoClip,
} from '../model/types';
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
  const project = history.present.project;
  const track = selectedTrackId ? project.tracks[selectedTrackId] : undefined;

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
        {track && <TrackInspector track={track} />}
        {!track && !unit && (
          <p className="hint">
            {selected.length > 1
              ? `${selected.length} clips selected.`
              : 'Select a clip, or a track header, to edit its properties.'}
          </p>
        )}
        {!track && unit && <UnitInspector unit={unit} />}
      </div>
    </div>
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
            unit=" dB"
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
  readonly visual: VideoClip | TitleClip | null;
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
}: ControlProps & { clip: VideoClip | TitleClip }): React.JSX.Element {
  const run = useStudio((s) => s.run);
  const { transform } = clip;
  // Titles are generated at sequence size, so cropping and blending do not apply.
  const framed: VideoClip | null = clip.kind === 'title' ? null : clip;

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
          <div className="field">
            <label>Blend mode</label>
            <select
              value={framed.blendMode}
              onChange={(event) =>
                run(
                  {
                    type: 'setClipBlendMode',
                    clipId: framed.id,
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
        </>
      )}
    </>
  );
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
        unit=" dB"
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
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
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
        <output>
          {value.toFixed(decimals)}
          {unit}
        </output>
      </div>
    </div>
  );
}
