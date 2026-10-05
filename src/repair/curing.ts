import { clamp, lerp, smoothstep } from '../config';
import type { CrackEdge } from '../fracture/crack-graph';
import type { ResinControls } from './resin';

/** An edge can bond once it is this full and this cured (and its two sides are aligned). */
export const JOIN_FILL = 0.72;
export const JOIN_CURE = 0.82;
/** Samples emptier than this do not count towards an edge's structural cure. */
const STRUCTURAL_FILL = 0.3;

/** Cure per second of a fully filled sample at ambient temperature for a Cure rate control value. */
export const cureSpeed = (control: number): number => lerp(0.035, 0.75, Math.pow(clamp(control / 100), 1.4));

/** Very warm resin stays workable: it cures at under half speed until it has cooled. */
export const temperatureCureFactor = (temperature: number): number => lerp(1, 0.4, smoothstep(0.4, 1, temperature));

/**
 * dcure/dt = cureRate · fill · temperatureCureFactor. Cure only ever goes up, except where fresh
 * resin is brushed on top (handled at deposit time).
 */
export function cureResin(edge: CrackEdge, dt: number, controls: ResinControls): void {
  const { fill, cure, temperature } = edge.resin;
  const speed = cureSpeed(controls.cureRate) * dt;
  for (let i = 0; i < fill.length; i++) {
    if (fill[i] <= 0 || cure[i] >= 1) continue;
    cure[i] = Math.min(1, cure[i] + speed * fill[i] * temperatureCureFactor(temperature[i]));
  }
}

/** Refreshes the per-edge summaries from the per-sample fields. */
export function summariseEdge(edge: CrackEdge): void {
  const { fill, cure, temperature } = edge.resin;
  let fillSum = 0, cureSum = 0, structural = 0, temperatureSum = 0;
  for (let i = 0; i < fill.length; i++) {
    fillSum += fill[i];
    if (fill[i] >= STRUCTURAL_FILL) {
      cureSum += cure[i];
      temperatureSum += temperature[i];
      structural++;
    }
  }
  edge.fill = fillSum / fill.length;
  // Structural cure: the average over the samples that actually hold enough resin to bond.
  edge.cure = structural > 0 ? cureSum / structural : 0;
  edge.temperature = structural > 0 ? temperatureSum / structural : 0;
}

/** Share of the edge's length that holds cured resin, 0…1 (drives the panel's "Cured" figure). */
export function curedFraction(edge: CrackEdge): number {
  const { fill, cure } = edge.resin;
  let sum = 0;
  for (let i = 0; i < fill.length; i++) sum += cure[i] * Math.min(1, fill[i] / STRUCTURAL_FILL);
  return sum / fill.length;
}

/** True when a not-yet-bonded edge has enough cured resin and its sides are mated. */
export function readyToJoin(edge: CrackEdge): boolean {
  return !edge.joined && edge.shardB !== null && edge.aligned && edge.fill > JOIN_FILL && edge.cure > JOIN_CURE;
}

/**
 * How repaired one edge is, 0…1. A bonded edge counts fully; resin that has been brushed on and
 * cured but whose sides are still apart only counts for a part.
 */
export function structuralRepair(edge: CrackEdge): number {
  if (edge.joined) return 1;
  if (edge.shardB === null) return 0;
  const filled = Math.min(1, edge.fill / JOIN_FILL), cured = Math.min(1, edge.cure / JOIN_CURE);
  return 0.82 * filled * cured * (edge.aligned ? 1 : 0.35);
}

export interface RepairStats {
  /** Percentages over the total repairable crack length. */
  goldFilled: number;
  cured: number;
  repaired: number;
  /** Lengths in world units. */
  totalLength: number;
  openLength: number;
}

export function repairStats(edges: readonly CrackEdge[]): RepairStats {
  let total = 0, filled = 0, cured = 0, repaired = 0, open = 0;
  for (const edge of edges) {
    if (edge.shardB === null) continue; // an exposed boundary has nothing to bond to
    total += edge.length;
    filled += edge.length * edge.fill;
    cured += edge.length * curedFraction(edge);
    repaired += edge.length * structuralRepair(edge);
    if (!edge.joined) open += edge.length;
  }
  if (total <= 0) return { goldFilled: 0, cured: 0, repaired: 0, totalLength: 0, openLength: 0 };
  const percent = (value: number) => clamp((100 * value) / total, 0, 100);
  return { goldFilled: percent(filled), cured: percent(cured), repaired: percent(repaired), totalLength: total, openLength: open };
}
