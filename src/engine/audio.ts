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
import { audioSegments, getSequence } from '../model/selectors';
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

  /** Combined gain at a timeline time, including fades. */
  const gainAt = (timeline: Time): number => {
    const relative = T.sub(timeline, clip.start);
    const clipDb = evalNumber(clip.gainDb, relative);
    let value = dbToGain(clipDb + clipEffectGain + trackGainDb + trackEffectGain);

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
    T.isPositive(clip.fadeOut);

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
 * Schedules mixed audio onto an `AudioContext` and exposes the resulting clock.
 *
 * The audio clock is the master during playback: video frames are chosen to match it,
 * never the other way round.
 */
export class AudioPlayer {
  private context: AudioContext | null = null;
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
    }
    return this.context;
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
    if (this.context && this.context.state === 'running') await this.context.suspend();
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
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(context.destination);
        node.start(Math.max(context.currentTime, chunkStartContext));
        node.onended = () => {
          this.scheduled = this.scheduled.filter((n) => n !== node);
          node.disconnect();
        };
        this.scheduled.push(node);
      }

      this.renderedTo = T.add(this.renderedTo, duration);
    }
  }
}
