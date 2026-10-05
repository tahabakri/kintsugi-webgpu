import { clamp, FRACTURE, type Controls } from '../config';
import type { BowlSurface } from '../ceramic/uv-surface';
import { polygonCentroid } from '../math/geometry';
import { fractureRadius, makeChart, minimumShardArea, seedCount, type Chart, type ImpactSpec } from './impact';
import { buildDiagram, type Diagram } from './power-diagram';
import { fractureRngSeed, generateSeeds, type Metric, type Seed } from './seeds';

/** Face id of the body that stays in one piece (the foot, after a hard blow); the rest are numbered from 1. */
export const SURVIVOR = 0;

/**
 * The fracture pattern in material space: a power diagram over the whole bowl, dense around the
 * impact and coarse away from it, and the grouping of its cells into faces (one face = one shard).
 */
export interface FracturePattern {
  impact: ImpactSpec;
  chart: Chart;
  /** Radius of the crushed zone around the impact, world units. */
  radius: number;
  rngSeed: number;
  seeds: Seed[];
  metric: Metric;
  /** First grid column of the unwrapped turn the geometry lives in; the seam is opposite the impact. */
  columnStart: number;
  diagram: Diagram;
  /** Face of each seed's cell, or -1 when the seed owns no area. */
  cellFace: Int32Array;
  /** Indices into diagram.cells of the pieces that make up each face. */
  faceCells: number[][];
  faceCount: number;
  /** True when the blow was hard enough to break the wall up all the way round. */
  shattered: boolean;
}

type FractureControls = Pick<Controls, 'brittleness' | 'thickness'>;

export function buildPattern(surface: BowlSurface, impact: ImpactSpec, resetSeed: number, controls: FractureControls): FracturePattern {
  const energy = clamp(impact.energy, 0, FRACTURE.maxEnergy);
  const spec: ImpactSpec = { ...impact, u: impact.u - Math.floor(impact.u), v: clamp(impact.v), energy };
  const shattered = energy >= FRACTURE.shatterEnergy;
  // A blow that breaks the whole wall spends itself on long cracks: the zone it crushes into
  // small fragments is tighter than the hole a lighter blow punches out.
  const radius = fractureRadius(energy) * (shattered ? FRACTURE.crushShare : 1);
  const chart = makeChart(surface, spec.u, spec.v, radius);
  const rngSeed = fractureRngSeed(resetSeed, spec);
  const count = seedCount(energy, controls);

  // The turn is cut on the grid column opposite the impact, so nothing near the blow sits on the cut.
  const U = surface.U;
  const columnStart = Math.round(chart.u0 * U) - U / 2;
  const uLeft = columnStart / U, uRight = (columnStart + U) / U;

  const { seeds, metric } = generateSeeds(chart, spec, radius, count, rngSeed, uLeft);
  const diagram = buildDiagram(seeds, metric, uLeft, uRight);
  const { cellFace, faceCells } = groupFaces(surface, chart, seeds, diagram, minimumShardArea(controls));
  return {
    impact: spec, chart, radius, rngSeed, seeds, metric, columnStart, diagram, cellFace, faceCells,
    faceCount: faceCells.length,
    shattered,
  };
}

/**
 * Joins the shell cells into the bodies that stay whole, merges cells that would make slivers
 * into their most strongly connected neighbour, then numbers the resulting faces: the surviving
 * body first, the others outward from the impact.
 */
function groupFaces(
  surface: BowlSurface,
  chart: Chart,
  seeds: readonly Seed[],
  diagram: Diagram,
  minArea: number,
): { cellFace: Int32Array; faceCells: number[][] } {
  const n = seeds.length;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const owns = (i: number): boolean => diagram.bySeed[i].length > 0;
  const area = new Float64Array(n);
  /** True for groups that grew from shell seeds. */
  const shell = new Uint8Array(n);
  const shared: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());

  for (const cell of diagram.cells) {
    const i = cell.seed;
    const [, cv] = polygonCentroid(cell.u, cell.v);
    area[i] += cell.areaUV * Math.PI * 2 * surface.radiusAt(clamp(cv)) * chart.scaleV;
    for (let k = 0, m = cell.u.length; k < m; k++) {
      const l = k + 1 === m ? 0 : k + 1;
      const tag = cell.tag[k];
      // Each shared edge is seen from both cells; count it once.
      if (tag <= i || !owns(tag)) continue;
      const length = surface.metricLength(cell.u[l] - cell.u[k], cell.v[l] - cell.v[k], clamp((cell.v[k] + cell.v[l]) / 2));
      shared[i].set(tag, (shared[i].get(tag) ?? 0) + length);
      shared[tag].set(i, (shared[tag].get(i) ?? 0) + length);
    }
  }
  for (let i = 0; i < n; i++) shell[i] = seeds[i].role === 'shell' ? 1 : 0;

  const union = (small: number, into: number) => {
    const a = find(small), b = find(into);
    if (a === b) return;
    parent[a] = b;
    area[b] += area[a];
    shell[b] |= shell[a];
    for (const [other, length] of shared[a]) {
      const o = find(other);
      if (o === b) continue;
      shared[b].set(o, (shared[b].get(o) ?? 0) + length);
      shared[o].set(b, (shared[o].get(b) ?? 0) + length);
    }
  };

  // Shell cells that touch are one body.
  for (let i = 0; i < n; i++) {
    if (!owns(i) || seeds[i].role !== 'shell') continue;
    for (const other of [...shared[i].keys()]) {
      if (seeds[other].role === 'shell') union(i, other);
    }
  }

  const roots = (): number[] => {
    const set = new Set<number>();
    for (let i = 0; i < n; i++) if (owns(i)) set.add(find(i));
    return [...set];
  };

  for (let guard = 0; guard < n + 2; guard++) {
    const all = roots();
    if (all.length <= 2) break;
    let smallest = all[0];
    for (const r of all) if (area[r] < area[smallest]) smallest = r;
    const tooMany = all.length > FRACTURE.maxFragments;
    if (!(area[smallest] < minArea) && !tooMany) break;

    // Most appropriate neighbour: the one sharing the longest boundary, favouring other fragments
    // over the surviving body so that it does not swallow every piece along its edge.
    const totals = new Map<number, number>();
    for (const [other, length] of shared[smallest]) {
      const o = find(other);
      if (o !== smallest) totals.set(o, (totals.get(o) ?? 0) + length);
    }
    let target = -1, best = -1;
    for (const [o, length] of totals) {
      const score = shell[o] ? length * 0.6 : length;
      if (score > best) { best = score; target = o; }
    }
    if (target < 0) break;
    union(smallest, target);
  }

  // The surviving body is the largest group of shell cells; with none left, the largest piece.
  const all = roots();
  let survivor = -1;
  for (const r of all) if (shell[r] && (survivor < 0 || area[r] > area[survivor])) survivor = r;
  if (survivor < 0) for (const r of all) if (survivor < 0 || area[r] > area[survivor]) survivor = r;

  let du: number;
  const distance = (i: number) => {
    du = seeds[i].u - chart.u0;
    du -= Math.round(du);
    return Math.hypot(du * chart.scaleU, (seeds[i].v - chart.v0) * chart.scaleV);
  };
  const nearest = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (!owns(i)) continue;
    const r = find(i);
    if (r === survivor) continue;
    nearest.set(r, Math.min(nearest.get(r) ?? Infinity, distance(i)));
  }
  const ordered = [...nearest.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([root]) => root);
  const faceOfRoot = new Map<number, number>([[survivor, SURVIVOR]]);
  ordered.forEach((root, index) => faceOfRoot.set(root, index + 1));

  const cellFace = new Int32Array(n).fill(-1);
  const faceCells: number[][] = Array.from({ length: ordered.length + 1 }, () => []);
  for (let i = 0; i < n; i++) {
    if (!owns(i)) continue;
    const face = faceOfRoot.get(find(i))!;
    cellFace[i] = face;
    for (const index of diagram.bySeed[i]) faceCells[face].push(index);
  }
  return { cellFace, faceCells };
}
