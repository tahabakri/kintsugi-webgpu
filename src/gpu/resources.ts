import type { GpuContext } from './context';
import { COVERAGE_FORMAT, DEPTH_FORMAT, HEIGHT_FORMAT, SHADOW_FORMAT } from './pipelines';

/**
 * Textures the renderer draws into. The light-space ones are recreated when the quality level
 * changes their size; the viewport-sized ones by `resize`. Either way the old ones are destroyed.
 */
export class RenderTargets {
  shadowSize = 0;
  heightSize = 0;
  occlusionSize = 0;
  shadowView!: GPUTextureView;
  /** Top-down height of whatever stands on the table, for ambient occlusion. */
  heightView!: GPUTextureView;
  /** The table's ambient occlusion, and a scratch target for blurring it. */
  occlusionViews!: [GPUTextureView, GPUTextureView];

  width = 0;
  height = 0;
  bloomWidth = 0;
  bloomHeight = 0;
  /** Multisampled colour target, absent when MSAA is unavailable. */
  msaaView: GPUTextureView | null = null;
  depthView!: GPUTextureView;
  sceneView!: GPUTextureView;
  bloomViews!: [GPUTextureView, GPUTextureView];

  private sized: GPUTexture[] = [];
  private lightSpace: GPUTexture[] = [];

  constructor(private readonly gpu: GpuContext) {}

  /** Sizes the shadow map, the height map and the table's occlusion map. Returns true when they were recreated. */
  configure(shadowSize: number, heightSize: number, occlusionSize: number): boolean {
    if (shadowSize === this.shadowSize && heightSize === this.heightSize && occlusionSize === this.occlusionSize) return false;
    const { device } = this.gpu;
    for (const texture of this.lightSpace) texture.destroy();
    this.shadowSize = shadowSize;
    this.heightSize = heightSize;
    this.occlusionSize = occlusionSize;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const shadow = device.createTexture({ label: 'sun shadow map', size: [shadowSize, shadowSize], format: SHADOW_FORMAT, usage });
    const height = device.createTexture({ label: 'top-down height', size: [heightSize, heightSize], format: HEIGHT_FORMAT, usage });
    const occlusion = [0, 1].map((i) => device.createTexture({ label: `table occlusion ${i}`, size: [occlusionSize, occlusionSize], format: COVERAGE_FORMAT, usage }));
    this.lightSpace = [shadow, height, ...occlusion];
    this.shadowView = shadow.createView();
    this.heightView = height.createView();
    this.occlusionViews = [occlusion[0].createView(), occlusion[1].createView()];
    return true;
  }

  /** Returns true when the viewport-sized targets were recreated. */
  resize(width: number, height: number): boolean {
    if (width === this.width && height === this.height) return false;
    const { device, hdrFormat, sampleCount } = this.gpu;
    for (const texture of this.sized) texture.destroy();
    this.sized = [];
    this.width = width;
    this.height = height;
    this.bloomWidth = Math.max(1, width >> 2);
    this.bloomHeight = Math.max(1, height >> 2);

    const make = (label: string, w: number, h: number, format: GPUTextureFormat, samples: number, sampled: boolean) => {
      const texture = device.createTexture({
        label,
        size: [w, h],
        format,
        sampleCount: samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | (sampled ? GPUTextureUsage.TEXTURE_BINDING : 0),
      });
      this.sized.push(texture);
      return texture.createView();
    };
    this.msaaView = sampleCount > 1 ? make('scene msaa', width, height, hdrFormat, sampleCount, false) : null;
    this.depthView = make('scene depth', width, height, DEPTH_FORMAT, sampleCount, false);
    this.sceneView = make('scene resolved', width, height, hdrFormat, 1, true);
    this.bloomViews = [
      make('bloom A', this.bloomWidth, this.bloomHeight, hdrFormat, 1, true),
      make('bloom B', this.bloomWidth, this.bloomHeight, hdrFormat, 1, true),
    ];
    return true;
  }

  destroy(): void {
    for (const texture of this.sized) texture.destroy();
    for (const texture of this.lightSpace) texture.destroy();
    this.sized = [];
    this.lightSpace = [];
  }
}

/**
 * Size of the canvas' backing store for a CSS size: device pixels, with the device pixel ratio
 * capped and then scaled down as far as needed to respect a pixel budget.
 */
export function backingSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxPixels: number,
  maxDimension = 8192,
): { width: number; height: number; scale: number } {
  const w = Math.max(1, cssWidth), h = Math.max(1, cssHeight);
  const scale = Math.min(devicePixelRatio, Math.sqrt(maxPixels / (w * h)), maxDimension / w, maxDimension / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}
