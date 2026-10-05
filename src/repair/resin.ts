import { clamp, lerp, smoothstep, type Controls } from '../config';
import type { CrackEdge, CrackNode, ResinField } from '../fracture/crack-graph';

export type ResinControls = Pick<Controls, 'viscosity' | 'temperature' | 'cureRate'>;

/** Temperature the resin relaxes to, on the 0…1 simulation scale. */
export const AMBIENT_TEMPERATURE = 0.12;
/** Seconds for freshly brushed resin to lose most of its heat. */
const COOLING_TIME = 7;
/** Fraction of a sample's resin that may leave it in one step, whatever the mobility. */
const MAX_FLUX_FRACTION = 0.22;
/** Reference sample spacing the mobility constants were tuned at (world units). */
const REFERENCE_SPACING = 0.03;

/** Simulation temperature of resin leaving the brush for a Gold temperature control value. */
export const brushTemperature = (control: number): number => lerp(0.15, 1, clamp(control / 100));

/**
 * How readily resin moves between two neighbouring samples per second.
 * Warm resin is thin, viscous resin is slow, and cured resin does not move at all.
 */
export function mobility(temperature: number, cure: number, controls: ResinControls): number {
  const viscosity = lerp(0.35, 3.2, clamp(controls.viscosity / 100));
  const thermal = 0.3 + 1.5 * clamp(temperature);
  const set = 1 - clamp(cure);
  return (thermal / viscosity) * set * set;
}

/**
 * Brushes resin onto an edge around parameter `s` (0…1 along it). The deposit has a soft
 * footprint `width` world units wide; whatever does not fit spills to the neighbours rather than
 * being lost. Returns the amount actually deposited, in fill × samples.
 */
export function depositResin(edge: CrackEdge, s: number, amount: number, width: number, temperature: number): number {
  const field = edge.resin;
  const n = field.fill.length;
  if (!(amount > 0) || !Number.isFinite(s)) return 0;
  const centre = clamp(s) * (n - 1);
  const radius = Math.max(1, width / Math.max(field.spacing, 1e-4));
  const first = Math.max(0, Math.floor(centre - radius * 2)), last = Math.min(n - 1, Math.ceil(centre + radius * 2));
  let deposited = 0, overflow = 0;
  for (let i = first; i <= last; i++) {
    const d = (i - centre) / radius;
    const want = amount * Math.exp(-d * d) + overflow;
    const room = 1 - field.fill[i];
    const add = Math.min(want, room);
    overflow = want - add;
    mixIn(field, i, add, temperature);
    deposited += add;
  }
  // Anything still left over runs back the other way.
  for (let i = last; i >= first && overflow > 1e-6; i--) {
    const add = Math.min(overflow, 1 - field.fill[i]);
    overflow -= add;
    mixIn(field, i, add, temperature);
    deposited += add;
  }
  return deposited;
}

/**
 * The part of a brush footprint that reaches an edge from beyond one of its ends: the brush is
 * centred `beyond` world units past the end (0 = the edge's start, 1 = its end), on another edge
 * that meets this one there. Returns the amount deposited, in fill × samples.
 */
export function depositResinFromEnd(edge: CrackEdge, end: 0 | 1, beyond: number, amount: number, width: number, temperature: number): number {
  const field = edge.resin;
  const n = field.fill.length;
  if (!(amount > 0) || !(beyond >= 0)) return 0;
  const spacing = Math.max(field.spacing, 1e-4);
  const radius = Math.max(1, width / spacing);
  const offset = beyond / spacing;
  let deposited = 0;
  for (let k = 0; k < n; k++) {
    const d = (k + offset) / radius;
    if (d > 2) break;
    const i = end === 0 ? k : n - 1 - k;
    const add = Math.min(amount * Math.exp(-d * d), 1 - field.fill[i]);
    mixIn(field, i, add, temperature);
    deposited += Math.max(0, add);
  }
  return deposited;
}

/** Adds fresh, uncured resin at one sample, blending temperature and cure by volume. */
function mixIn(field: ResinField, i: number, amount: number, temperature: number): void {
  if (!(amount > 0)) return;
  const before = field.fill[i], after = before + amount;
  field.temperature[i] = (field.temperature[i] * before + temperature * amount) / after;
  field.cure[i] = (field.cure[i] * before) / after;
  field.fill[i] = Math.min(1, after);
}

/**
 * One step of capillary flow along an edge. Resin moves from fuller samples to emptier ones,
 * limited by mobility, with a small extra pull into dry crack. Every transfer is antisymmetric
 * and bounded by what the donor has and what the receiver can hold, so volume is conserved and
 * fill stays inside [0, 1] without clamping.
 */
export function flowResin(edge: CrackEdge, dt: number, controls: ResinControls): void {
  const { fill, cure, temperature, flow } = edge.resin;
  const n = fill.length;
  // Diffusion slows with the square of the spacing; keep behaviour comparable across edges.
  const scale = (REFERENCE_SPACING / Math.max(edge.resin.spacing, 1e-4)) ** 2;
  // All fluxes are worked out from the state at the start of the step and applied afterwards, so
  // the result does not depend on which way the samples are visited. The limits leave room for a
  // sample to give to, or receive from, both of its neighbours at once.
  const flux = new Float32Array(n); // flux[i] > 0 moves resin from sample i to i + 1
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1;
    const difference = fill[i] - fill[j];
    const from = difference >= 0 ? i : j, to = difference >= 0 ? j : i;
    if (fill[from] <= 1e-5) continue;
    const m = Math.min(mobility(temperature[i], cure[i], controls), mobility(temperature[j], cure[j], controls));
    // Capillary action: a wet sample is drawn into a dry neighbour beyond plain levelling.
    const dryness = 1 - smoothstep(0, 0.18, fill[to]);
    const drive = Math.abs(difference) + 0.35 * dryness * fill[from];
    const amount = Math.min(
      drive * m * scale * dt * 7.5,
      fill[from] * MAX_FLUX_FRACTION,
      (1 - fill[to]) * 0.5,
      Math.abs(difference) * 0.25 + 0.02 * dryness * fill[from],
    );
    if (amount > 0) flux[i] = from === i ? amount : -amount;
  }
  flow.fill(0);
  for (let i = 0; i < n - 1; i++) {
    if (flux[i] === 0) continue;
    if (flux[i] > 0) transfer(edge.resin, i, edge.resin, i + 1, flux[i]);
    else transfer(edge.resin, i + 1, edge.resin, i, -flux[i]);
    flow[i] += flux[i];
    flow[i + 1] += flux[i];
  }
}

/** Moves `amount` of resin (in units of sample fill at the donor) between two samples, carrying its heat and cure. */
function transfer(a: ResinField, i: number, b: ResinField, j: number, amount: number): void {
  // Samples of different edges may stand for different lengths of crack.
  const received = (amount * a.spacing) / Math.max(b.spacing, 1e-6);
  const before = b.fill[j], after = before + received;
  if (after > 1e-9) {
    b.temperature[j] = (b.temperature[j] * before + a.temperature[i] * received) / after;
    b.cure[j] = (b.cure[j] * before + a.cure[i] * received) / after;
  }
  b.fill[j] = Math.min(1, after);
  a.fill[i] = Math.max(0, a.fill[i] - amount);
}

/**
 * Lets resin pass between the edge ends that meet at one fracture node. Resin never moves between
 * edges that do not share a node. Between two cracks that are both closed it runs on freely
 * (`conductance`, 0…1); where either is still open there is no gap to draw it along, and it only
 * creeps round the shard's corner (`apart`).
 */
export function exchangeAtNode(
  node: CrackNode,
  edges: readonly CrackEdge[],
  dt: number,
  controls: ResinControls,
  conductance: number,
  apart: number = conductance,
): void {
  if (node.ends.length < 2 || node.boundary === 'pole') return;
  for (let a = 0; a < node.ends.length; a++) {
    for (let b = a + 1; b < node.ends.length; b++) {
      const ea = edges[node.ends[a].edge], eb = edges[node.ends[b].edge];
      if (ea === eb) continue;
      const ia = node.ends[a].end === 0 ? 0 : ea.resin.fill.length - 1;
      const ib = node.ends[b].end === 0 ? 0 : eb.resin.fill.length - 1;
      const fa = ea.resin.fill[ia], fb = eb.resin.fill[ib];
      const difference = fa - fb;
      const [from, fi, to, ti] = difference >= 0 ? [ea, ia, eb, ib] as const : [eb, ib, ea, ia] as const;
      const donor = from.resin.fill[fi], receiver = to.resin.fill[ti];
      if (donor <= 1e-5) continue;
      const m = Math.min(
        mobility(from.resin.temperature[fi], from.resin.cure[fi], controls),
        mobility(to.resin.temperature[ti], to.resin.cure[ti], controls),
      );
      const dryness = 1 - smoothstep(0, 0.18, receiver);
      let flux = (Math.abs(difference) + 0.35 * dryness * donor) * m * dt * 7.5 * (ea.aligned && eb.aligned ? conductance : apart);
      const room = ((1 - receiver) * to.resin.spacing) / Math.max(from.resin.spacing, 1e-6);
      flux = Math.min(flux, donor * MAX_FLUX_FRACTION, room * 0.5, Math.abs(difference) * 0.5 + 0.02 * dryness * donor);
      if (flux > 0) transfer(from.resin, fi, to.resin, ti, flux);
    }
  }
}

/** Resin cools towards ambient; there is no heat source after the brush. */
export function coolResin(edge: CrackEdge, dt: number): void {
  const { temperature, fill } = edge.resin;
  const k = 1 - Math.exp(-dt / COOLING_TIME);
  for (let i = 0; i < temperature.length; i++) {
    if (fill[i] <= 0) { temperature[i] = AMBIENT_TEMPERATURE; continue; }
    temperature[i] += (AMBIENT_TEMPERATURE - temperature[i]) * k;
  }
}

/**
 * True while the edge holds resin that can still flow or cure. A dry crack has nothing to
 * simulate, and neither has one whose resin has set completely: cured resin does not move.
 */
export function resinIsLive(edge: CrackEdge): boolean {
  const { fill, cure } = edge.resin;
  for (let i = 0; i < fill.length; i++) if (fill[i] > 0 && cure[i] < 1) return true;
  return false;
}

/** Total resin on an edge, as fill integrated over its length (world units). */
export function resinVolume(edge: CrackEdge): number {
  let sum = 0;
  for (let i = 0; i < edge.resin.fill.length; i++) sum += edge.resin.fill[i];
  return sum * edge.resin.spacing;
}
