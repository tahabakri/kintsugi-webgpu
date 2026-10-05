export const VERSION = '1.0.0';

export type MaterialName = 'porcelain' | 'celadon' | 'raku' | 'terracotta';
export const MATERIALS: readonly MaterialName[] = ['porcelain', 'celadon', 'raku', 'terracotta'];

export type Mode = 'break' | 'repair';
export type Tool = 'none' | 'strike' | 'brush';
export type Phase = 'intact' | 'fractured' | 'repairing' | 'repaired' | 'paused';

export interface Controls {
  brittleness: number;
  thickness: number;
  impact: number;
  viscosity: number;
  temperature: number;
  cureRate: number;
  seamThickness: number;
}
export type ControlName = keyof Controls;

/** Every slider runs 0–100; the panel shows them as 0.00–1.00. */
export const DEFAULT_CONTROLS: Readonly<Controls> = {
  brittleness: 58,
  thickness: 46,
  impact: 55,
  viscosity: 52,
  temperature: 58,
  cureRate: 46,
  seamThickness: 48,
};
export const CONTROL_NAMES = Object.keys(DEFAULT_CONTROLS) as ControlName[];

export const INITIAL_SEED = 20260214;

/** World units: 1.0 ≈ 10 cm, so real gravity is 98.1 units/s². */
export const SIM = {
  dt: 1 / 120,
  maxCatchUpSteps: 6,
  gravity: 98.1,
  maxLinearSpeed: 60,
  maxAngularSpeed: 45,
  maxThrowSpeed: 32,
} as const;

export const BOWL = {
  rimRadius: 1.72,
  height: 1.62,
  footOuter: 0.62,
  footInner: 0.5,
  footTop: 0.15,
  recess: 0.085,
  /** Base slab thickness at the default wall thickness; scales with the Thickness control. */
  baseThickness: 0.11,
  defaultWall: 0.075,
  uSegments: 160,
  vSegments: 72,
  /** kg per cubic unit (2.4 g/cm³ fired ceramic). */
  density: 2.4,
} as const;

/** Lower-resolution material grid used for collider blocks, independent of render tessellation. */
export const TOPOLOGY = { u: 96, v: 48, blockU: 6 } as const;

export const FRACTURE = {
  /** Below this normalized energy the bowl only sheds a dust puff. */
  threshold: 0.2,
  /**
   * From this energy up the wall breaks apart all the way round and only the foot is left
   * standing. Below it the blow knocks a hole out of a bowl that otherwise holds together.
   */
  shatterEnergy: 0.26,
  /** Share of the damaged radius that a shattering blow crushes into small fragments. */
  crushShare: 0.62,
  maxEnergy: 1,
  /** Scaled up from the brief's 0.34–1.65 because this bowl is deeper than the brief's starting profile. */
  radiusMin: 0.42,
  radiusMax: 2.0,
  maxFragments: 44,
} as const;

export const MATERIAL_PHYSICS = {
  ceramicFriction: 0.66,
  ceramicRestitution: 0.08,
  steelRestitution: 0.25,
  steelFriction: 0.35,
  tableFriction: 0.82,
  steelDensity: 7.85,
  strikerRadius: 0.13,
} as const;

export const STAGE = {
  /** The back wall faces this azimuth; the default camera looks straight at it. */
  azimuth: 0.62,
  wallDistance: 3.4,
  /** The table is a block against the wall: its top is y = 0 and its front edge is this far in front of the bowl. */
  tableFront: 3.7,
  tableHalfWidth: 14,
  /** Radius of the table's softened front edge. */
  tableBevel: 0.16,
  floorY: -2.6,
} as const;

export const clamp = (x: number, lo = 0, hi = 1): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Wall thickness in world units for a Thickness control value (46 → 0.075). */
export const wallThicknessFor = (control: number): number => lerp(0.052, 0.102, clamp(control / 100));
