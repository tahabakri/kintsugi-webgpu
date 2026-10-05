/** Raised when the browser or device cannot give us WebGPU. Never answered with a WebGL fallback. */
export class WebGpuUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WebGpuUnavailableError';
  }
}

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  canvasContext: GPUCanvasContext;
  /** Format of the canvas back buffer. */
  canvasFormat: GPUTextureFormat;
  /** Format of the HDR scene colour targets. */
  hdrFormat: GPUTextureFormat;
  sampleCount: 1 | 4;
  /** Anything that had to be substituted, for the debug hook. */
  notes: string[];
}

/** True if a render target of this format and sample count can actually be created. */
async function supportsTarget(device: GPUDevice, format: GPUTextureFormat, sampleCount: number): Promise<boolean> {
  device.pushErrorScope('validation');
  const texture = device.createTexture({
    size: [4, 4],
    format,
    sampleCount,
    usage: sampleCount > 1 ? GPUTextureUsage.RENDER_ATTACHMENT : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const error = await device.popErrorScope();
  texture.destroy();
  return error === null;
}

export async function createGpuContext(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!('gpu' in navigator) || !navigator.gpu) throw new WebGpuUnavailableError('navigator.gpu is missing');

  // Chrome on Windows ignores powerPreference and warns about it, so only ask where it matters.
  const onWindows = /Windows/i.test(navigator.userAgent);
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter(onWindows ? undefined : { powerPreference: 'high-performance' });
  } catch (error) {
    throw new WebGpuUnavailableError(`requestAdapter failed: ${String(error)}`);
  }
  if (!adapter) throw new WebGpuUnavailableError('no WebGPU adapter');

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch (error) {
    throw new WebGpuUnavailableError(`requestDevice failed: ${String(error)}`);
  }

  const canvasContext = canvas.getContext('webgpu');
  if (!canvasContext) {
    device.destroy();
    throw new WebGpuUnavailableError('canvas has no webgpu context');
  }
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  canvasContext.configure({ device, format: canvasFormat, alphaMode: 'opaque' });

  const notes: string[] = [];
  let hdrFormat: GPUTextureFormat = 'rgba16float';
  let sampleCount: 1 | 4 = 4;
  if (!(await supportsTarget(device, hdrFormat, 1))) {
    hdrFormat = 'rgba8unorm';
    notes.push('rgba16float is not renderable here; scene rendered in rgba8unorm');
  }
  if (!(await supportsTarget(device, hdrFormat, 4))) {
    sampleCount = 1;
    notes.push(`${hdrFormat} cannot be multisampled here; MSAA disabled`);
  }
  return { adapter, device, canvasContext, canvasFormat, hdrFormat, sampleCount, notes };
}
