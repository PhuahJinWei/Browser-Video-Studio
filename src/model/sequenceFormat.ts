/**
 * Sequence-format helpers shared by automatic adoption and the Inspector.
 *
 * A reference must be a real video asset. Stills expose a synthetic video stream so
 * they can live on visual tracks, but a photograph must never become the sequence's
 * frame-rate or resolution authority merely because it was imported first.
 */

import * as T from './time';
import type { Asset, AssetId, FrameRate, Project, Sequence, SequenceId, Size } from './types';

/** Most browser encoders use 4:2:0 output and therefore require even dimensions. */
export function encoderSafeSequenceSize(size: Size): Size {
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(size.width), height: even(size.height) };
}

export function sameFrameRate(a: FrameRate, b: FrameRate): boolean {
  return a.num === b.num && a.den === b.den;
}

/** Assets a sequence may deliberately match. Synthetic still streams are excluded. */
export function matchableVideoAssets(project: Project, sequenceId: SequenceId): readonly Asset[] {
  const sequence = project.sequences[sequenceId];
  const all = Object.values(project.assets).filter(
    (asset): asset is Asset & { video: NonNullable<Asset['video']> } =>
      asset.kind === 'video' &&
      asset.video !== null &&
      asset.video.size.width > 0 &&
      asset.video.size.height > 0,
  );
  if (!sequence) return all;

  // Timeline footage is more relevant than something that only happens to be in the
  // library. Sort across tracks by time, then use track order as the stable tie-break.
  const timeline = sequence.videoTrackIds
    .flatMap((trackId, trackIndex) => {
      const track = project.tracks[trackId];
      return (track?.clipIds ?? []).flatMap((clipId, clipIndex) => {
        const clip = project.clips[clipId];
        if (!clip || clip.kind !== 'video') return [];
        const asset = project.assets[clip.assetId];
        if (!asset || asset.kind !== 'video' || !asset.video) return [];
        return [{ asset, start: clip.start, trackIndex, clipIndex }];
      });
    })
    .sort(
      (a, b) =>
        T.cmp(a.start, b.start) || a.trackIndex - b.trackIndex || a.clipIndex - b.clipIndex,
    );

  const ordered: Asset[] = [];
  const seen = new Set<AssetId>();
  for (const { asset } of timeline) {
    if (!seen.has(asset.id)) {
      seen.add(asset.id);
      ordered.push(asset);
    }
  }
  for (const asset of all) {
    if (!seen.has(asset.id)) ordered.push(asset);
  }
  return ordered;
}

/**
 * Resolve the automatic reference without relying on record insertion order.
 * Explicit UI context wins; the ordered candidates provide the timeline-first fallback.
 */
export function preferredSequenceReference(
  project: Project,
  sequenceId: SequenceId,
  preferredAssetIds: readonly (AssetId | null | undefined)[],
): Asset | null {
  const candidates = matchableVideoAssets(project, sequenceId);
  const byId = new Map(candidates.map((asset) => [asset.id, asset]));
  for (const id of preferredAssetIds) {
    if (id && byId.has(id)) return byId.get(id)!;
  }
  return candidates[0] ?? null;
}

/** Values the Match action will actually write. Unknown/VFR footage keeps sequence fps. */
export function settingsForReference(
  sequence: Sequence,
  asset: Asset,
): { readonly size: Size; readonly frameRate: FrameRate } {
  if (asset.kind !== 'video' || !asset.video) {
    throw new Error(`Asset "${asset.name}" is not a matchable video`);
  }
  return {
    size: encoderSafeSequenceSize(asset.video.size),
    frameRate: asset.video.frameRate ?? sequence.frameRate,
  };
}

/** Match every value the action can change, not merely the frame dimensions. */
export function sequenceMatchesReference(sequence: Sequence, asset: Asset): boolean {
  const settings = settingsForReference(sequence, asset);
  return (
    sequence.size.width === settings.size.width &&
    sequence.size.height === settings.size.height &&
    sameFrameRate(sequence.frameRate, settings.frameRate)
  );
}
