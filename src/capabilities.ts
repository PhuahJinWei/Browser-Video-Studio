/**
 * Boot-time capability detection.
 *
 * The app targets Chromium-latest and deliberately does not degrade gracefully:
 * a missing capability is reported plainly rather than silently half-working.
 */

import type { OpfsProbeResult } from './opfs-probe.worker';

export type CapabilityLevel = 'ok' | 'missing' | 'degraded';

export interface CapabilityResult {
  readonly id: string;
  readonly label: string;
  readonly level: CapabilityLevel;
  readonly detail: string;
  /** False when the editor genuinely cannot run without it. */
  readonly optional: boolean;
}

// H.264 codec strings are `avc1.PPCCLL` — profile, constraints, level, all hex.
// The level caps the resolution: 0x1f = level 3.1 tops out at 720p, so probing it
// at 1080p is out of spec. 1080p30 needs level 4.0 (0x28) or higher.
const H264_DECODE_1080 = 'avc1.640028'; // High profile, level 4.0
const H264_ENCODE_1080 = 'avc1.42002a'; // Baseline profile, level 4.2 — widest encoder support
const H264_ENCODE_720 = 'avc1.42001f'; // Baseline profile, level 3.1

async function checkWebGPU(): Promise<CapabilityResult> {
  const base = { id: 'webgpu', label: 'WebGPU', optional: false } as const;
  if (!('gpu' in navigator)) {
    return { ...base, level: 'missing', detail: 'navigator.gpu is not available' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ...base, level: 'missing', detail: 'No GPU adapter could be acquired' };
    const info = adapter.info;
    const name = [info.vendor, info.architecture].filter(Boolean).join(' ') || 'adapter available';
    const maxTex = adapter.limits.maxTextureDimension2D;
    return {
      ...base,
      level: maxTex >= 4096 ? 'ok' : 'degraded',
      detail: `${name} · max 2D texture ${maxTex}px`,
    };
  } catch (err) {
    return { ...base, level: 'missing', detail: String(err) };
  }
}

async function checkWebCodecs(): Promise<readonly CapabilityResult[]> {
  const results: CapabilityResult[] = [];

  if (!('VideoDecoder' in globalThis) || !('VideoEncoder' in globalThis)) {
    return [
      {
        id: 'webcodecs',
        label: 'WebCodecs',
        level: 'missing',
        detail: 'VideoDecoder / VideoEncoder are not available',
        optional: false,
      },
    ];
  }

  try {
    const dec = await VideoDecoder.isConfigSupported({
      codec: H264_DECODE_1080,
      codedWidth: 1920,
      codedHeight: 1080,
    });
    results.push({
      id: 'decode.h264',
      label: 'H.264 decode',
      level: dec.supported ? 'ok' : 'missing',
      detail: dec.supported ? '1080p High profile accepted' : 'Not supported by this browser/OS',
      optional: false,
    });
  } catch (err) {
    results.push({
      id: 'decode.h264',
      label: 'H.264 decode',
      level: 'missing',
      detail: String(err),
      optional: false,
    });
  }

  // Chromium ships H.264 *decode* far more widely than H.264 *encode* (the encoder
  // is usually the platform's, and some builds omit it entirely). Fall back to 720p
  // before declaring it missing, so we can tell "no encoder" from "too demanding".
  try {
    const at1080 = await VideoEncoder.isConfigSupported({
      codec: H264_ENCODE_1080,
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      framerate: 30,
    });
    if (at1080.supported) {
      results.push({
        id: 'encode.h264',
        label: 'H.264 encode',
        level: 'ok',
        detail: '1080p @ 8 Mbps accepted',
        optional: false,
      });
    } else {
      const at720 = await VideoEncoder.isConfigSupported({
        codec: H264_ENCODE_720,
        width: 1280,
        height: 720,
        bitrate: 4_000_000,
        framerate: 30,
      });
      results.push({
        id: 'encode.h264',
        label: 'H.264 encode',
        level: at720.supported ? 'degraded' : 'missing',
        detail: at720.supported
          ? '720p only — no 1080p encoder on this platform'
          : 'No H.264 encoder; MP4 export unavailable (WebM/VP9 may still work)',
        // Not fatal on its own: WebM/VP9 or WebM/Opus export can still carry a project.
        optional: true,
      });
    }
  } catch (err) {
    results.push({
      id: 'encode.h264',
      label: 'H.264 encode',
      level: 'missing',
      detail: String(err),
      optional: true,
    });
  }

  // A project needs *some* encoder. VP9 in WebM is the software-backed fallback.
  try {
    const vp9 = await VideoEncoder.isConfigSupported({
      codec: 'vp09.00.10.08',
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      framerate: 30,
    });
    results.push({
      id: 'encode.vp9',
      label: 'VP9 encode',
      level: vp9.supported ? 'ok' : 'missing',
      detail: vp9.supported ? '1080p WebM export available' : 'Not supported by this browser',
      optional: true,
    });
  } catch (err) {
    results.push({
      id: 'encode.vp9',
      label: 'VP9 encode',
      level: 'missing',
      detail: String(err),
      optional: true,
    });
  }

  const audio: CapabilityResult = {
    id: 'webcodecs.audio',
    label: 'Audio codecs',
    level: 'AudioDecoder' in globalThis && 'AudioEncoder' in globalThis ? 'ok' : 'missing',
    detail:
      'AudioDecoder' in globalThis && 'AudioEncoder' in globalThis
        ? 'AudioDecoder and AudioEncoder present'
        : 'AudioDecoder / AudioEncoder are not available',
    optional: false,
  };
  results.push(audio);

  return results;
}

/** Run the OPFS probe in a worker, since sync access handles are worker-only. */
function runOpfsProbe(): Promise<OpfsProbeResult> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./opfs-probe.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      resolve({ writable: false, sync: false, error: String(err) });
      return;
    }
    const done = (result: OpfsProbeResult) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => done({ writable: false, sync: false, error: 'Probe timed out' }), 5000);
    worker.addEventListener('message', (e: MessageEvent<OpfsProbeResult>) => done(e.data));
    worker.addEventListener('error', (e) => done({ writable: false, sync: false, error: e.message }));
    worker.postMessage('probe');
  });
}

async function checkOpfs(): Promise<CapabilityResult> {
  const base = { id: 'opfs', label: 'Origin Private File System', optional: false } as const;
  if (!navigator.storage?.getDirectory) {
    return { ...base, level: 'missing', detail: 'navigator.storage.getDirectory is not available' };
  }

  const result = await runOpfsProbe();
  if (!result.writable) {
    return { ...base, level: 'missing', detail: result.error ?? 'OPFS is not writable' };
  }

  const estimate = await navigator.storage.estimate?.().catch(() => undefined);
  const quotaGb = estimate?.quota ? `${(estimate.quota / 1e9).toFixed(1)} GB` : 'unknown';
  return {
    ...base,
    level: result.sync ? 'ok' : 'degraded',
    detail: result.sync
      ? `Sync access handles available · ~${quotaGb} quota`
      : `Writable but no sync access handles (slow path) · ~${quotaGb} quota`,
  };
}

function checkMisc(): readonly CapabilityResult[] {
  const results: CapabilityResult[] = [];

  results.push({
    id: 'worker',
    label: 'Module workers',
    level: typeof Worker !== 'undefined' ? 'ok' : 'missing',
    detail: typeof Worker !== 'undefined' ? 'Available' : 'Worker is not defined',
    optional: false,
  });

  results.push({
    id: 'audioworklet',
    label: 'AudioWorklet',
    level: typeof AudioWorkletNode !== 'undefined' ? 'ok' : 'missing',
    detail:
      typeof AudioWorkletNode !== 'undefined'
        ? 'Available (used as the master playback clock)'
        : 'AudioWorkletNode is not defined',
    optional: false,
  });

  results.push({
    id: 'offscreencanvas',
    label: 'OffscreenCanvas',
    level: typeof OffscreenCanvas !== 'undefined' ? 'ok' : 'missing',
    detail: typeof OffscreenCanvas !== 'undefined' ? 'Available' : 'OffscreenCanvas is not defined',
    optional: false,
  });

  results.push({
    id: 'fsaccess',
    label: 'File System Access',
    level: 'showOpenFilePicker' in globalThis ? 'ok' : 'degraded',
    detail:
      'showOpenFilePicker' in globalThis
        ? 'Can reference files in place and save exports directly'
        : 'Falling back to <input type=file> and download-based export',
    optional: true,
  });

  results.push({
    id: 'coi',
    label: 'Cross-origin isolation',
    level: globalThis.crossOriginIsolated ? 'ok' : 'degraded',
    detail: globalThis.crossOriginIsolated
      ? 'SharedArrayBuffer available'
      : 'No SharedArrayBuffer — not required before L3 (WASM codec fallback)',
    optional: true,
  });

  return results;
}

/**
 * Individual encoders are optional, but having *none* is fatal — you could edit
 * and never export. Derive that as its own required capability.
 */
function deriveExportCapability(codecs: readonly CapabilityResult[]): CapabilityResult {
  const encoders = codecs.filter((c) => c.id.startsWith('encode.') && c.level !== 'missing');
  const names = encoders.map((c) => c.label.replace(' encode', ''));
  return {
    id: 'export',
    label: 'Video export',
    level: encoders.length > 0 ? 'ok' : 'missing',
    detail:
      encoders.length > 0
        ? `Available via ${names.join(', ')}`
        : 'No video encoder at all — export would be impossible',
    optional: false,
  };
}

/** Run every check. Order is stable so the UI does not jump around. */
export async function detectCapabilities(): Promise<readonly CapabilityResult[]> {
  const [gpu, codecs, opfs] = await Promise.all([checkWebGPU(), checkWebCodecs(), checkOpfs()]);
  return [gpu, ...codecs, deriveExportCapability(codecs), opfs, ...checkMisc()];
}

/** True when every non-optional capability is usable. */
export function canRun(results: readonly CapabilityResult[]): boolean {
  return results.every((r) => r.optional || r.level !== 'missing');
}
