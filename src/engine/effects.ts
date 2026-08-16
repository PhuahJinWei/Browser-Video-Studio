/**
 * Effect registry.
 *
 * The document stores only `effectType` + params; this is where an effect type gains
 * meaning. Each entry declares its parameters (for the inspector to build controls
 * from) and how they fold into the compositor's per-layer uniforms.
 *
 * Adding an effect means adding an entry here plus, if it needs its own pass, a branch
 * in the compositor — the document format never changes.
 */

import { evalNumber } from '../model/params';
import type { EffectInstance, Param, ParamValue, Time } from '../model/types';

export interface NumberParamSchema {
  readonly kind: 'number';
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  /** Value that means "no change", for the reset button. */
  readonly neutral: number;
  readonly unit?: string;
}

export type ParamSchema = NumberParamSchema;

export interface EffectDefinition {
  readonly type: string;
  readonly label: string;
  readonly category: 'colour' | 'blur' | 'transform' | 'audio';
  readonly params: Readonly<Record<string, ParamSchema>>;
}

function number(
  label: string,
  min: number,
  max: number,
  def: number,
  step = 0.01,
  unit?: string,
): NumberParamSchema {
  return { kind: 'number', label, min, max, step, default: def, neutral: def, ...(unit ? { unit } : {}) };
}

export const EFFECT_REGISTRY: Readonly<Record<string, EffectDefinition>> = {
  'color.basic': {
    type: 'color.basic',
    label: 'Colour',
    category: 'colour',
    params: {
      brightness: number('Brightness', -1, 1, 0),
      contrast: number('Contrast', -1, 1, 0),
      saturation: number('Saturation', -1, 1, 0),
      exposure: number('Exposure', -2, 2, 0, 0.01, 'stops'),
    },
  },
  'blur.gaussian': {
    type: 'blur.gaussian',
    label: 'Gaussian blur',
    category: 'blur',
    params: {
      radius: number('Radius', 0, 100, 0, 0.5, 'px'),
    },
  },
  'audio.gain': {
    type: 'audio.gain',
    label: 'Gain',
    category: 'audio',
    params: {
      gainDb: number('Gain', -60, 12, 0, 0.1, 'dB'),
    },
  },
};

export function effectDefinition(type: string): EffectDefinition | undefined {
  return EFFECT_REGISTRY[type];
}

export function listEffects(category?: EffectDefinition['category']): readonly EffectDefinition[] {
  const all = Object.values(EFFECT_REGISTRY);
  return category ? all.filter((e) => e.category === category) : all;
}

/** Default parameter map for a new instance of an effect. */
export function defaultParams(type: string): Readonly<Record<string, Param<ParamValue>>> {
  const definition = effectDefinition(type);
  if (!definition) return {};
  const out: Record<string, Param<ParamValue>> = {};
  for (const [key, schema] of Object.entries(definition.params)) {
    out[key] = { kind: 'static', value: schema.default };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Folding an effect stack into compositor uniforms
// ---------------------------------------------------------------------------

/** Everything the compositor needs to know about a layer's effects. */
export interface LayerEffectState {
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly exposure: number;
  readonly blurRadius: number;
}

export const NEUTRAL_EFFECTS: LayerEffectState = Object.freeze({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  blurRadius: 0,
});

function readNumber(
  effect: EffectInstance,
  key: string,
  at: Time,
  fallback: number,
): number {
  const param = effect.params[key];
  if (!param) return fallback;
  try {
    return evalNumber(param as Param<number>, at);
  } catch {
    return fallback;
  }
}

/**
 * Collapse an ordered effect stack into uniforms.
 *
 * Colour adjustments accumulate, blur radii add. Effects the registry does not know
 * are ignored rather than throwing, so an older project still opens after an effect
 * is renamed.
 */
export function foldEffects(
  effects: readonly EffectInstance[],
  at: Time,
  base: LayerEffectState = NEUTRAL_EFFECTS,
): LayerEffectState {
  let { brightness, contrast, saturation, exposure, blurRadius } = base;

  for (const effect of effects) {
    if (!effect.enabled) continue;
    switch (effect.effectType) {
      case 'color.basic':
        brightness += readNumber(effect, 'brightness', at, 0);
        contrast += readNumber(effect, 'contrast', at, 0);
        saturation += readNumber(effect, 'saturation', at, 0);
        exposure += readNumber(effect, 'exposure', at, 0);
        break;
      case 'blur.gaussian':
        blurRadius += Math.max(0, readNumber(effect, 'radius', at, 0));
        break;
      default:
        break;
    }
  }

  return { brightness, contrast, saturation, exposure, blurRadius };
}

/** Total gain in dB contributed by an audio effect stack. */
export function foldAudioGainDb(effects: readonly EffectInstance[], at: Time): number {
  let gainDb = 0;
  for (const effect of effects) {
    if (effect.enabled && effect.effectType === 'audio.gain') {
      gainDb += readNumber(effect, 'gainDb', at, 0);
    }
  }
  return gainDb;
}
