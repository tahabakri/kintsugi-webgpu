import { MATERIAL_PHYSICS, STAGE, type MaterialName } from '../config';
import type { MeshData } from '../fracture/mesh-assembler';
import { mat4LookAt, mat4Multiply, mat4Ortho, writeRigid } from '../math/mat';
import { QUAT_IDENTITY, type Quat } from '../math/quat';
import { add3, cross3, norm3, scale3, type Vec3 } from '../math/vec';
import { Camera } from './camera';
import { createGpuContext, type GpuContext } from './context';
import { PRESETS, presetIndex } from './materials';
import { buildSphereMesh, buildStudioMesh, destroyMesh, stageFront, uploadMesh, type GpuMesh } from './mesh';
import { PARTICLE_FLOATS } from './layouts';
import { createPipelines, FRAME_SIZE, OBJECT_SIZE, OBJECT_STRIDE, type Pipelines } from './pipelines';
import { backingSize, RenderTargets } from './resources';

export const MAX_SHARDS = 48;
export const MAX_BALLS = 6;
export const MAX_PARTICLES = 512;

/**
 * auto   adapts its resolution to hold the frame rate (the default);
 * high   device pixels up to 2× with finer shadows and occlusion;
 * ultra  everything at its best and the scene supersampled where the pixel budget allows.
 *        Meant for stills: it is not expected to hold 60 frames a second.
 */
export type QualityLevel = 'auto' | 'high' | 'ultra';
export const QUALITY_LEVELS: readonly QualityLevel[] = ['auto', 'high', 'ultra'];

interface QualityProfile {
  /** Resolution of the sun's shadow map, of the top-down height map and of the table's occlusion map. */
  shadowSize: number;
  heightSize: number;
  occlusionSize: number;
  /** Taps per texel when the table's occlusion is worked out. */
  tableTaps: number;
  /** Taps of the soft-shadow filter, of its blocker search, and of the ambient occlusion. */
  shadowTaps: number;
  searchTaps: number;
  occlusionTaps: number;
  /** Largest device pixel ratio honoured, and the pixel budget for the canvas and for the scene. */
  maxPixelRatio: number;
  maxPixels: number;
  /** Extra resolution the scene is rendered at before being filtered down to the canvas. */
  supersample: number;
  /** Whether the app may lower the resolution to hold the frame rate. */
  adaptive: boolean;
}

const QUALITY: Record<QualityLevel, QualityProfile> = {
  auto: { shadowSize: 2048, heightSize: 512, occlusionSize: 384, tableTaps: 16, shadowTaps: 9, searchTaps: 6, occlusionTaps: 8, maxPixelRatio: 3, maxPixels: 2_600_000, supersample: 1, adaptive: true },
  high: { shadowSize: 4096, heightSize: 1024, occlusionSize: 512, tableTaps: 32, shadowTaps: 20, searchTaps: 12, occlusionTaps: 16, maxPixelRatio: 2, maxPixels: 6_000_000, supersample: 1, adaptive: false },
  ultra: { shadowSize: 4096, heightSize: 1024, occlusionSize: 1024, tableTaps: 48, shadowTaps: 32, searchTaps: 16, occlusionTaps: 28, maxPixelRatio: 3, maxPixels: 9_000_000, supersample: 1.5, adaptive: false },
};

/** Half the width of the square of table the top-down height map covers, in world units. */
const OVERHEAD_HALF_WIDTH = 6.5;

const SLOT_STUDIO = 0;
const SLOT_SHARD = 1;
const SLOT_BALL = SLOT_SHARD + MAX_SHARDS;
const SLOT_COUNT = SLOT_BALL + MAX_BALLS;
const OBJECT_FLOATS = OBJECT_STRIDE / 4;

/** Static gold geometry for one fracture, plus which part of it rides on which shard. */
export interface SeamGeometry {
  vertices: Float32Array;
  indices: Uint32Array;
  ranges: Array<{ shard: number; first: number; count: number }>;
  sampleCount: number;
  edgeCount: number;
}

interface ShardDraw {
  mesh: GpuMesh;
  slot: number;
}

interface SeamDraw {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  resinBuffer: GPUBuffer;
  edgeBuffer: GPUBuffer;
  group: GPUBindGroup;
  ranges: SeamGeometry['ranges'];
}

/**
 * Forward renderer on native WebGPU. Per frame:
 *   sun shadow map → top-down height map (and from it a blurred contact-shading map) → HDR scene
 *   (studio, ceramic, steel, gold, particles; 4× MSAA where available) → bloom → filmic composite
 *   to the canvas.
 */
export class Renderer {
  readonly camera = new Camera();
  readonly errors: string[] = [];

  private readonly device: GPUDevice;
  private readonly targets: RenderTargets;
  private readonly frameData = new Float32Array(FRAME_SIZE / 4);
  private readonly objectData = new Float32Array(SLOT_COUNT * OBJECT_FLOATS);
  private readonly frameBuffer: GPUBuffer;
  private readonly objectBuffer: GPUBuffer;
  private frameGroup!: GPUBindGroup;
  private readonly frameDepthGroup: GPUBindGroup;
  private readonly objectGroup: GPUBindGroup;
  private readonly studio: GpuMesh;
  private readonly sphere: GpuMesh;
  private readonly particleBuffer: GPUBuffer;
  private readonly postParams: GPUBuffer[];
  private readonly compositeParams: GPUBuffer;
  private readonly linearSampler: GPUSampler;
  private occlusionGroups!: [GPUBindGroup, GPUBindGroup, GPUBindGroup];
  private readonly shadowSampler: GPUSampler;
  private level: QualityLevel = 'auto';
  private profile: QualityProfile = QUALITY.auto;
  private supersample = 1;
  private pixelRatio = 1;
  private bloomGroups: GPUBindGroup[] = [];
  private compositeGroup!: GPUBindGroup;

  private shards: ShardDraw[] = [];
  private ballCount = 0;
  private seams: SeamDraw | null = null;
  private particleCount = 0;
  private material: MaterialName = 'porcelain';
  private seamWidth = 0.018;
  private highlighted = -1;
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelScale = 1;
  private readonly sunDirection: Vec3;

  private constructor(private readonly gpu: GpuContext, private readonly pipelines: Pipelines, private readonly canvas: HTMLCanvasElement) {
    const device = (this.device = gpu.device);
    this.targets = new RenderTargets(gpu);

    this.frameBuffer = device.createBuffer({ label: 'frame', size: FRAME_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.objectBuffer = device.createBuffer({ label: 'objects', size: SLOT_COUNT * OBJECT_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.particleBuffer = device.createBuffer({ label: 'particles', size: MAX_PARTICLES * PARTICLE_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.linearSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.shadowSampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.frameDepthGroup = device.createBindGroup({
      layout: pipelines.frameDepthLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });
    this.objectGroup = device.createBindGroup({
      layout: pipelines.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer, size: OBJECT_SIZE } }],
    });

    // Small parameter blocks for the full-screen passes: occlusion blur H/V, bloom prefilter,
    // bloom blur H/V, and the table occlusion itself.
    this.postParams = Array.from({ length: 6 }, (_, i) =>
      device.createBuffer({ label: `post params ${i}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.compositeParams = device.createBuffer({ label: 'composite params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.applyProfile();

    this.studio = uploadMesh(device, buildStudioMesh(), 'studio');
    this.sphere = uploadMesh(device, buildSphereMesh(MATERIAL_PHYSICS.strikerRadius), 'striker');

    // The sun comes from the upper left and slightly in front of the default view.
    const front = stageFront();
    const left = scale3(cross3([0, 1, 0], front), -1);
    this.sunDirection = norm3(add3(add3(scale3(left, 0.82), [0, 0.7, 0]), scale3(front, 0.46)));

    this.setObject(SLOT_STUDIO, [0, 0, 0], QUAT_IDENTITY as Quat, 1);
    this.writeStaticFrame();

    device.addEventListener('uncapturederror', (event) => {
      const message = (event as GPUUncapturedErrorEvent).error.message;
      if (this.errors.length < 20 && !this.errors.includes(message)) {
        this.errors.push(message);
        console.error(`WebGPU: ${message}`);
      }
    });
  }

  static async create(canvas: HTMLCanvasElement): Promise<Renderer> {
    const gpu = await createGpuContext(canvas);
    const pipelines = await createPipelines(gpu);
    return new Renderer(gpu, pipelines, canvas);
  }

  /** Resolves when the GPU device is lost for any reason other than our own teardown. */
  get lost(): Promise<GPUDeviceLostInfo> {
    return this.device.lost;
  }

  // ---- Quality --------------------------------------------------------------------------------

  get quality(): QualityLevel {
    return this.level;
  }

  /** True when the app may scale the resolution down to hold the frame rate. */
  get adaptive(): boolean {
    return this.profile.adaptive;
  }

  /** Switches quality level. The caller must call `resize` afterwards for the new pixel budget. */
  setQuality(level: QualityLevel): void {
    if (!QUALITY[level]) return;
    this.level = level;
    this.profile = QUALITY[level];
    this.applyProfile();
  }

  /** (Re)creates the light-space targets for the current profile and everything that refers to them. */
  private applyProfile(): void {
    const limit = this.device.limits.maxTextureDimension2D;
    const shadowSize = Math.min(this.profile.shadowSize, limit), heightSize = Math.min(this.profile.heightSize, limit);
    const queue = this.device.queue;
    const texel = 1 / this.profile.occlusionSize;
    queue.writeBuffer(this.postParams[0], 0, new Float32Array([texel * 1.3, 0, 0, 0]));
    queue.writeBuffer(this.postParams[1], 0, new Float32Array([0, texel * 1.3, 0, 0]));
    queue.writeBuffer(this.postParams[5], 0, new Float32Array([0, 0, this.profile.tableTaps, OVERHEAD_HALF_WIDTH]));
    if (!this.targets.configure(shadowSize, heightSize, this.profile.occlusionSize) && this.frameGroup) return;
    this.frameGroup = this.device.createBindGroup({
      layout: this.pipelines.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: this.targets.shadowView },
        { binding: 2, resource: this.shadowSampler },
        { binding: 3, resource: this.targets.occlusionViews[0] },
        { binding: 4, resource: this.linearSampler },
        { binding: 5, resource: this.targets.heightView },
      ],
    });
    this.occlusionGroups = [
      this.postGroup(this.targets.heightView, this.postParams[5]),
      this.postGroup(this.targets.occlusionViews[0], this.postParams[0]),
      this.postGroup(this.targets.occlusionViews[1], this.postParams[1]),
    ];
  }

  private postGroup(source: GPUTextureView, params: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.pipelines.postLayout,
      entries: [
        { binding: 0, resource: source },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: { buffer: params } },
      ],
    });
  }

  /** The parts of the frame block that never change: the sun, its shadow frustum and the stage. */
  private writeStaticFrame(): void {
    const f = this.frameData;
    const sun = this.sunDirection;
    const focus: Vec3 = [0, 0.3, 0];
    const lightView = mat4LookAt(add3(focus, scale3(sun, 20)), focus);
    f.set(mat4Multiply(mat4Ortho(-7.2, 7.2, -7.2, 7.2, 1, 42), lightView), 16);
    const overhead = mat4LookAt([0, 12, 0], [0, 0, 0], [0, 0, -1]);
    f.set(mat4Multiply(mat4Ortho(-OVERHEAD_HALF_WIDTH, OVERHEAD_HALF_WIDTH, -OVERHEAD_HALF_WIDTH, OVERHEAD_HALF_WIDTH, 0.1, 30), overhead), 32);

    const lightRight = norm3(cross3([0, 1, 0], sun));
    const lightUp = cross3(sun, lightRight);
    f.set([...sun, 0], 52);
    f.set([3.1, 2.76, 2.24, 0.6], 56);
    f.set([...lightRight, 0], 60);
    f.set([...lightUp, 0], 64);
    f.set([...stageFront(), STAGE.wallDistance], 76);
    f.set([STAGE.tableFront, STAGE.tableBevel, 0.075, 0], 108);
    f.set([0, 0, 0, 1], 112);
  }

  private setObject(slot: number, position: Vec3, rotation: Quat, scale: number, highlight = 0, meeting = 0): void {
    const o = slot * OBJECT_FLOATS;
    writeRigid(this.objectData, o, rotation, position);
    if (scale !== 1) for (let i = 0; i < 12; i++) if ((i & 3) !== 3) this.objectData[o + i] *= scale;
    this.objectData[o + 16] = highlight;
    this.objectData[o + 17] = slot;
    this.objectData[o + 18] = 1;
    this.objectData[o + 19] = meeting;
  }

  // ---- Scene content --------------------------------------------------------------------------

  /** Replaces every ceramic mesh. Shard `id` selects its transform slot. */
  setShards(shards: Array<{ id: number; mesh: MeshData }>): void {
    for (const draw of this.shards) destroyMesh(draw.mesh);
    this.shards = shards
      .filter((shard) => shard.id < MAX_SHARDS)
      .map((shard) => ({ mesh: uploadMesh(this.device, shard.mesh, `shard ${shard.id}`), slot: SLOT_SHARD + shard.id }));
    this.highlighted = -1;
  }

  /** `meeting` (0…1) is how nearly this shard's broken edge has closed on the one it is being fitted to. */
  setShardPose(id: number, position: Vec3, rotation: Quat, meeting = 0): void {
    if (id >= MAX_SHARDS) return;
    this.setObject(SLOT_SHARD + id, position, rotation, 1, id === this.highlighted ? 1 : 0, meeting);
  }

  /** Shard to tint as "can be picked up", or -1 for none. */
  setHighlight(id: number): void {
    this.highlighted = id;
  }

  setBalls(balls: Array<{ position: Vec3; rotation: Quat; scale: number }>): void {
    this.ballCount = Math.min(MAX_BALLS, balls.length);
    for (let i = 0; i < this.ballCount; i++) this.setObject(SLOT_BALL + i, balls[i].position, balls[i].rotation, balls[i].scale);
  }

  setSeams(geometry: SeamGeometry | null): void {
    if (this.seams) {
      this.seams.vertexBuffer.destroy();
      this.seams.indexBuffer.destroy();
      this.seams.resinBuffer.destroy();
      this.seams.edgeBuffer.destroy();
      this.seams = null;
    }
    if (!geometry || geometry.indices.length === 0) return;
    const device = this.device;
    const vertexBuffer = device.createBuffer({ label: 'seam vertices', size: geometry.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const indexBuffer = device.createBuffer({ label: 'seam indices', size: geometry.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertexBuffer, 0, geometry.vertices as Float32Array<ArrayBuffer>);
    device.queue.writeBuffer(indexBuffer, 0, geometry.indices as Uint32Array<ArrayBuffer>);
    const resinBuffer = device.createBuffer({ label: 'resin samples', size: Math.max(16, geometry.sampleCount * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const edgeBuffer = device.createBuffer({ label: 'crack edges', size: Math.max(16, geometry.edgeCount * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const group = device.createBindGroup({
      layout: this.pipelines.resinLayout,
      entries: [
        { binding: 0, resource: { buffer: resinBuffer } },
        { binding: 1, resource: { buffer: edgeBuffer } },
      ],
    });
    this.seams = { vertexBuffer, indexBuffer, resinBuffer, edgeBuffer, group, ranges: geometry.ranges };
  }

  /** Uploads the current resin fields (4 floats per sample) and edge flags (4 floats per edge). */
  updateResin(samples: Float32Array, edges: Float32Array): void {
    if (!this.seams) return;
    this.device.queue.writeBuffer(this.seams.resinBuffer, 0, samples as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.seams.edgeBuffer, 0, edges as Float32Array<ArrayBuffer>);
  }

  setParticles(data: Float32Array, count: number): void {
    this.particleCount = Math.min(MAX_PARTICLES, count);
    if (this.particleCount > 0) {
      this.device.queue.writeBuffer(this.particleBuffer, 0, data as Float32Array<ArrayBuffer>, 0, this.particleCount * PARTICLE_FLOATS);
    }
  }

  setMaterial(name: MaterialName): void {
    this.material = name;
  }

  setSeamWidth(width: number): void {
    this.seamWidth = width;
  }

  /** True while the bowl is being mended: closed, unfilled cracks then show a first thread of gold. */
  setMending(mending: boolean): void {
    this.frameData[111] = mending ? 1 : 0;
  }

  /** Where a held piece's edge is about to close on its mate, and how far round it the cue reaches. */
  setMeeting(point: Vec3, reach: number): void {
    this.frameData.set([point[0], point[1], point[2], Math.max(1e-3, reach)], 112);
  }

  // ---- Frame ------------------------------------------------------------------------------------

  /**
   * Matches the backing store to the canvas' CSS size within the quality level's pixel budget.
   * The scene is rendered at its own resolution and filtered to the canvas: smaller when `scale`
   * (0…1] says the GPU cannot keep up, larger when the level supersamples. The canvas itself, and
   * with it every edge the final pass draws, stays at device resolution.
   */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number, scale = 1): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    const profile = this.profile;
    const limit = this.device.limits.maxTextureDimension2D;
    this.pixelRatio = devicePixelRatio;
    const canvas = backingSize(this.cssWidth, this.cssHeight, Math.min(devicePixelRatio, profile.maxPixelRatio), profile.maxPixels, limit);
    this.pixelScale = canvas.scale;
    if (this.canvas.width !== canvas.width || this.canvas.height !== canvas.height) {
      this.canvas.width = canvas.width;
      this.canvas.height = canvas.height;
    }
    this.supersample = Math.max(1, Math.min(profile.supersample, Math.sqrt(profile.maxPixels / (canvas.width * canvas.height)), limit / canvas.width, limit / canvas.height));
    // A sliver of extra resolution buys nothing and costs a resample: use it properly or not at all.
    if (this.supersample < 1.2) this.supersample = 1;
    this.supersample *= Math.min(1, Math.max(0.25, scale));
    const width = Math.max(1, Math.round(canvas.width * this.supersample)), height = Math.max(1, Math.round(canvas.height * this.supersample));
    if (!this.targets.resize(width, height)) return;

    const queue = this.device.queue;
    queue.writeBuffer(this.postParams[2], 0, new Float32Array([1 / width, 1 / height, 5.0, 0]));
    queue.writeBuffer(this.postParams[3], 0, new Float32Array([1.2 / this.targets.bloomWidth, 0, 0, 0]));
    queue.writeBuffer(this.postParams[4], 0, new Float32Array([0, 1.2 / this.targets.bloomHeight, 0, 0]));
    this.bloomGroups = [
      this.postGroup(this.targets.sceneView, this.postParams[2]),
      this.postGroup(this.targets.bloomViews[0], this.postParams[3]),
      this.postGroup(this.targets.bloomViews[1], this.postParams[4]),
    ];
    this.compositeGroup = this.device.createBindGroup({
      layout: this.pipelines.compositeLayout,
      entries: [
        { binding: 0, resource: this.targets.sceneView },
        { binding: 1, resource: this.targets.bloomViews[0] },
        { binding: 2, resource: this.linearSampler },
        { binding: 3, resource: { buffer: this.compositeParams } },
      ],
    });
  }

  private writeFrame(time: number): void {
    const f = this.frameData, camera = this.camera;
    const preset = PRESETS[this.material];
    f.set(camera.viewProjection, 0);
    f.set([...camera.eye, time], 48);
    f.set([...camera.right, 0], 68);
    f.set([...camera.up, 0], 72);
    f.set([this.targets.width, this.targets.height, 1 / this.targets.width, 1 / this.targets.height], 80);
    f.set(preset.glaze, 84);
    f.set(preset.secondary, 88);
    f.set(preset.body, 92);
    f.set([presetIndex(this.material), preset.crackle, preset.speckle, preset.grain], 96);
    f.set([2.75, 1, this.seamWidth, 0], 100);
    f.set([this.profile.shadowTaps, this.profile.searchTaps, this.profile.occlusionTaps, 1 / this.targets.shadowSize], 104);
    this.device.queue.writeBuffer(this.frameBuffer, 0, f);
    this.device.queue.writeBuffer(this.objectBuffer, 0, this.objectData);
    this.device.queue.writeBuffer(this.compositeParams, 0, new Float32Array([
      0.78, 0.05, 0.2, time,
      1 / this.canvas.width, 1 / this.canvas.height, this.supersample, 0,
    ]));
  }

  private drawCasters(pass: GPURenderPassEncoder): void {
    for (const draw of this.shards) {
      pass.setBindGroup(1, this.objectGroup, [draw.slot * OBJECT_STRIDE]);
      pass.setVertexBuffer(0, draw.mesh.vertexBuffer);
      pass.setIndexBuffer(draw.mesh.indexBuffer, 'uint32');
      pass.drawIndexed(draw.mesh.indexCount);
    }
    if (this.ballCount > 0) {
      pass.setVertexBuffer(0, this.sphere.vertexBuffer);
      pass.setIndexBuffer(this.sphere.indexBuffer, 'uint32');
      for (let i = 0; i < this.ballCount; i++) {
        pass.setBindGroup(1, this.objectGroup, [(SLOT_BALL + i) * OBJECT_STRIDE]);
        pass.drawIndexed(this.sphere.indexCount);
      }
    }
  }

  private fullscreen(encoder: GPUCommandEncoder, target: GPUTextureView, pipeline: GPURenderPipeline, group: GPUBindGroup): void {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
  }

  render(time: number): void {
    if (this.targets.width === 0) return;
    const p = this.pipelines, t = this.targets;
    this.camera.update();
    this.writeFrame(time);
    const encoder = this.device.createCommandEncoder();

    const shadow = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: { view: t.shadowView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    shadow.setPipeline(p.shadow);
    shadow.setBindGroup(0, this.frameDepthGroup);
    this.drawCasters(shadow);
    shadow.end();

    const overhead = encoder.beginRenderPass({
      colorAttachments: [{ view: t.heightView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    overhead.setPipeline(p.height);
    overhead.setBindGroup(0, this.frameDepthGroup);
    this.drawCasters(overhead);
    overhead.end();
    this.fullscreen(encoder, t.occlusionViews[0], p.tableOcclusion, this.occlusionGroups[0]);
    this.fullscreen(encoder, t.occlusionViews[1], p.blurCoverage, this.occlusionGroups[1]);
    this.fullscreen(encoder, t.occlusionViews[0], p.blurCoverage, this.occlusionGroups[2]);

    const scene = encoder.beginRenderPass({
      colorAttachments: [{
        view: t.msaaView ?? t.sceneView,
        resolveTarget: t.msaaView ? t.sceneView : undefined,
        loadOp: 'clear',
        storeOp: t.msaaView ? 'discard' : 'store',
        clearValue: { r: 0.62, g: 0.57, b: 0.5, a: 1 },
      }],
      depthStencilAttachment: { view: t.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    scene.setBindGroup(0, this.frameGroup);
    scene.setPipeline(p.ceramic);
    for (const draw of this.shards) {
      scene.setBindGroup(1, this.objectGroup, [draw.slot * OBJECT_STRIDE]);
      scene.setVertexBuffer(0, draw.mesh.vertexBuffer);
      scene.setIndexBuffer(draw.mesh.indexBuffer, 'uint32');
      scene.drawIndexed(draw.mesh.indexCount);
    }
    if (this.ballCount > 0) {
      scene.setPipeline(p.metal);
      scene.setVertexBuffer(0, this.sphere.vertexBuffer);
      scene.setIndexBuffer(this.sphere.indexBuffer, 'uint32');
      for (let i = 0; i < this.ballCount; i++) {
        scene.setBindGroup(1, this.objectGroup, [(SLOT_BALL + i) * OBJECT_STRIDE]);
        scene.drawIndexed(this.sphere.indexCount);
      }
    }
    scene.setPipeline(p.studio);
    scene.setBindGroup(1, this.objectGroup, [SLOT_STUDIO * OBJECT_STRIDE]);
    scene.setVertexBuffer(0, this.studio.vertexBuffer);
    scene.setIndexBuffer(this.studio.indexBuffer, 'uint32');
    scene.drawIndexed(this.studio.indexCount);
    if (this.seams) {
      scene.setPipeline(p.gold);
      scene.setBindGroup(2, this.seams.group);
      scene.setVertexBuffer(0, this.seams.vertexBuffer);
      scene.setIndexBuffer(this.seams.indexBuffer, 'uint32');
      for (const range of this.seams.ranges) {
        scene.setBindGroup(1, this.objectGroup, [(SLOT_SHARD + range.shard) * OBJECT_STRIDE]);
        scene.drawIndexed(range.count, 1, range.first);
      }
    }
    if (this.particleCount > 0) {
      scene.setPipeline(p.dust);
      scene.setVertexBuffer(0, this.particleBuffer);
      scene.draw(6, this.particleCount);
    }
    scene.end();

    this.fullscreen(encoder, t.bloomViews[0], p.bloomPrefilter, this.bloomGroups[0]);
    this.fullscreen(encoder, t.bloomViews[1], p.blurHdr, this.bloomGroups[1]);
    this.fullscreen(encoder, t.bloomViews[0], p.blurHdr, this.bloomGroups[2]);
    this.fullscreen(encoder, this.gpu.canvasContext.getCurrentTexture().createView(), p.composite, this.compositeGroup);
    this.device.queue.submit([encoder.finish()]);
  }

  info(): Record<string, unknown> {
    const adapter = this.gpu.adapter.info;
    return {
      api: 'WebGPU',
      vendor: adapter.vendor,
      architecture: adapter.architecture,
      device: adapter.device,
      description: adapter.description,
      canvasFormat: this.gpu.canvasFormat,
      hdrFormat: this.gpu.hdrFormat,
      sampleCount: this.gpu.sampleCount,
      quality: this.level,
      shadowMapSize: this.targets.shadowSize,
      heightMapSize: this.targets.heightSize,
      /** Canvas backing store in device pixels, and the size the scene is actually rendered at. */
      canvasSize: [this.canvas.width, this.canvas.height],
      renderSize: [this.targets.width, this.targets.height],
      supersample: this.supersample,
      devicePixelRatio: this.pixelRatio,
      pixelScale: this.pixelScale,
      shardMeshes: this.shards.length,
      triangles: this.shards.reduce((sum, draw) => sum + draw.mesh.indexCount / 3, 0),
      notes: this.gpu.notes,
      errors: this.errors,
    };
  }

  destroy(): void {
    for (const draw of this.shards) destroyMesh(draw.mesh);
    this.setSeams(null);
    destroyMesh(this.studio);
    destroyMesh(this.sphere);
    this.targets.destroy();
    this.device.destroy();
  }
}
