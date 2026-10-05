import { TOPOLOGY } from '../config';
import { INNER, OUTER, type BowlSurface } from '../ceramic/uv-surface';
import { polygonCentroid } from '../math/geometry';
import type { Vec3 } from '../math/vec';
import { clipLine, type Line, type TaggedPolygon } from './clipping';
import type { FracturePattern } from './pattern';
import { EDGE_POLE } from './power-diagram';

/**
 * Mating shards are pulled back from their shared crack by this much (world units at the impact
 * latitude) when building colliders, so hulls of neighbours never start out interpenetrating.
 */
const INSET = 0.012;

/** Collision blocks: 16 around the bowl (from the coarse topology grid). */
const BLOCKS_U = TOPOLOGY.u / TOPOLOGY.blockU;
/**
 * Rows of the tessellation grid at which blocks are cut along the profile. The base is cut at
 * every change of direction (underside, inside of the foot, its bottom, its outside, the neck),
 * because a hull that bridged those would fill the recess under the bowl; the belly is cut evenly.
 */
const BLOCK_ROWS = [0, 2, 5, 13, 17, 26, 35, 44, 54, 63, 72];
/** The innermost band, round the axis. */
const POLE_BLOCK = 0;
/** First block of the belly, where the shell is smooth enough for larger hulls. */
const BELLY_BLOCK = 4;
/** On the belly a hull spans at most this many blocks round the bowl; on the small, flat base twice that. */
const SINGLE_HULL_SPAN = 1.0;
/** …and no hull runs further than this along the profile (world units). */
const MAX_HULL_HEIGHT = 0.5;

type Poly = { u: number[]; v: number[] };

function clip(poly: Poly, line: Line, sign: number): Poly {
  const tagged: TaggedPolygon = { u: poly.u, v: poly.v, tag: new Array(poly.u.length).fill(0) };
  const out = clipLine(tagged, line, sign, 0);
  return { u: out.u, v: out.v };
}

function clipToRect(poly: Poly, u0: number, u1: number, v0: number, v1: number): Poly {
  let out = clip(poly, { a: 1, b: 0, c: u0 }, -1);
  out = clip(out, { a: 1, b: 0, c: u1 }, 1);
  out = clip(out, { a: 0, b: 1, c: v0 }, -1);
  return clip(out, { a: 0, b: 1, c: v1 }, 1);
}

function area(poly: Poly): number {
  let a = 0;
  for (let i = 0, n = poly.u.length; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a += poly.u[i] * poly.v[j] - poly.u[j] * poly.v[i];
  }
  return a * 0.5;
}

/**
 * Point cloud for the convex hull of a thin shell patch: the patch outline, with long edges split
 * so the hull follows the curvature, plus its centre, on both skins.
 */
function hullPoints(surface: BowlSurface, poly: Poly, centroid: Vec3): Float32Array | null {
  const n = poly.u.length;
  if (n < 3) return null;
  const us: number[] = [], vs: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const du = poly.u[j] - poly.u[i], dv = poly.v[j] - poly.v[i];
    const steps = Math.max(1, Math.min(3, Math.ceil(Math.max(Math.abs(du) * 30, Math.abs(dv) * 8))));
    for (let s = 0; s < steps; s++) {
      us.push(poly.u[i] + (du * s) / steps);
      vs.push(poly.v[i] + (dv * s) / steps);
    }
  }
  const [cu, cv] = polygonCentroid(poly.u, poly.v);
  us.push(cu);
  vs.push(cv);
  const out = new Float32Array(us.length * 6);
  for (let i = 0; i < us.length; i++) {
    const v = Math.min(1, Math.max(0, vs[i]));
    const o = surface.position(OUTER, us[i], v), q = surface.position(INNER, us[i], v);
    out[i * 6] = o[0] - centroid[0]; out[i * 6 + 1] = o[1] - centroid[1]; out[i * 6 + 2] = o[2] - centroid[2];
    out[i * 6 + 3] = q[0] - centroid[0]; out[i * 6 + 4] = q[1] - centroid[1]; out[i * 6 + 5] = q[2] - centroid[2];
  }
  return out;
}

/**
 * Convex pieces approximating a shard for collision. A curved shell is far from convex, so every
 * cell of the shard is cut along a coarse material-space block grid and each block gets its own
 * hull. With no pattern the whole bowl is covered, block by block.
 */
export function buildHulls(surface: BowlSurface, pattern: FracturePattern | null, face: number, centroid: Vec3): Float32Array[] {
  const hulls: Float32Array[] = [];
  const add = (poly: Poly) => {
    if (poly.u.length < 3 || !(area(poly) > 2e-6)) return;
    const points = hullPoints(surface, poly, centroid);
    if (points) hulls.push(points);
  };
  const U = surface.U;
  const blockColumns = U / BLOCKS_U;
  const BLOCKS_V = BLOCK_ROWS.length - 1;
  const rowAt = (b: number) => surface.rows[BLOCK_ROWS[b]];

  if (!pattern) {
    for (let bv = 0; bv < BLOCKS_V; bv++) {
      const v0 = rowAt(bv), v1 = rowAt(bv + 1);
      const width = bv < BELLY_BLOCK ? blockColumns * 2 : blockColumns;
      for (let c0 = 0; c0 < U; c0 += width) {
        const c1 = c0 + width;
        add({ u: [c0 / U, c1 / U, c1 / U, c0 / U], v: [v0, v0, v1, v1] });
      }
    }
    return hulls;
  }

  const { diagram, cellFace, chart } = pattern;
  // Round the axis every wedge would overlap its neighbours, so only a shard that owns the whole
  // of that disc gets hulls in it.
  const ownsPole = diagram.cells.every((cell) => !cell.tag.includes(EDGE_POLE) || cellFace[cell.seed] === face);

  for (const index of pattern.faceCells[face]) {
    const cell = diagram.cells[index];
    let poly: Poly = { u: [...cell.u], v: [...cell.v] };
    // Pull every edge shared with a different shard inwards.
    for (let k = 0, n = cell.u.length; k < n && poly.u.length >= 3; k++) {
      const l = k + 1 === n ? 0 : k + 1;
      const tag = cell.tag[k];
      if (tag < 0) continue;
      const other = cellFace[tag];
      if (other === face || other < 0) continue;
      const du = cell.u[l] - cell.u[k], dv = cell.v[l] - cell.v[k];
      const metric = Math.hypot(du * chart.scaleU, dv * chart.scaleV);
      const shift = (INSET * metric) / (chart.scaleU * chart.scaleV);
      // Interior is on the left of k → l: keep cross((l − k), (x − k)) >= shift.
      const a = -dv, b = du;
      poly = clip(poly, { a, b, c: a * cell.u[k] + b * cell.v[k] + shift }, -1);
    }
    if (poly.u.length < 3) continue;

    const minU = Math.min(...poly.u), maxU = Math.max(...poly.u);
    const minV = Math.min(...poly.v), maxV = Math.max(...poly.v);
    const spanU = ((maxU - minU) * U) / blockColumns;
    let bv = ownsPole ? POLE_BLOCK : POLE_BLOCK + 1;
    while (bv < BLOCKS_V) {
      const v0 = rowAt(bv);
      if (rowAt(bv + 1) <= minV) { bv++; continue; }
      if (v0 >= maxV) break;
      // On the belly a hull may run over several blocks as long as it stays short along the profile.
      let top = bv;
      if (bv >= BELLY_BLOCK) {
        const from = Math.max(minV, v0);
        while (top + 1 < BLOCKS_V && rowAt(top + 1) < maxV && (Math.min(maxV, rowAt(top + 2)) - from) * surface.profile.length <= MAX_HULL_HEIGHT) top++;
      }
      const v1 = rowAt(top + 1);
      const cuts = Math.max(1, Math.ceil(spanU / (bv < BELLY_BLOCK ? SINGLE_HULL_SPAN * 2 : SINGLE_HULL_SPAN) - 1e-9));
      for (let i = 0; i < cuts; i++) {
        add(clipToRect(poly, minU + ((maxU - minU) * i) / cuts, minU + ((maxU - minU) * (i + 1)) / cuts, v0, v1));
      }
      bv = top + 1;
    }
  }
  return hulls;
}
