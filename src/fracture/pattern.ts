import { clamp, FRACTURE, type Controls } from '../config';
import type { BowlSurface } from '../ceramic/uv-surface';
import { polygonCentroid } from '../math/geometry';
import { fractureRadius, makeChart, minimumShardArea, seedCount, type Chart, type ImpactSpec } from './impact';
import { generateCrackNetwork, type CrackNetwork } from './crack-network';
import { buildRegions, type Regions } from './crack-regions';
import { buildDiagram, EDGE_POLE, type Diagram } from './power-diagram';
import { fractureRngSeed, generateSeeds, type Metric, type Seed } from './seeds';

/** Face id of the body that stays in one piece (the foot, after a hard blow); the rest are numbered from 1. */
export const SURVIVOR = 0;

/**
 * The fracture pattern in material space: the cracks the blow made, the convex cells they cut the
 * bowl into, and the grouping of those cells into faces (one face = one shard). Cracks are the
 * boundaries between faces; nothing else is drawn or repaired.
 */
export interface FracturePattern {
  impact: ImpactSpec;
  chart: Chart;
  /** Radius of the crushed zone around the impact, world units. */
  radius: number;
  rngSeed: number;
  /** The generated crack network; null for the Voronoi fallback. */
  network: CrackNetwork | null;
  /** Seeds and metric of the fallback power diagram, when it was used. */
  seeds: Seed[];
  metric: Metric | null;
  /** First grid column of the unwrapped turn the geometry lives in; the seam is opposite the impact. */
  columnStart: number;
  diagram: Diagram;
  /** Face of each cell (of each seed's cell, for the fallback), or -1 when it owns no area. */
  cellFace: Int32Array;
  /** Indices into diagram.cells of the pieces that make up each face. */
  faceCells: number[][];
  faceCount: number;
  /** True when the blow was hard enough to break the wall up all the way round. */
  shattered: boolean;
}

type FractureControls = Pick<Controls, 'brittleness' | 'thickness'>;

/**
 * Impact → crack network → regions of the bowl → faces. The power diagram is used only if the
 * network somehow leaves the bowl in a single piece.
 */
export function buildPattern(surface: BowlSurface, impact: ImpactSpec, resetSeed: number, controls: FractureControls): FracturePattern {
  const energy = clamp(impact.energy, 0, FRACTURE.maxEnergy);
  const spec: ImpactSpec = { ...impact, u: impact.u - Math.floor(impact.u), v: clamp(impact.v), energy };
  const shattered = energy >= FRACTURE.shatterEnergy;
  const radius = fractureRadius(energy) * (shattered ? FRACTURE.crushShare : 1);
  const chart = makeChart(surface, spec.u, spec.v, radius);
  const rngSeed = fractureRngSeed(resetSeed, spec);
  // On the very centre of the underside no crack may go (see crack-network), so there is nothing to grow.
  if (spec.v < 0.1) return buildVoronoiPattern(surface, impact, resetSeed, controls);
  const U = surface.U;
  const columnStart = Math.round(chart.u0 * U) - U / 2;
  const uLeft = columnStart / U, uRight = (columnStart + U) / U;

  const network = generateCrackNetwork({ surface, impact: spec, chart, rngSeed, uLeft, uRight });
  const regions = buildRegions(network, uLeft, uRight);
  const grouped = groupRegions(surface, chart, regions, minimumShardArea(controls));
  if (grouped && grouped.faceCells.length >= 2) {
    return {
      impact: spec, chart, radius, rngSeed, network, seeds: [], metric: null, columnStart, diagram: regions.diagram,
      cellFace: grouped.cellFace, faceCells: grouped.faceCells, faceCount: grouped.faceCells.length, shattered,
    };
  }
  return buildVoronoiPattern(surface, impact, resetSeed, controls);
}

/** The fallback: a weighted Voronoi diagram of seeds, dense round the impact. */
export function buildVoronoiPattern(surface: BowlSurface, impact: ImpactSpec, resetSeed: number, controls: FractureControls): FracturePattern {
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
    impact: spec, chart, radius, rngSeed, network: null, seeds, metric, columnStart, diagram, cellFace, faceCells,
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

/**
 * Groups the regions into the pieces that will be shards: merges any region too small to be a
 * piece into the neighbour it shares most boundary with (the crack between them is then not a
 * break at all), keeps the number of pieces down, picks the body that stays standing (the foot,
 * normally) and numbers the rest outwards from the impact.
 */
function groupRegions(surface: BowlSurface, chart: Chart, regions: Regions, minArea: number): { cellFace: Int32Array; faceCells: number[][] } | null {
  const { diagram, region } = regions;
  const cells = diagram.cells;
  const n = regions.regionCount;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const area = new Float64Array(n);
  const pole = new Uint8Array(n);
  const shared: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());

  cells.forEach((cell, index) => {
    const r = region[index];
    const [, cv] = polygonCentroid(cell.u, cell.v);
    area[r] += cell.areaUV * Math.PI * 2 * surface.radiusAt(clamp(cv)) * chart.scaleV;
    for (let k = 0, m = cell.u.length; k < m; k++) {
      const l = k + 1 === m ? 0 : k + 1;
      const tag = cell.tag[k];
      if (tag === EDGE_POLE) pole[r] = 1;
      if (tag <= index) continue;
      const other = region[tag];
      if (other === r) continue;
      const length = surface.metricLength(cell.u[l] - cell.u[k], cell.v[l] - cell.v[k], clamp((cell.v[k] + cell.v[l]) / 2));
      shared[r].set(other, (shared[r].get(other) ?? 0) + length);
      shared[other].set(r, (shared[other].get(r) ?? 0) + length);
    }
  });

  const union = (small: number, into: number) => {
    const a = find(small), b = find(into);
    if (a === b) return;
    parent[a] = b;
    area[b] += area[a];
    pole[b] |= pole[a];
    for (const [other, length] of shared[a]) {
      const o = find(other);
      if (o === b) continue;
      shared[b].set(o, (shared[b].get(o) ?? 0) + length);
      shared[o].set(b, (shared[o].get(b) ?? 0) + length);
    }
  };
  const roots = (): number[] => { const set = new Set<number>(); for (let i = 0; i < n; i++) set.add(find(i)); return [...set]; };

  for (let guard = 0; guard < n + 2; guard++) {
    const all = roots();
    if (all.length <= 2) break;
    let smallest = all[0], largest = all[0];
    for (const r of all) { if (area[r] < area[smallest]) smallest = r; if (area[r] > area[largest]) largest = r; }
    if (!(area[smallest] < minArea) && all.length <= FRACTURE.maxFragments) break;
    // The neighbour it shares most boundary with, favouring the others over the largest piece so
    // that one piece does not swallow everything round it.
    const totals = new Map<number, number>();
    for (const [other, length] of shared[smallest]) {
      const o = find(other);
      if (o !== smallest) totals.set(o, (totals.get(o) ?? 0) + length);
    }
    let target = -1, best = -1;
    for (const [o, length] of totals) {
      const score = o === largest ? length * 0.6 : length;
      if (score > best) { best = score; target = o; }
    }
    if (target < 0) break;
    union(smallest, target);
  }

  // A piece that reaches a vertex from two sides, with other pieces between, is joined to itself
  // by a single point: a pinch, which is no solid. The smallest piece caught between its arms
  // is made part of it.
  const corners = new Map<number, Array<{ start: number; size: number; cell: number }>>();
  cells.forEach((cell, index) => {
    const m = cell.vid.length;
    for (let k = 0; k < m; k++) {
      const next = (k + 1) % m, previous = (k + m - 1) % m;
      const start = Math.atan2(cell.v[next] - cell.v[k], cell.u[next] - cell.u[k]);
      const end = Math.atan2(cell.v[previous] - cell.v[k], cell.u[previous] - cell.u[k]);
      const list = corners.get(cell.vid[k]) ?? [];
      list.push({ start, size: ((end - start) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2), cell: index });
      corners.set(cell.vid[k], list);
    }
  });
  // The centre of the base is one point, though in material space it is the whole edge v = 0.
  const onPole = cells.map((cell, index) => ({ index, start: cell.v.reduce((lo, v, k) => (v === 0 ? Math.min(lo, cell.u[k]) : lo), Infinity), has: cell.tag.includes(EDGE_POLE) }))
    .filter((c) => c.has).sort((a, b) => a.start - b.start);
  for (let round = 0; round < 24; round++) {
    let merged = false;
    {
      // Going along the pole, a piece that comes back after another has been in between is pinched.
      const faces = onPole.map((c) => find(region[c.index]));
      const runs = new Map<number, number>();
      for (let i = 0; i < faces.length; i++) {
        if (faces[i] !== faces[(i + faces.length - 1) % faces.length]) runs.set(faces[i], (runs.get(faces[i]) ?? 0) + 1);
      }
      for (const [face, count] of runs) {
        if (count < 2) continue;
        let smallest = -1;
        for (const other of new Set(faces)) if (other !== face && (smallest < 0 || area[other] < area[smallest])) smallest = other;
        if (smallest >= 0) { union(smallest, face); merged = true; }
        break;
      }
      if (merged) continue;
    }
    for (const list of corners.values()) {
      if (list.length < 3) continue;
      const sorted = [...list].sort((a, b) => a.start - b.start);
      const faces = sorted.map((c) => find(region[c.cell]));
      if (new Set(faces).size < 2) continue;
      // Around a vertex inside the bowl the pieces close a circle; on an edge of it they do not.
      const around = Math.abs(sorted.reduce((sum, c) => sum + c.size, 0) - Math.PI * 2) < 1e-6;
      const runs = new Map<number, number>();
      for (let i = 0; i < faces.length; i++) {
        const before = i > 0 ? faces[i - 1] : around ? faces[faces.length - 1] : -1;
        if (faces[i] !== before) runs.set(faces[i], (runs.get(faces[i]) ?? 0) + 1);
      }
      for (const [face, count] of runs) {
        if (count < 2) continue;
        let smallest = -1;
        for (const other of new Set(faces)) if (other !== face && (smallest < 0 || area[other] < area[smallest])) smallest = other;
        if (smallest >= 0) { union(smallest, face); merged = true; }
        break;
      }
      if (merged) break;
    }
    if (!merged) break;
  }

  const all = roots();
  if (all.length < 2) return null;
  // What stands: the largest piece that includes the base (the foot, after a hard blow), unless
  // the base has been cut into a scrap, in which case the largest piece there is.
  let widest = all[0];
  for (const r of all) if (area[r] > area[widest]) widest = r;
  let survivor = -1;
  for (const r of all) if (pole[r] && (survivor < 0 || area[r] > area[survivor])) survivor = r;
  if (survivor < 0 || area[survivor] < 0.6) survivor = widest;

  const distance = new Map<number, number>();
  cells.forEach((cell, index) => {
    const r = find(region[index]);
    if (r === survivor) return;
    for (let k = 0; k < cell.u.length; k++) {
      const d = Math.hypot((cell.u[k] - chart.u0) * chart.scaleU, (cell.v[k] - chart.v0) * chart.scaleV);
      if (d < (distance.get(r) ?? Infinity)) distance.set(r, d);
    }
  });
  const ordered = [...distance.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([root]) => root);
  const faceOfRoot = new Map<number, number>([[survivor, SURVIVOR]]);
  ordered.forEach((root, index) => faceOfRoot.set(root, index + 1));

  const cellFace = new Int32Array(cells.length).fill(-1);
  const faceCells: number[][] = Array.from({ length: ordered.length + 1 }, () => []);
  cells.forEach((_, index) => {
    const face = faceOfRoot.get(find(region[index]))!;
    cellFace[index] = face;
    faceCells[face].push(index);
  });
  return { cellFace, faceCells };
}
