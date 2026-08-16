/**
 * Display formatting shared across panels.
 *
 * Presentation only — nothing here is ever stored. The document keeps gain in
 * decibels because that is what the mixer applies; these turn it into something a
 * reader who has never met a decibel can act on.
 */

/**
 * Below this the mixer treats a fader as silence outright.
 *
 * Mirrors `dbToGain` in the audio engine. The formula alone would put -60 dB at 0.1%
 * rather than nothing, and a readout that disagreed with what you can hear would be
 * worse than no readout at all.
 */
const GAIN_FLOOR_DB = -60;

/** Gain as a proportion of unity, where 0 dB is 100. */
export function gainDbToPercent(db: number): number {
  if (db <= GAIN_FLOOR_DB) return 0;
  return 10 ** (db / 20) * 100;
}

/**
 * Gain as a percentage, for the controls people reach for first.
 *
 * Decibels are a ratio on a log scale: -6 dB means half as loud, which is not
 * something the number itself tells you. A percentage is immediately actionable —
 * 100 is untouched, 50 is half, 200 is twice.
 *
 * A decimal appears below 10%, because decibels crowd the bottom of the range: from
 * -40 dB down, whole percentages would all round to zero and the readout would sit
 * still while the fader was plainly moving.
 */
export function formatGainPercent(db: number): string {
  const percent = gainDbToPercent(db);
  if (percent === 0) return '0%';
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/**
 * Percentage first, decibels after.
 *
 * For tooltips, which have room for both. The pairing is what lets someone move
 * between these controls and the inspector — which stays in decibels, being the
 * surface for precise and keyframable values — without the two appearing to
 * disagree about the same parameter.
 */
export function formatGain(db: number): string {
  return `${formatGainPercent(db)} (${db > 0 ? '+' : ''}${db.toFixed(1)} dB)`;
}
