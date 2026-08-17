import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
} from 'mediabunny';
import type { Size } from '../model/types';

export interface ProxyResult {
  readonly blob: Blob;
  readonly size: Size;
  readonly codec: 'vp9' | 'avc';
}

/** Generate a lightweight, seek-friendly 720p-or-smaller editing proxy. */
export async function generateProxy(
  source: Blob,
  sourceSize: Size,
  options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (fraction: number) => void;
  } = {},
): Promise<ProxyResult> {
  const maxHeight = 720;
  const scale = Math.min(1, maxHeight / Math.max(1, sourceSize.height));
  const size = {
    width: Math.max(2, Math.round((sourceSize.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((sourceSize.height * scale) / 2) * 2),
  };

  const vp9 = await VideoEncoder.isConfigSupported({
    codec: 'vp09.00.10.08',
    width: size.width,
    height: size.height,
    bitrate: 2_500_000,
    framerate: 30,
  }).then((result) => result.supported).catch(() => false);
  const codec = vp9 ? 'vp9' as const : 'avc' as const;
  const target = new BufferTarget();
  const output = new Output({
    format: vp9 ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    video: {
      width: size.width,
      height: size.height,
      fit: 'contain',
      codec,
      quality: new Quality(0.52),
      keyFrameInterval: 1,
      forceTranscode: true,
    },
    audio: { discard: true },
    showWarnings: false,
  });
  if (!conversion.isValid) throw new Error('This browser cannot encode the editing proxy.');
  conversion.onProgress = (fraction) => options.onProgress?.(fraction);

  const abort = (): void => void conversion.cancel();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) await conversion.cancel();
    await conversion.execute();
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }

  if (!target.buffer) throw new Error('Proxy encoder produced no output.');
  return {
    blob: new Blob([target.buffer], { type: vp9 ? 'video/webm' : 'video/mp4' }),
    size,
    codec,
  };
}
