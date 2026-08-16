/**
 * WebGPU compositor.
 *
 * Draws a stack of layers into a sequence-sized RGBA texture, then blits that to the
 * canvas (preview) or reads it back as a `VideoFrame` (export). Playback and export
 * share this path so what you see is what you get.
 *
 * Every layer is uploaded into a plain RGBA texture with `copyExternalImageToTexture`
 * — which accepts `VideoFrame` directly and does the YUV→RGB conversion — rather than
 * binding an external texture. That costs one GPU copy per layer but means a single
 * pipeline handles video frames, canvases and bitmaps alike.
 */

import type { BlendMode, Crop, Size, Transform2D } from '../model/types';
import { BLIT_SHADER, BLUR_SHADER, COMPOSITE_SHADER } from './compositor.wgsl';
import { NEUTRAL_EFFECTS, type LayerEffectState } from './effects';

export class CompositorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositorError';
  }
}

/** Anything `copyExternalImageToTexture` accepts as a source. */
export type LayerImage = VideoFrame | ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

export interface DrawLayer {
  readonly image: LayerImage;
  /** Natural size of `image` in pixels. */
  readonly imageSize: Size;
  readonly transform: Transform2D;
  readonly opacity: number;
  readonly crop: Crop;
  readonly blendMode: BlendMode;
  readonly effects: LayerEffectState;
}

const BLEND_MODE_IDS: Readonly<Record<BlendMode, number>> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  add: 4,
  darken: 5,
  lighten: 6,
  difference: 7,
};

const COMPOSITE_FORMAT: GPUTextureFormat = 'rgba8unorm';
/** 16 floats + 2 u32-sized slots, padded to a 256-byte dynamic-offset boundary. */
const LAYER_UNIFORM_SIZE = 256;
const BLUR_UNIFORM_SIZE = 256;

interface PingPong {
  a: GPUTexture;
  b: GPUTexture;
}

export class Compositor {
  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext | null,
    canvasFormat: GPUTextureFormat,
    private size: Size,
  ) {
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.compositeModule = device.createShaderModule({ code: COMPOSITE_SHADER, label: 'composite' });
    this.blurModule = device.createShaderModule({ code: BLUR_SHADER, label: 'blur' });
    this.blitModule = device.createShaderModule({ code: BLIT_SHADER, label: 'blit' });

    this.compositeLayout = device.createBindGroupLayout({
      label: 'composite-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.blurLayout = device.createBindGroupLayout({
      label: 'blur-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.blitLayout = device.createBindGroupLayout({
      label: 'blit-layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });

    this.compositePipeline = device.createRenderPipeline({
      label: 'composite',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module: this.compositeModule, entryPoint: 'vs' },
      fragment: {
        module: this.compositeModule,
        entryPoint: 'fs',
        targets: [{ format: COMPOSITE_FORMAT }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.blurPipeline = device.createRenderPipeline({
      label: 'blur',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blurLayout] }),
      vertex: { module: this.blurModule, entryPoint: 'vs' },
      fragment: { module: this.blurModule, entryPoint: 'fs', targets: [{ format: COMPOSITE_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.blitPipeline = device.createRenderPipeline({
      label: 'blit',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blitLayout] }),
      vertex: { module: this.blitModule, entryPoint: 'vs' },
      fragment: { module: this.blitModule, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });

    this.targets = this.createTargets(size);
  }

  private readonly sampler: GPUSampler;
  private readonly compositeModule: GPUShaderModule;
  private readonly blurModule: GPUShaderModule;
  private readonly blitModule: GPUShaderModule;
  private readonly compositeLayout: GPUBindGroupLayout;
  private readonly blurLayout: GPUBindGroupLayout;
  private readonly blitLayout: GPUBindGroupLayout;
  private readonly compositePipeline: GPURenderPipeline;
  private readonly blurPipeline: GPURenderPipeline;
  private readonly blitPipeline: GPURenderPipeline;

  private targets: PingPong;
  private layerUniforms: GPUBuffer | null = null;
  private blurUniforms: GPUBuffer | null = null;
  private layerUniformCapacity = 0;
  private blurUniformCapacity = 0;
  /** Reusable per-size layer textures, so a steady render loop stops allocating. */
  private readonly texturePool = new Map<string, GPUTexture[]>();
  private destroyed = false;

  /**
   * @param canvas Target surface, or null to render offscreen only (export).
   */
  static async create(canvas: HTMLCanvasElement | OffscreenCanvas | null, size: Size): Promise<Compositor> {
    if (!navigator.gpu) throw new CompositorError('WebGPU is not available in this browser');

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new CompositorError('No suitable GPU adapter');
    const device = await adapter.requestDevice();

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    let context: GPUCanvasContext | null = null;
    if (canvas) {
      context = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!context) throw new CompositorError('Could not acquire a WebGPU canvas context');
      context.configure({ device, format: canvasFormat, alphaMode: 'premultiplied' });
    }

    const compositor = new Compositor(device, context, canvasFormat, size);
    // A WGSL error only produces warnings and an invalid pipeline, which renders as a
    // silent black frame. Surface it as an exception instead.
    await compositor.assertShadersCompiled();

    device.addEventListener('uncapturederror', (event) => {
      const detail = (event as GPUUncapturedErrorEvent).error.message;
      compositor.lastDeviceError = detail;
      console.error('[compositor] GPU error:', detail);
    });

    return compositor;
  }

  /** Set when the device reports an uncaptured error; surfaced in telemetry. */
  lastDeviceError: string | null = null;

  private async assertShadersCompiled(): Promise<void> {
    const modules: readonly [string, GPUShaderModule][] = [
      ['composite', this.compositeModule],
      ['blur', this.blurModule],
      ['blit', this.blitModule],
    ];

    const problems: string[] = [];
    for (const [name, module] of modules) {
      const info = await module.getCompilationInfo();
      for (const message of info.messages) {
        if (message.type === 'error') {
          problems.push(`${name}:${message.lineNum}:${message.linePos} ${message.message}`);
        }
      }
    }
    if (problems.length > 0) {
      this.destroy();
      throw new CompositorError(`Shader compilation failed:\n${problems.join('\n')}`);
    }
  }

  get sequenceSize(): Size {
    return this.size;
  }

  /** Change the sequence resolution, reallocating render targets. */
  resize(size: Size): void {
    if (size.width === this.size.width && size.height === this.size.height) return;
    this.targets.a.destroy();
    this.targets.b.destroy();
    this.size = size;
    this.targets = this.createTargets(size);
  }

  private createTargets(size: Size): PingPong {
    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const descriptor: GPUTextureDescriptor = {
      size: { width: Math.max(1, size.width), height: Math.max(1, size.height) },
      format: COMPOSITE_FORMAT,
      usage,
    };
    return {
      a: this.device.createTexture({ ...descriptor, label: 'composite-a' }),
      b: this.device.createTexture({ ...descriptor, label: 'composite-b' }),
    };
  }

  // -------------------------------------------------------------------------
  // Texture pooling
  // -------------------------------------------------------------------------

  private acquireTexture(width: number, height: number): GPUTexture {
    const key = `${width}x${height}`;
    const pooled = this.texturePool.get(key);
    const reused = pooled?.pop();
    if (reused) return reused;

    return this.device.createTexture({
      label: `layer-${key}`,
      size: { width, height },
      format: COMPOSITE_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  private releaseTexture(texture: GPUTexture): void {
    const key = `${texture.width}x${texture.height}`;
    const pooled = this.texturePool.get(key) ?? [];
    // Cap the pool so an unusual frame size does not pin memory forever.
    if (pooled.length >= 4) {
      texture.destroy();
      return;
    }
    pooled.push(texture);
    this.texturePool.set(key, pooled);
  }

  private ensureUniformCapacity(layerCount: number): void {
    if (layerCount > this.layerUniformCapacity) {
      this.layerUniforms?.destroy();
      this.layerUniformCapacity = Math.max(8, layerCount * 2);
      this.layerUniforms = this.device.createBuffer({
        label: 'layer-uniforms',
        size: this.layerUniformCapacity * LAYER_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    // Two blur passes per layer.
    const blurSlots = layerCount * 2;
    if (blurSlots > this.blurUniformCapacity) {
      this.blurUniforms?.destroy();
      this.blurUniformCapacity = Math.max(16, blurSlots * 2);
      this.blurUniforms = this.device.createBuffer({
        label: 'blur-uniforms',
        size: this.blurUniformCapacity * BLUR_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Composite `layers` (bottom first) into the internal target.
   * Layer images are *not* closed — the caller keeps ownership.
   */
  render(layers: readonly DrawLayer[]): void {
    if (this.destroyed) throw new CompositorError('Compositor has been destroyed');
    this.ensureUniformCapacity(Math.max(1, layers.length));

    const encoder = this.device.createCommandEncoder({ label: 'composite-frame' });
    const borrowed: GPUTexture[] = [];

    // Start from a cleared target.
    clearTexture(encoder, this.targets.a);

    let blurSlot = 0;
    layers.forEach((layer, index) => {
      const width = Math.max(1, Math.round(layer.imageSize.width));
      const height = Math.max(1, Math.round(layer.imageSize.height));

      let layerTexture = this.acquireTexture(width, height);
      borrowed.push(layerTexture);
      this.device.queue.copyExternalImageToTexture(
        { source: layer.image, flipY: false },
        { texture: layerTexture, premultipliedAlpha: false },
        { width, height },
      );

      if (layer.effects.blurRadius > 0.5) {
        const blurred = this.applyBlur(encoder, layerTexture, layer.effects.blurRadius, blurSlot);
        blurSlot += 2;
        borrowed.push(blurred);
        layerTexture = blurred;
      }

      this.writeLayerUniforms(index, layer, { width, height });
      this.drawLayer(encoder, index, layerTexture);
    });

    this.device.queue.submit([encoder.finish()]);
    for (const texture of borrowed) this.releaseTexture(texture);
  }

  private applyBlur(
    encoder: GPUCommandEncoder,
    source: GPUTexture,
    radius: number,
    slot: number,
  ): GPUTexture {
    const sigma = Math.max(0.5, radius / 2);
    const first = this.acquireTexture(source.width, source.height);
    const second = this.acquireTexture(source.width, source.height);

    this.writeBlurUniforms(slot, [1, 0], source, radius, sigma);
    this.runBlurPass(encoder, slot, source, first);

    this.writeBlurUniforms(slot + 1, [0, 1], first, radius, sigma);
    this.runBlurPass(encoder, slot + 1, first, second);

    this.releaseTexture(first);
    return second;
  }

  private runBlurPass(
    encoder: GPUCommandEncoder,
    slot: number,
    source: GPUTexture,
    target: GPUTexture,
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.blurPipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.blurLayout,
        entries: [
          { binding: 0, resource: { buffer: this.blurUniforms!, size: BLUR_UNIFORM_SIZE } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: source.createView() },
        ],
      }),
      [slot * BLUR_UNIFORM_SIZE],
    );
    pass.draw(3);
    pass.end();
  }

  /** Composite one layer: read target A, write target B, then swap. */
  private drawLayer(encoder: GPUCommandEncoder, index: number, layerTexture: GPUTexture): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.targets.b.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.compositeLayout,
        entries: [
          { binding: 0, resource: { buffer: this.layerUniforms!, size: LAYER_UNIFORM_SIZE } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: layerTexture.createView() },
          { binding: 3, resource: this.targets.a.createView() },
        ],
      }),
      [index * LAYER_UNIFORM_SIZE],
    );
    pass.draw(3);
    pass.end();

    const swap = this.targets.a;
    this.targets.a = this.targets.b;
    this.targets.b = swap;
  }

  private writeLayerUniforms(index: number, layer: DrawLayer, imageSize: Size): void {
    const data = new ArrayBuffer(LAYER_UNIFORM_SIZE);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);

    const { transform } = layer;
    const width = imageSize.width * transform.scaleX;
    const height = imageSize.height * transform.scaleY;
    const radians = (transform.rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    // Layer is anchored inside the sequence, offset from the centre by (x, y).
    const centreX = this.size.width / 2 + transform.x;
    const centreY = this.size.height / 2 + transform.y;
    const anchorX = transform.anchorX * width;
    const anchorY = transform.anchorY * height;

    // Inverse of: rotate(p - anchor) + centre. Scale back to image pixels at the end.
    const sx = width === 0 ? 0 : imageSize.width / width;
    const sy = height === 0 ? 0 : imageSize.height / height;

    // row0 · (px, py) + tx  →  local x, in image pixels
    f[0] = cos * sx;
    f[1] = sin * sx;
    f[2] = (-cos * centreX - sin * centreY + anchorX) * sx;
    f[3] = 0;
    f[4] = -sin * sy;
    f[5] = cos * sy;
    f[6] = (sin * centreX - cos * centreY + anchorY) * sy;
    f[7] = 0;

    f[8] = imageSize.width;
    f[9] = imageSize.height;
    f[10] = this.size.width;
    f[11] = this.size.height;

    f[12] = clamp01(layer.crop.left);
    f[13] = clamp01(layer.crop.top);
    f[14] = clamp01(layer.crop.right);
    f[15] = clamp01(layer.crop.bottom);

    f[16] = layer.effects.brightness;
    f[17] = layer.effects.contrast;
    f[18] = layer.effects.saturation;
    f[19] = layer.effects.exposure;

    f[20] = clamp01(layer.opacity);
    u[21] = BLEND_MODE_IDS[layer.blendMode] ?? 0;

    this.device.queue.writeBuffer(this.layerUniforms!, index * LAYER_UNIFORM_SIZE, data);
  }

  private writeBlurUniforms(
    slot: number,
    direction: readonly [number, number],
    source: GPUTexture,
    radius: number,
    sigma: number,
  ): void {
    const data = new ArrayBuffer(BLUR_UNIFORM_SIZE);
    const f = new Float32Array(data);
    f[0] = direction[0];
    f[1] = direction[1];
    f[2] = 1 / source.width;
    f[3] = 1 / source.height;
    f[4] = Math.min(radius, 64);
    f[5] = sigma;
    this.device.queue.writeBuffer(this.blurUniforms!, slot * BLUR_UNIFORM_SIZE, data);
  }

  /** Show the last composite on the canvas. No-op when created without one. */
  present(): void {
    if (!this.context || this.destroyed) return;
    const encoder = this.device.createCommandEncoder({ label: 'blit' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.blitPipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.blitLayout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: this.targets.a.createView() },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Render and present in one call. */
  renderToCanvas(layers: readonly DrawLayer[]): void {
    this.render(layers);
    this.present();
  }

  /**
   * Read the last composite back as RGBA bytes.
   * Rows are unpadded, i.e. exactly `width * 4` bytes each.
   */
  async readPixels(): Promise<Uint8ClampedArray> {
    const { width, height } = this.size;
    const bytesPerRow = align(width * 4, 256);

    const staging = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = this.device.createCommandEncoder({ label: 'readback' });
    encoder.copyTextureToBuffer(
      { texture: this.targets.a },
      { buffer: staging, bytesPerRow, rowsPerImage: height },
      { width, height },
    );
    this.device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(staging.getMappedRange());

    const tight = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      tight.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }
    staging.unmap();
    staging.destroy();
    return tight;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.targets.a.destroy();
    this.targets.b.destroy();
    this.layerUniforms?.destroy();
    this.blurUniforms?.destroy();
    for (const pooled of this.texturePool.values()) {
      for (const texture of pooled) texture.destroy();
    }
    this.texturePool.clear();
    this.device.destroy();
  }
}

function clearTexture(encoder: GPUCommandEncoder, texture: GPUTexture): void {
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  });
  pass.end();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

export { NEUTRAL_EFFECTS };
