import { clamp, FRACTURE } from '../config';
import { hashInts, mulberry32 } from '../math/random';
import type { Vec2 } from '../math/vec';
import { chartToUV, type Chart, type ImpactSpec } from './impact';

/**
 * What a seed's cell becomes:
 *   fragment  a piece of the crushed zone around the impact;
 *   piece     a large piece of wall away from the impact, freed when the blow is hard enough to
 *             break the bowl up all the way round;
 *   shell     part of the body that stays in one piece.
 */
export type SeedRole = 'fragment' | 'piece' | 'shell';

/** A fracture generator in material space with its power-diagram weight (world units²). */
export interface Seed {
  u: number;
  v: number;
  weight: number;
  role: SeedRole;
}

/** Symmetric 2×2 metric in (u, v): d² = guu·du² + 2·guv·du·dv + gvv·dv². */
export interface Metric {
  guu: number;
  guv: number;
  gvv: number;
}

export interface SeedSet {
  seeds: Seed[];
  metric: Metric;
  /** Direction of the blow's tangential component in chart space (unit vector). */
  axis: Vec2;
  /** How far the pattern is drawn out along the axis (0 = round). */
  stretch: number;
  rngSeed: number;
}

/**
 * Deterministic seed for one fracture event. The impact position and energy are quantised so
 * that tiny float differences in a repeated impact cannot change the pattern.
 */
export function fractureRngSeed(resetSeed: number, impact: ImpactSpec): number {
  const u = impact.u - Math.floor(impact.u);
  return hashInts(resetSeed, Math.round(u * 4096), Math.round(clamp(impact.v) * 4096), Math.round(clamp(impact.energy) * 1000));
}

/** Latitude of the ring of seeds that holds the foot together, and of the large wall pieces. */
const BASE_V = 0.25;
const WALL_V = 0.68;
const RIM_V = 0.9;

/**
 * Scatters fracture seeds over the bowl.
 *
 * Around the impact: one seed at the contact, then an inner, a middle and an outer ring with
 * angular and radial jitter. Distances are real distances at the impact latitude.
 *
 * Over the rest of the bowl: a ring on the foot and a handful of seeds up the wall. A weak blow
 * leaves all of those in one piece, with a collar of shell seeds drawing the outline of the hole.
 * A blow at or above FRACTURE.shatterEnergy frees the wall seeds, so the wall comes apart into a
 * few large pieces and only the foot stays standing.
 *
 * `uStart` is the left edge of the unwrapped turn every seed is placed in.
 */
export function generateSeeds(chart: Chart, impact: ImpactSpec, radius: number, count: number, rngSeed: number, uStart: number): SeedSet {
  const rand = mulberry32(rngSeed);
  const energy = clamp(impact.energy);
  const shatter = energy >= FRACTURE.shatterEnergy;
  // Axis the pattern stretches along: the tangential direction of the blow, or a seeded one for square hits.
  let axis: Vec2;
  const tangent = impact.tangent;
  const tangentLength = tangent ? Math.hypot(tangent[0], tangent[1]) : 0;
  const randomAngle = rand() * Math.PI; // always consumed so the stream does not depend on the tangent
  if (tangent && tangentLength > 0.15) axis = [tangent[0] / tangentLength, tangent[1] / tangentLength];
  else axis = [Math.cos(randomAngle), Math.sin(randomAngle)];
  const stretch = 0.12 + 0.2 * energy + 0.18 * clamp(tangentLength);

  // Anisotropic metric: moving across the axis costs more, so cells elongate along it.
  const aniso = 1 + 0.32 * energy + 0.2 * clamp(tangentLength);
  const cross: Vec2 = [-axis[1], axis[0]];
  const mxx = axis[0] * axis[0] + aniso * aniso * cross[0] * cross[0];
  const mxy = axis[0] * axis[1] + aniso * aniso * cross[0] * cross[1];
  const myy = axis[1] * axis[1] + aniso * aniso * cross[1] * cross[1];
  const metric: Metric = {
    guu: mxx * chart.scaleU * chart.scaleU,
    guv: mxy * chart.scaleU * chart.scaleV,
    gvv: myy * chart.scaleV * chart.scaleV,
  };

  const wrap = (u: number): number => {
    let w = u - Math.floor(u - uStart);
    if (w < uStart) w += 1;
    if (w >= uStart + 1) w -= 1;
    return w;
  };
  /** Chart position of a material point, taking the short way round the bowl. */
  const toChart = (u: number, v: number): Vec2 => {
    let du = u - chart.u0;
    du -= Math.round(du);
    return [du * chart.scaleU, (v - chart.v0) * chart.scaleV];
  };
  /** Distance from the impact with the pattern's stretch along the axis undone. */
  const reach = (u: number, v: number): number => {
    const [x, y] = toChart(u, v);
    const along = x * axis[0] + y * axis[1];
    const k = stretch / (1 + stretch);
    return Math.hypot(x - axis[0] * along * k, y - axis[1] * along * k);
  };

  // ---- The rest of the bowl -------------------------------------------------------------------
  const field = mulberry32(hashInts(rngSeed, 0x9e3779b9));
  const far: Seed[] = [];
  const farChart: Vec2[] = [];
  const keepOut = shatter ? radius * 1.12 + 0.1 : radius * 1.5;
  const place = (u: number, v: number, role: SeedRole): void => {
    const w = wrap(u);
    if (reach(w, v) < keepOut) return;
    const p = toChart(w, v);
    for (const q of farChart) if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.3) return;
    farChart.push(p);
    far.push({ u: w, v, weight: 0, role });
  };

  if (!shatter) {
    // The outline of the hole: shell seeds just outside the crushed zone.
    const collar = Math.round(clamp(5.9 * Math.sqrt(count), 10, 22));
    const phase = field() * Math.PI * 2;
    for (let k = 0; k < collar; k++) {
      const angle = phase + ((k + (field() - 0.5) * 0.5) / collar) * Math.PI * 2;
      const r = radius * 1.22 * (1 + (field() - 0.5) * 0.12);
      let x = Math.cos(angle) * r, y = Math.sin(angle) * r;
      const along = x * axis[0] + y * axis[1];
      x += axis[0] * along * stretch;
      y += axis[1] * along * stretch;
      const [u, v] = chartToUV(chart, x, y);
      // Where the collar would fall off the bowl, the hole simply runs out through the rim.
      if (v <= 0.004 || v >= 0.996) continue;
      const w = wrap(u);
      farChart.push(toChart(w, v));
      far.push({ u: w, v, weight: 0, role: 'shell' });
    }
  }

  const baseCount = 8;
  const basePhase = field();
  for (let k = 0; k < baseCount; k++) {
    place(uStart + (k + basePhase + (field() - 0.5) * 0.3) / baseCount, BASE_V + (field() - 0.5) * 0.04, 'shell');
  }
  const wallRole: SeedRole = shatter ? 'piece' : 'shell';
  const wallCount = 5 + (field() < 0.5 ? 1 : 0);
  const wallPhase = field();
  for (let k = 0; k < wallCount; k++) {
    place(uStart + (k + wallPhase + (field() - 0.5) * 0.5) / wallCount, WALL_V + (field() - 0.5) * 0.16, wallRole);
  }
  // A few seeds by the rim, so the large pieces are not all alike.
  const rimCount = 2 + (field() < 0.5 ? 1 : 0);
  for (let k = 0; k < rimCount; k++) {
    place(uStart + field(), RIM_V + (field() - 0.5) * 0.08, wallRole);
  }

  // ---- Around the impact ----------------------------------------------------------------------
  // The large pieces come out of the same budget, so a hard blow does not simply add to the count.
  const pieces = far.reduce((sum, seed) => sum + (seed.role === 'piece' ? 1 : 0), 0);
  const near = Math.max(5, count - pieces);
  const spacing = radius / Math.sqrt(Math.max(1, near));
  const minDistance = 0.42 * spacing;
  const weightScale = (0.1 + 0.2 * energy) * spacing * spacing;
  const placed: Vec2[] = [];
  const seeds: Seed[] = [];
  const tryPlace = (x: number, y: number): boolean => {
    // Mirror seeds that fall off the bowl back inside, so a rim hit still produces rim fragments.
    let [u, v] = chartToUV(chart, x, y);
    if (v > 1) v = 2 - v;
    if (v < 0) v = -v;
    v = clamp(v, 0.004, 0.996);
    const px = (u - chart.u0) * chart.scaleU, py = (v - chart.v0) * chart.scaleV;
    for (const q of placed) {
      if (Math.hypot(q[0] - px, q[1] - py) < minDistance) return false;
    }
    placed.push([px, py]);
    seeds.push({ u: wrap(u), v, weight: (rand() * 2 - 1) * weightScale, role: 'fragment' });
    return true;
  };

  // Seed 0 sits at the contact itself.
  const jitter0 = radius * 0.035;
  tryPlace((rand() - 0.5) * jitter0, (rand() - 0.5) * jitter0);
  seeds[0].weight = Math.abs(seeds[0].weight) * 0.5;

  const remaining = Math.max(0, near - 1);
  const inner = Math.round(remaining * 0.4);
  const middle = Math.round(remaining * 0.4);
  const rings: Array<{ count: number; lo: number; hi: number }> = [
    { count: inner, lo: 0.14, hi: 0.36 },
    { count: middle, lo: 0.42, hi: 0.68 },
    { count: Math.max(0, remaining - inner - middle), lo: 0.76, hi: 0.98 },
  ];
  for (const ring of rings) {
    const phase = rand() * Math.PI * 2;
    for (let k = 0; k < ring.count; k++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const angle = phase + ((k + 0.5 + (rand() - 0.5) * 0.9) / ring.count) * Math.PI * 2;
        const r = radius * (ring.lo + (ring.hi - ring.lo) * rand());
        let x = Math.cos(angle) * r, y = Math.sin(angle) * r;
        const along = x * axis[0] + y * axis[1];
        x += axis[0] * along * stretch;
        y += axis[1] * along * stretch;
        if (tryPlace(x, y)) break;
      }
    }
  }

  return { seeds: [...seeds, ...far], metric, axis, stretch, rngSeed };
}
