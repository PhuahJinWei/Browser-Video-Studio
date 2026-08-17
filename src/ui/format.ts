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

/** The inverse, for controls that are driven in percent. */
export function percentToGainDb(percent: number): number {
  if (percent <= 0) return GAIN_FLOOR_DB;
  return 20 * Math.log10(percent / 100);
}

/**
 * How far a volume control goes, in percent.
 *
 * A volume slider is driven in percent rather than in decibels, and the two must
 * agree about where things are. Spacing the travel in decibels while labelling it in
 * percent put unity at 83% of the way along, made the middle of the slider read 6%,
 * and ended the range at 398% — a number that is neither round nor reachable.
 *
 * Doubling is as far as boosting usefully goes before a recording needs fixing at
 * source, so 200 puts unity in the middle where a reader expects to find it.
 *
 * The cost, stated plainly: percent is linear in amplitude, so everything below
 * -20 dB now lives in the bottom twentieth of the travel. Fine fades are better done
 * in the inspector, where the number is visible and the arrow keys step by one.
 */
export const GAIN_PERCENT_MAX = 200;
export const GAIN_PERCENT_UNITY = 100;

/** A plain percentage, for controls that are already counted in it. */
export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Pan, as a side and an amount.
 *
 * `-0.35` says nothing about which speaker it favours. Naming the side is the whole
 * content of the control, and the number alone was leaving it out.
 */
export function formatPan(value: number): string {
  const amount = Math.round(Math.abs(value) * 100);
  if (amount === 0) return 'Centre';
  return `${value < 0 ? 'L' : 'R'} ${amount}%`;
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
