/**
 * Entity id generation.
 *
 * Commands take an `IdSource` rather than calling `crypto.randomUUID()` internally,
 * so that `apply()` stays deterministic for a given source. Tests use
 * `sequentialIdSource()`; a future collaboration layer would record the ids a command
 * consumed so peers can replay it identically.
 */

import type {
  AssetId,
  ClipId,
  EffectInstanceId,
  MarkerId,
  ProjectId,
  SequenceId,
  TrackId,
  TransitionId,
} from './types';

function uuid(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Ids only need to be unique within one document, so a weak fallback is fine.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export interface IdSource {
  project(): ProjectId;
  asset(): AssetId;
  sequence(): SequenceId;
  track(): TrackId;
  clip(): ClipId;
  effect(): EffectInstanceId;
  transition(): TransitionId;
  marker(): MarkerId;
}

/** Production id source: random and globally unique. */
export const randomIdSource: IdSource = {
  project: () => `pr_${uuid()}` as ProjectId,
  asset: () => `as_${uuid()}` as AssetId,
  sequence: () => `sq_${uuid()}` as SequenceId,
  track: () => `tr_${uuid()}` as TrackId,
  clip: () => `cl_${uuid()}` as ClipId,
  effect: () => `ef_${uuid()}` as EffectInstanceId,
  transition: () => `ts_${uuid()}` as TransitionId,
  marker: () => `mk_${uuid()}` as MarkerId,
};

/**
 * Deterministic id source: `cl_1`, `cl_2`, … Used by tests and by any code path
 * that needs reproducible output (fixtures, replay, golden files).
 */
export function sequentialIdSource(prefix = ''): IdSource {
  const counters = new Map<string, number>();
  const next = (kind: string): string => {
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    return `${prefix}${kind}_${n}`;
  };
  return {
    project: () => next('pr') as ProjectId,
    asset: () => next('as') as AssetId,
    sequence: () => next('sq') as SequenceId,
    track: () => next('tr') as TrackId,
    clip: () => next('cl') as ClipId,
    effect: () => next('ef') as EffectInstanceId,
    transition: () => next('ts') as TransitionId,
    marker: () => next('mk') as MarkerId,
  };
}
