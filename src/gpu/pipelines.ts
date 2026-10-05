import ceramicSource from '../shaders/ceramic.wgsl?raw';
import commonSource from '../shaders/common.wgsl?raw';
import compositeSource from '../shaders/composite.wgsl?raw';
import dustSource from '../shaders/dust.wgsl?raw';
import floorSource from '../shaders/floor.wgsl?raw';
import goldSource from '../shaders/gold.wgsl?raw';
import lightingSource from '../shaders/lighting.wgsl?raw';
import metalSource from '../shaders/metal.wgsl?raw';
import postSource from '../shaders/post.wgsl?raw';
import shadowSource from '../shaders/shadow.wgsl?raw';
import { VERTEX_BYTES } from '../fracture/mesh-assembler';
import type { GpuContext } from './context';
import { PARTICLE_FLOATS, SEAM_VERTEX_FLOATS } from './layouts';

export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
export const SHADOW_FORMAT: GPUTextureFormat = 'depth32float';
export const COVERAGE_FORMAT: GPUTextureFormat = 'r8unorm';
export const HEIGHT_FORMAT: GPUTextureFormat = 'r16float';
/** Bytes between consecutive per-object uniform blocks (the minimum dynamic-offset alignment). */
export const OBJECT_STRIDE = 256;
export const OBJECT_SIZE = 80;
export const FRAME_SIZE = 464;

export interface Pipelines {
  frameLayout: GPUBindGroupLayout;
  frameDepthLayout: GPUBindGroupLayout;
  objectLayout: GPUBindGroupLayout;
  resinLayout: GPUBindGroupLayout;
  postLayout: GPUBindGroupLayout;
  compositeLayout: GPUBindGroupLayout;
  shadow: GPURenderPipeline;
  height: GPURenderPipeline;
  tableOcclusion: GPURenderPipeline;
  ceramic: GPURenderPipeline;
  studio: GPURenderPipeline;
  metal: GPURenderPipeline;
  gold: GPURenderPipeline;
  dust: GPURenderPipeline;
  blurCoverage: GPURenderPipeline;
  blurHdr: GPURenderPipeline;
  bloomPrefilter: GPURenderPipeline;
  composite: GPURenderPipeline;
}

async function compile(device: GPUDevice, label: string, code: string): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === 'error');
  if (errors.length > 0) {
    const detail = errors.map((e) => `${label}:${e.lineNum}:${e.linePos} ${e.message}`).join('\n');
    throw new Error(`Shader failed to compile\n${detail}`);
  }
  return module;
}

const MESH_BUFFER: GPUVertexBufferLayout = {
  arrayStride: VERTEX_BYTES,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' },
    { shaderLocation: 3, offset: 32, format: 'float32x2' },
  ],
};

const POSITION_ONLY: GPUVertexBufferLayout = {
  arrayStride: VERTEX_BYTES,
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
};

const SEAM_BUFFER: GPUVertexBufferLayout = {
  arrayStride: SEAM_VERTEX_FLOATS * 4,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x3' },
    { shaderLocation: 3, offset: 36, format: 'float32x2' },
    { shaderLocation: 4, offset: 44, format: 'float32x4' },
  ],
};

const PARTICLE_BUFFER: GPUVertexBufferLayout = {
  arrayStride: PARTICLE_FLOATS * 4,
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x4' },
    { shaderLocation: 1, offset: 16, format: 'float32x4' },
    { shaderLocation: 2, offset: 32, format: 'float32x4' },
  ],
};

export async function createPipelines(gpu: GpuContext): Promise<Pipelines> {
  const { device, hdrFormat, canvasFormat, sampleCount } = gpu;
  const lit = `${commonSource}\n${lightingSource}\n`;

  const [shadowModule, ceramicModule, studioModule, metalModule, goldModule, dustModule, postModule, compositeModule] = await Promise.all([
    compile(device, 'shadow.wgsl', `${commonSource}\n${shadowSource}`),
    compile(device, 'ceramic.wgsl', lit + ceramicSource),
    compile(device, 'floor.wgsl', lit + floorSource),
    compile(device, 'metal.wgsl', lit + metalSource),
    compile(device, 'gold.wgsl', lit + goldSource),
    compile(device, 'dust.wgsl', lit + dustSource),
    compile(device, 'post.wgsl', postSource),
    compile(device, 'composite.wgsl', compositeSource),
  ]);

  const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const frameLayout = device.createBindGroupLayout({
    label: 'frame',
    entries: [
      { binding: 0, visibility: both, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  const frameDepthLayout = device.createBindGroupLayout({
    label: 'frame (depth passes)',
    entries: [{ binding: 0, visibility: both, buffer: { type: 'uniform' } }],
  });
  const objectLayout = device.createBindGroupLayout({
    label: 'object',
    entries: [{ binding: 0, visibility: both, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: OBJECT_SIZE } }],
  });
  const resinLayout = device.createBindGroupLayout({
    label: 'resin',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const postLayout = device.createBindGroupLayout({
    label: 'post',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const compositeLayout = device.createBindGroupLayout({
    label: 'composite',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const depthLayout = device.createPipelineLayout({ bindGroupLayouts: [frameDepthLayout, objectLayout] });
  const sceneLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, objectLayout] });
  const goldLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, objectLayout, resinLayout] });
  const dustLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout] });
  const postPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [postLayout] });
  const compositePipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [compositeLayout] });

  const sceneDepth: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' };
  const multisample: GPUMultisampleState = { count: sampleCount };

  const scenePipeline = (label: string, module: GPUShaderModule, cullMode: GPUCullMode): Promise<GPURenderPipeline> =>
    device.createRenderPipelineAsync({
      label,
      layout: sceneLayout,
      vertex: { module, entryPoint: 'vertexMain', buffers: [MESH_BUFFER] },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
      depthStencil: sceneDepth,
      multisample,
    });

  const postPipeline = (label: string, entryPoint: string, format: GPUTextureFormat): Promise<GPURenderPipeline> =>
    device.createRenderPipelineAsync({
      label,
      layout: postPipelineLayout,
      vertex: { module: postModule, entryPoint: 'fullscreenVertex' },
      fragment: { module: postModule, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

  const [shadow, height, ceramic, studio, metal, gold, dust, tableOcclusion, blurCoverage, blurHdr, bloomPrefilter, composite] = await Promise.all([
    device.createRenderPipelineAsync({
      label: 'shadow',
      layout: depthLayout,
      vertex: { module: shadowModule, entryPoint: 'shadowVertex', buffers: [POSITION_ONLY] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: SHADOW_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5 },
    }),
    device.createRenderPipelineAsync({
      label: 'height',
      layout: depthLayout,
      vertex: { module: shadowModule, entryPoint: 'heightVertex', buffers: [POSITION_ONLY] },
      fragment: {
        module: shadowModule,
        entryPoint: 'heightFragment',
        targets: [{
          format: HEIGHT_FORMAT,
          blend: {
            color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
            alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    }),
    scenePipeline('ceramic', ceramicModule, 'back'),
    scenePipeline('studio', studioModule, 'none'),
    scenePipeline('metal', metalModule, 'back'),
    device.createRenderPipelineAsync({
      label: 'gold',
      layout: goldLayout,
      vertex: { module: goldModule, entryPoint: 'vertexMain', buffers: [SEAM_BUFFER] },
      fragment: { module: goldModule, entryPoint: 'fragmentMain', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: sceneDepth,
      multisample,
    }),
    device.createRenderPipelineAsync({
      label: 'dust',
      layout: dustLayout,
      vertex: { module: dustModule, entryPoint: 'vertexMain', buffers: [PARTICLE_BUFFER] },
      fragment: {
        module: dustModule,
        entryPoint: 'fragmentMain',
        targets: [{
          format: hdrFormat,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
      multisample,
    }),
    postPipeline('table occlusion', 'tableOcclusionFragment', COVERAGE_FORMAT),
    postPipeline('blur (coverage)', 'blurFragment', COVERAGE_FORMAT),
    postPipeline('blur (hdr)', 'blurFragment', hdrFormat),
    postPipeline('bloom prefilter', 'bloomPrefilterFragment', hdrFormat),
    device.createRenderPipelineAsync({
      label: 'composite',
      layout: compositePipelineLayout,
      vertex: { module: compositeModule, entryPoint: 'fullscreenVertex' },
      fragment: { module: compositeModule, entryPoint: 'fragmentMain', targets: [{ format: canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    }),
  ]);

  return {
    frameLayout, frameDepthLayout, objectLayout, resinLayout, postLayout, compositeLayout,
    shadow, height, ceramic, studio, metal, gold, dust, tableOcclusion, blurCoverage, blurHdr, bloomPrefilter, composite,
  };
}
