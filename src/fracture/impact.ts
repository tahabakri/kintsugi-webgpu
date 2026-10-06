import { clamp, FRACTURE, lerp, smoothstep, type Controls, DEFAULT_CONTROLS } from '../config';
import type { BowlSurface } from '../ceramic/uv-surface';
import type { Vec2 } from '../math/vec';

/** Where and how hard the bowl was hit, in material space. The energy comes from the impact model (see physics/impact-model). */
export interface ImpactSpec {
  u: number;
  v: number;
  /** Normalised fracture energy, 0…1. */
  energy: number;
  /** Direction of the tangential part of the blow in metric chart space (unit, or [0, 0] for a square hit). */
  tangent?: Vec2;
}

/**
 * Local flat map of the bowl surface around the impact: (u, v) scaled so that distances are real
 * world distances at the impact latitude. All fracture geometry is built in this chart.
 */
export interface Chart {
  u0: number;
  v0: number;
  /** World units per unit of u (circumference at the impact latitude, clamped near the base). */
  scaleU: number;
  /** World units per unit of v (profile arc length). */
  scaleV: number;
}

export function brittlenessFactor(brittleness: number): number {
  const at = (b: number) => 0.45 + 1.1 * clamp(b / 100);
  return at(brittleness) / at(DEFAULT_CONTROLS.brittleness);
}

export function thicknessFactor(thickness: number): number {
  const at = (t: number) => 0.5 + clamp(t / 100);
  return at(thickness) / at(DEFAULT_CONTROLS.thickness);
}

/** Geodesic radius of the damaged region, in world units. */
export function fractureRadius(energy: number): number {
  return lerp(FRACTURE.radiusMin, FRACTURE.radiusMax, smoothstep(FRACTURE.threshold, 1, energy));
}

/** Number of fracture seeds: more for harder blows, brittle bodies and thin walls. */
export function seedCount(energy: number, controls: Pick<Controls, 'brittleness' | 'thickness'>): number {
  const base = lerp(6, 30, Math.pow(clamp(energy), 0.75));
  const modifier = (0.8 + 0.4 * clamp(controls.brittleness / 100)) / (0.86 + 0.28 * clamp(controls.thickness / 100));
  return Math.round(clamp(base * modifier, 4, 40));
}

/** Smallest shard the model keeps, in square world units; brittle bodies tolerate smaller pieces. */
export function minimumShardArea(controls: Pick<Controls, 'brittleness'>): number {
  return lerp(0.045, 0.022, clamp(controls.brittleness / 100));
}

/** Striker launch speed (world units per second) for an Impact control value. */
export function strikerSpeed(impact: number): number {
  return 11.2 + 0.25 * clamp(impact, 0, 100);
}

export function makeChart(surface: BowlSurface, u: number, v: number, radius: number): Chart {
  const u0 = u - Math.floor(u);
  const v0 = clamp(v);
  // Near the base the circumference shrinks towards zero; clamp it so the damaged region never
  // spans a whole turn of the unwrapped chart.
  const minRadius = Math.max(0.45, (radius * 1.25) / (Math.PI * 2 * 0.46));
  const effectiveRadius = Math.max(surface.radiusAt(v0), minRadius);
  return { u0, v0, scaleU: Math.PI * 2 * effectiveRadius, scaleV: surface.profile.length };
}

export const chartToUV = (chart: Chart, x: number, y: number): Vec2 => [chart.u0 + x / chart.scaleU, chart.v0 + y / chart.scaleV];
export const uvToChart = (chart: Chart, u: number, v: number): Vec2 => [(u - chart.u0) * chart.scaleU, (v - chart.v0) * chart.scaleV];
