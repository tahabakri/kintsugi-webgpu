import { VERSION, type Controls, type MaterialName, type Mode, type Phase } from '../config';
import type { App, AppStats, PieceState, ScreenPoints } from '../app';
import type { QualityLevel } from '../gpu/renderer';

export interface KintsugiHook {
  readonly ready: boolean;
  readonly version: string;
  readonly seed: number;
  readonly state: Controls & { mode: Mode; phase: Phase; paused: boolean; material: string };
  readonly stats: AppStats;
  reset(options?: { sameSeed?: boolean }): void;
  fractureAt(options: { u: number; v: number; energy: number }): void;
  setMode(mode: Mode): void;
  setMaterial(name: MaterialName): void;
  setControl(name: string, value: number): void;
  /**
   * Render quality: 'auto' adapts its resolution to the frame rate, 'high' renders device pixels
   * up to 2× with finer shadows, 'ultra' is for stills. Returns the level now in force.
   */
  setQuality(level: QualityLevel): QualityLevel;
  paintCrack(options: { edgeId?: number; amount?: number; from?: number; to?: number }): void;
  alignAllForTest(): void;
  step(seconds: number): void;
  /** `aperture` is the current RMS gap between the two sides of the crack, in world units. */
  getCracks(): Array<{ id: number; shardA: number; shardB: number | null; length: number; fill: number; cure: number; joined: boolean; aligned: boolean; aperture: number }>;
  getGpuInfo(): object;
  /**
   * Screen positions (CSS pixels) of the pieces, of a point on each crack, and of the place each
   * loose piece belongs on the standing shell, for pointer-driven tests.
   */
  getScreenPoints(): ScreenPoints;
  /** World position and motion of every shard, and whether it is still on the usable table. */
  getPieces(): PieceState[];
  /** Separate pieces whose collision shapes overlap by more than `deeper` world units (default 0.01). */
  getOverlaps(deeper?: number): Array<{ a: number; b: number; depth: number }>;
  /** Current orbit of the camera. */
  getCamera(): { azimuth: number; elevation: number; distance: number };
  /** What the pointer would act on at a screen position: the piece and the crack under it, if any. */
  probe(x: number, y: number): { shard: number | null; crack: number | null };
}

declare global {
  interface Window {
    __kintsugi?: KintsugiHook;
  }
}

/**
 * Exposes a small automation surface as window.__kintsugi once the study is running. Every method
 * calls the same application code the interface does; nothing here is a second implementation.
 */
export function installDebugHook(app: App): void {
  const hook: KintsugiHook = {
    get ready() { return app.ready; },
    version: VERSION,
    get seed() { return app.seed; },
    get state() {
      return { ...app.controls, mode: app.mode(), phase: app.phase, paused: app.paused, material: app.material };
    },
    get stats() { return app.stats; },
    reset: (options) => app.reset(options?.sameSeed === true),
    fractureAt: (options) => { app.breakAt({ u: options.u, v: options.v, energy: options.energy }); },
    setMode: (mode) => app.setMode(mode),
    setMaterial: (name) => app.setMaterial(name),
    setControl: (name, value) => app.setControl(name, value),
    setQuality: (level) => app.setQuality(level),
    paintCrack: (options) => app.paintCrack(options ?? {}),
    alignAllForTest: () => app.alignAllForTest(),
    step: (seconds) => app.step(seconds),
    getCracks: () => app.cracks.map(({ id, shardA, shardB, length, fill, cure, joined, aligned, aperture }) => ({ id, shardA, shardB, length, fill, cure, joined, aligned, aperture })),
    getGpuInfo: () => app.gpuInfo(),
    getScreenPoints: () => app.screenPoints(),
    getPieces: () => app.pieceStates(),
    getOverlaps: (deeper) => app.overlaps(deeper).map(({ a, b, depth }) => ({ a, b, depth })),
    getCamera: () => app.cameraState(),
    probe: (x, y) => {
      const body = app.pick(x, y), crack = app.crackAt(x, y);
      return { shard: body && body.kind === 'shard' ? body.id : null, crack: crack ? crack.edge.id : null };
    },
  };
  window.__kintsugi = hook;
}
