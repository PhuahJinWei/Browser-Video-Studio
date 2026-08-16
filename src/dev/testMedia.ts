/**
 * Synthetic test media generator — development only.
 *
 * Not imported by the application, so it never reaches the production bundle. It
 * exists so the editor can be exercised end to end without checking binary fixtures
 * into the repository or requiring ffmpeg on the developer's machine.
 *
 * In the dev server:
 *   const m = await import('/src/dev/testMedia.ts');
 *   await window.__studio.getState().importFiles([await m.makeTestClip()]);
 */

import {
  AudioBufferSource,
  BufferTarget,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSource,
} from 'mediabunny';

export interface TestClipOptions {
  readonly name?: string;
  readonly seconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  /** Base hue in degrees; the clip sweeps 120° from here. */
  readonly hue?: number;
  /** Tone frequency in Hz. 0 disables audio. */
  readonly toneHz?: number;
}

/**
 * A moving-bar test pattern with a burned-in frame counter and a sine tone.
 * The counter makes A/V sync and seek accuracy checkable by eye.
 */
export async function makeTestClip(options: TestClipOptions = {}): Promise<File> {
  const {
    name = 'test-clip.mp4',
    seconds = 6,
    width = 640,
    height = 360,
    fps = 30,
    hue = 210,
    toneHz = 440,
  } = options;

  const totalFrames = Math.round(seconds * fps);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context available');

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const videoSource = new VideoSampleSource({ codec: 'avc', bitrate: 2_000_000 });
  output.addVideoTrack(videoSource, { frameRate: fps });

  const audioSource =
    toneHz > 0 ? new AudioBufferSource({ codec: 'aac', bitrate: new Quality(0.6) }) : null;
  if (audioSource) output.addAudioTrack(audioSource);

  await output.start();

  if (audioSource) {
    const sampleRate = 48000;
    const frames = Math.round(seconds * sampleRate);
    const context = new OfflineAudioContext(2, frames, sampleRate);
    const buffer = context.createBuffer(2, frames, sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      // Detune the right channel so stereo and panning are audible.
      const frequency = toneHz * (channel === 0 ? 1 : 1.5);
      for (let i = 0; i < frames; i++) {
        const t = i / sampleRate;
        // Pulse once a second so the counter and the sound line up.
        const envelope = 0.25 * (0.4 + 0.6 * Math.abs(Math.sin(Math.PI * t)));
        data[i] = Math.sin(2 * Math.PI * frequency * t) * envelope;
      }
    }
    await audioSource.add(buffer);
    audioSource.close();
  }

  for (let index = 0; index < totalFrames; index++) {
    const progress = index / totalFrames;

    ctx.fillStyle = `hsl(${hue + progress * 120} 55% 22%)`;
    ctx.fillRect(0, 0, width, height);

    // Sweeping bar: an obvious motion cue for scrubbing and playback.
    const barX = progress * (width + 120) - 60;
    ctx.fillStyle = `hsl(${hue + 180} 80% 60%)`;
    ctx.fillRect(barX, 0, 60, height);

    // Corner blocks so rotation and crop are easy to verify.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 24, 24);
    ctx.fillStyle = '#ff4040';
    ctx.fillRect(width - 24, height - 24, 24, 24);

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(height / 6)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${index}`, width / 2, height / 2);
    ctx.font = `${Math.round(height / 14)}px monospace`;
    ctx.fillText((index / fps).toFixed(2) + 's', width / 2, height / 2 + height / 5);

    const sample = new VideoSample(canvas, {
      timestamp: index / fps,
      duration: 1 / fps,
    });
    try {
      await videoSource.add(sample);
    } finally {
      sample.close();
    }
  }
  videoSource.close();

  await output.finalize();
  const target = output.target as BufferTarget;
  if (!target.buffer) throw new Error('Muxing produced no output');

  return new File([target.buffer], name, { type: 'video/mp4' });
}
