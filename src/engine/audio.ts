/**
 * Audio mixing and playback.
 *
 * Mixing runs in an `OfflineAudioContext`: source buffers are scheduled through gain
 * and pan nodes and rendered offline. That buys correct resampling, sample-accurate
 * scheduling and cheap fade automation, and — because playback and export call the
 * *same* function — the audio you hear is bit-identical to the audio you get.
 *
 * (docs/ARCHITECTURE.md originally specified a hand-written mixer feeding an
 * AudioWorklet. Offline rendering gives the same determinism for far less code; the
 * worklet is only needed if we later want live input or effects that must run in the
 * audio thread.)
 */

import { evalNumber } from '../model/params';
import {
  audioSegments,
  getSequence,
  type SegmentCrossfade,
} from '../model/selectors';
import * as T from '../model/time';
import type { Project, SequenceId, Time, TimeRange } from '../model/types';
import { foldAudioGainDb } from './effects';
import type { MediaLibrary } from './media';

const AUTOMATION_STEP_SECONDS = 0.01;

function dbToGain(db: number): number {
  return db <= -60 ? 0 : 10 ** (db / 20);
}

/**
 * Render a timeline range to a stereo buffer at the sequence's sample rate.
 * Returns null when the range is empty.
 */
export async function renderAudioRange(
  project: Project,
  sequenceId: SequenceId,
  range: TimeRange,
  media: MediaLibrary,
): Promise<AudioBuffer | null> {
  const sequence = getSequence(project, sequenceId);
  const { sampleRate, channels } = sequence;
  const frameCount = T.ceilSamples(range.duration, sampleRate);
  if (frameCount <= 0) return null;

  const context = new OfflineAudioContext(channels, frameCount, sampleRate);
  const master = context.createGain();
  master.gain.value = dbToGain(evalNumber(sequence.masterGainDb, range.start));
  master.connect(context.destination);

  const segments = audioSegments(project, sequenceId, range);
  await Promise.all(
    segments.map(async (segment) => {
      const { clip } = segment;
      const speed = clip.speed || 1;
      const segmentDuration = segment.timelineRange.duration;

      // Source span this segment consumes.
      const sourceSpan = speed === 1 ? segmentDuration : T.scale(segmentDuration, Math.abs(speed));
      const sourceBuffer = await collectSource(
        media,
        clip.assetId,
        segment.sourceStart,
        T.add(segment.sourceStart, sourceSpan),
        context,
      );
      if (!sourceBuffer) return;

      const source = context.createBufferSource();
      source.buffer = sourceBuffer;
      source.playbackRate.value = Math.abs(speed);

      const gain = context.createGain();
      const panner = context.createStereoPanner();
      source.connect(gain).connect(panner).connect(master);

      // Offset of this segment within the rendered range.
      const offsetSeconds = Math.max(0, T.toSeconds(T.sub(segment.timelineRange.start, range.start)));
      const durationSeconds = T.toSeconds(segmentDuration);

      applyGainAutomation(gain, panner, project, segment, offsetSeconds, durationSeconds);
      source.start(offsetSeconds, 0, durationSeconds);
    }),
  );

  return context.startRendering();
}

function applyGainAutomation(
  gain: GainNode,
  panner: StereoPannerNode,
  project: Project,
  segment: ReturnType<typeof audioSegments>[number],
  offsetSeconds: number,
  durationSeconds: number,
): void {
  const { clip } = segment;
  const track = project.tracks[segment.trackId];

  const clipEffectGain = foldAudioGainDb(segment.effects, T.TIME_ZERO);
  const trackEffectGain = foldAudioGainDb(segment.trackEffects, T.TIME_ZERO);
  const trackGainDb = track ? evalNumber(track.gainDb, T.TIME_ZERO) : 0;
  const trackPan = track ? evalNumber(track.pan, T.TIME_ZERO) : 0;

  /**
   * Where a transition puts this clip on its curve.
   *
   * Both sides ramp, unlike the video dissolve: audio *sums* where video
   * composites one layer over another.
   *
   * Which ramp depends on how alike the two signals are, and no single curve is
   * right for both cases:
   *
   *  - equal power (cos/sin) holds the summed *power* constant, which is what
   *    two different shots need — at 0.5 each they would sum to about −3 dB of
   *    perceived level, an audible dip mid-fade.
   *  - linear holds the summed *amplitude* constant, which is what identical or
   *    highly correlated material needs — there equal power adds up to +3 dB in
   *    the middle instead.
   */
  const crossfadeGain = (
    crossfade: SegmentCrossfade,
    timeline: Time,
    rising: boolean,
  ): number => {
    const { span } = crossfade;
    const progress = Math.min(1, Math.max(0, T.ratio(T.sub(timeline, span.start), span.duration)));
    if (crossfade.curve === 'linear') return rising ? progress : 1 - progress;

    const quarterTurn = (progress * Math.PI) / 2;
    return rising ? Math.sin(quarterTurn) : Math.cos(quarterTurn);
  };

  /** Combined gain at a timeline time, including fades. */
  const gainAt = (timeline: Time): number => {
    const relative = T.sub(timeline, clip.start);
    const clipDb = evalNumber(clip.gainDb, relative);
    let value = dbToGain(clipDb + clipEffectGain + trackGainDb + trackEffectGain);

    if (segment.crossfadeIn) value *= crossfadeGain(segment.crossfadeIn, timeline, true);
    if (segment.crossfadeOut) value *= crossfadeGain(segment.crossfadeOut, timeline, false);

    // Fades are linear on amplitude, measured from the clip's own edges.
    if (T.isPositive(clip.fadeIn)) {
      const progress = T.ratio(relative, clip.fadeIn);
      if (progress < 1) value *= Math.max(0, progress);
    }
    if (T.isPositive(clip.fadeOut)) {
      const fromEnd = T.sub(clip.duration, relative);
      const progress = T.ratio(fromEnd, clip.fadeOut);
      if (progress < 1) value *= Math.max(0, progress);
    }
    return value;
  };

  const panAt = (timeline: Time): number => {
    const relative = T.sub(timeline, clip.start);
    return Math.max(-1, Math.min(1, evalNumber(clip.pan, relative) + trackPan));
  };

  const startTime = segment.timelineRange.start;
  const isAnimated =
    clip.gainDb.kind === 'keyframed' ||
    clip.pan.kind === 'keyframed' ||
    T.isPositive(clip.fadeIn) ||
    T.isPositive(clip.fadeOut) ||
    segment.crossfadeIn !== null ||
    segment.crossfadeOut !== null;

  if (!isAnimated) {
    gain.gain.value = gainAt(startTime);
    panner.pan.value = panAt(startTime);
    return;
  }

  // Step the automation finely enough that fades sound smooth without a node per sample.
  const steps = Math.max(1, Math.ceil(durationSeconds / AUTOMATION_STEP_SECONDS));
  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    const at = T.add(startTime, T.fromSeconds(progress * durationSeconds, 1_000_000));
    const when = offsetSeconds + progress * durationSeconds;
    gain.gain.linearRampToValueAtTime(gainAt(at), when);
    panner.pan.linearRampToValueAtTime(panAt(at), when);
  }
}

/**
 * Assemble decoded source audio covering `[from, to)` into one buffer.
 * Returns null when the asset has no audio in that range.
 */
async function collectSource(
  media: MediaLibrary,
  assetId: Parameters<MediaLibrary['getAudio']>[0],
  from: Time,
  to: Time,
  context: BaseAudioContext,
): Promise<AudioBuffer | null> {
  const fromSeconds = T.toSeconds(from);
  const toSeconds = T.toSeconds(to);
  if (toSeconds <= fromSeconds) return null;

  const chunks: { buffer: AudioBuffer; timestamp: number }[] = [];
  for await (const wrapped of media.audioRange(assetId, from, to)) {
    chunks.push({ buffer: wrapped.buffer, timestamp: wrapped.timestamp });
  }
  const first = chunks[0];
  if (!first) return null;

  const sourceRate = first.buffer.sampleRate;
  const channelCount = first.buffer.numberOfChannels;
  const length = Math.max(1, Math.ceil((toSeconds - fromSeconds) * sourceRate));
  const output = context.createBuffer(channelCount, length, sourceRate);

  for (const { buffer, timestamp } of chunks) {
    const offset = Math.round((timestamp - fromSeconds) * sourceRate);
    for (let channel = 0; channel < channelCount; channel++) {
      const sourceData = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
      const target = output.getChannelData(channel);

      // Clip the copy to the output window; chunks routinely overhang both ends.
      const start = Math.max(0, offset);
      const end = Math.min(length, offset + sourceData.length);
      if (end <= start) continue;
      target.set(sourceData.subarray(start - offset, end - offset), start);
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/** How far ahead of the play head audio is rendered and scheduled. */
const LOOKAHEAD_SECONDS = 0.4;
const CHUNK_SECONDS = 0.2;
const SCHEDULE_INTERVAL_MS = 50;

/**
 * How far the audio clock is trusted.
 *
 * `pending` is the one that matters: an `AudioContext` reports `running` from the
 * moment it is created, but its `currentTime` stays frozen at 0 until the operating
 * system has actually opened the output device -- measured at ~550 ms here, on top
 * of ~440 ms blocked inside the constructor. Anything that treats a frozen clock as
 * a stopped one runs the picture ahead of sound that has not started, then snaps it
 * back when the device wakes.
 */
export type AudioClockState = 'pending' | 'live' | 'blocked';

/**
 * Schedules mixed audio onto an `AudioContext` and exposes the resulting clock.
 *
 * The audio clock is the master during playback: video frames are chosen to match it,
 * never the other way round.
 */
export class AudioPlayer {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private monitorGain = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduled: AudioBufferSourceNode[] = [];

  /** Timeline position that playback began from. */
  private originTimeline: Time = T.TIME_ZERO;
  /** `AudioContext.currentTime` at which that position was heard. */
  private originContext = 0;
  /** Timeline position already rendered up to. */
  private renderedTo: Time = T.TIME_ZERO;
  private generation = 0;
  private running = false;
  private ended = false;

  constructor(
    private readonly media: MediaLibrary,
    private getProject: () => Project,
    private readonly sequenceId: SequenceId,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** True once every scheduled chunk has been consumed and nothing is left to render. */
  get isExhausted(): boolean {
    return this.ended;
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      const sequence = getSequence(this.getProject(), this.sequenceId);
      this.context = new AudioContext({ sampleRate: sequence.sampleRate, latencyHint: 'interactive' });
      this.output = this.context.createGain();
      this.output.gain.value = this.monitorGain;
      this.output.connect(this.context.destination);
    }
    return this.context;
  }

  /**
   * Open the output device before anything needs it.
   *
   * Constructing an `AudioContext` blocks the main thread while the device is
   * acquired, and the clock then takes longer still to start ticking. Doing it at
   * load, and resuming on the first gesture, moves both out of the way of the first
   * press of Play -- which is the only time the user ever saw it.
   */
  async warmUp(): Promise<void> {
    const context = this.ensureContext();
    // Autoplay policy: a context created before any gesture starts suspended, and
    // resume() only succeeds once one has happened. Failing here is expected and
    // costs nothing -- the next call, from the gesture itself, is the one that works.
    if (context.state === 'suspended') await context.resume().catch(() => undefined);
  }

  /**
   * Whether the clock this reports can be believed yet.
   *
   * Distinguishing 'pending' from 'blocked' is the whole point: one is a device that
   * is about to start, the other is one that never will.
   */
  clockState(): AudioClockState {
    if (!this.running || !this.context) return 'blocked';
    if (this.context.state !== 'running') return 'blocked';
    return this.context.currentTime >= this.originContext ? 'live' : 'pending';
  }

  /** Listening level after the project mix. It never changes export audio. */
  setMonitorGain(gain: number): void {
    this.monitorGain = Math.max(0, Math.min(1, gain));
    if (this.context && this.output) {
      this.output.gain.setValueAtTime(this.monitorGain, this.context.currentTime);
    }
  }

  /** Timeline position currently being heard. */
  currentTime(): Time {
    if (!this.running || !this.context) return this.originTimeline;
    const elapsed = this.context.currentTime - this.originContext;
    return T.add(this.originTimeline, T.fromSeconds(Math.max(0, elapsed), 1_000_000));
  }

  async start(from: Time): Promise<void> {
    await this.stop();

    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();

    this.generation++;
    this.running = true;
    this.ended = false;
    this.originTimeline = from;
    this.renderedTo = from;
    // Start slightly in the future so the first chunk is not already late.
    this.originContext = context.currentTime + 0.05;

    await this.pump();
    this.timer = setInterval(() => void this.pump(), SCHEDULE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.generation++;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const node of this.scheduled) {
      try {
        node.stop();
      } catch {
        // Already finished; nothing to cancel.
      }
      node.disconnect();
    }
    this.scheduled = [];
    // The context is deliberately left running. Suspending it releases the output
    // device, and re-acquiring it on the next play costs the same near-second the
    // first one did -- for silence that nobody is listening to in between.
  }

  async close(): Promise<void> {
    await this.stop();
    await this.context?.close();
    this.context = null;
  }

  /** Render and schedule any chunks that fall inside the lookahead window. */
  private async pump(): Promise<void> {
    const context = this.context;
    if (!context || !this.running) return;

    const generation = this.generation;
    const horizon = context.currentTime + LOOKAHEAD_SECONDS;

    while (this.running && this.generation === generation) {
      const chunkStartContext =
        this.originContext + T.toSeconds(T.sub(this.renderedTo, this.originTimeline));
      if (chunkStartContext > horizon) break;

      const duration = T.fromSeconds(CHUNK_SECONDS, 1_000_000);
      const range = T.range(this.renderedTo, duration);

      let buffer: AudioBuffer | null;
      try {
        buffer = await renderAudioRange(this.getProject(), this.sequenceId, range, this.media);
      } catch {
        buffer = null;
      }
      if (this.generation !== generation) return;

      if (buffer) {
        const now = context.currentTime;
        // A chunk that missed its slot has to start part-way in. Starting it whole
        // and late replays material the clock has already passed, and pushes every
        // chunk behind it further out -- the drift compounds rather than recovering.
        const late = now - chunkStartContext;
        if (late < CHUNK_SECONDS) {
          const node = context.createBufferSource();
          node.buffer = buffer;
          node.connect(this.output ?? context.destination);
          if (late > 0) node.start(now, late);
          else node.start(chunkStartContext);
          node.onended = () => {
            this.scheduled = this.scheduled.filter((n) => n !== node);
            node.disconnect();
          };
          this.scheduled.push(node);
        }
      }

      this.renderedTo = T.add(this.renderedTo, duration);
    }
  }
}
