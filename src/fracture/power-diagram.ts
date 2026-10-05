import { clipLine, type Line, type TaggedPolygon } from './clipping';
import type { Metric, Seed } from './seeds';

/** Edge tags of zero and above name the neighbouring seed; these name a boundary instead. */
export const EDGE_RIM = -1;
export const EDGE_POLE = -2;
/**
 * The cut where the unwrapped turn closes on itself. It is not a crack: the same cell carries on
 * at the other end of the turn.
 */
export const EDGE_SEAM = -3;
/** Side of the box a cell starts from; clipping always removes it. */
const EDGE_OPEN = -4;

/**
 * A convex piece of one cell of the weighted (power) Voronoi diagram, inside the unwrapped turn
 * [uLeft, uRight]. A cell that straddles the seam comes as two such pieces.
 * tag[i] says what lies across the edge from vertex i to vertex i + 1.
 */
export interface DiagramCell {
  seed: number;
  u: number[];
  v: number[];
  /** Canonical vertex ids shared with neighbouring cells. */
  vid: number[];
  tag: number[];
  areaUV: number;
}

export interface Diagram {
  cells: DiagramCell[];
  /** Indices into `cells` of the piece or pieces that make up each seed's cell. */
  bySeed: number[][];
  vertexU: number[];
  vertexV: number[];
}

function intersect(l1: Line, l2: Line): [number, number] | null {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-18) return null;
  return [(l1.c * l2.b - l2.c * l1.b) / det, (l1.a * l2.c - l2.a * l1.c) / det];
}

/** A cell corner before it is cut at the seam: canonical id, coordinates in the turn, and which turn it is in. */
interface Corner {
  vid: number;
  u: number;
  v: number;
  /** Turns between the cell's own frame and the stored coordinates. */
  turn: number;
  tag: number;
}

/**
 * Power diagram of the seeds over the whole bowl, under an anisotropic metric:
 *   d_i(p) = (p − s_i)ᵀ G (p − s_i) − w_i.
 * u is periodic, so every seed is also present one turn to either side. With one shared metric
 * every bisector is a straight line, and each cell is a box clipped by one half-plane per other
 * seed image.
 *
 * Vertex positions are then recomputed from the two or three things that meet there, in a fixed
 * order and a fixed frame, so neighbouring cells agree on them to the last bit. Finally cells
 * that cross the seam (the grid column at uLeft ≡ uRight) are cut along it, so that all geometry
 * downstream lives in a single turn.
 */
export function buildDiagram(seeds: readonly Seed[], metric: Metric, uLeft: number, uRight: number): Diagram {
  const n = seeds.length;
  const quad = (u: number, v: number) => metric.guu * u * u + 2 * metric.guv * u * v + metric.gvv * v * v;

  /** Bisector between two seed images; image (i, si) owns the side where a·u + b·v <= c. */
  const bisector = (i: number, si: number, j: number, sj: number): Line => {
    const ui = seeds[i].u + si, uj = seeds[j].u + sj;
    const du = uj - ui, dv = seeds[j].v - seeds[i].v;
    return {
      a: 2 * (metric.guu * du + metric.guv * dv),
      b: 2 * (metric.guv * du + metric.gvv * dv),
      c: quad(uj, seeds[j].v) - quad(ui, seeds[i].v) + seeds[i].weight - seeds[j].weight,
    };
  };

  const vertexU: number[] = [], vertexV: number[] = [];
  const vertexIds = new Map<string, number>();
  const register = (key: string, u: number, v: number): number => {
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = vertexU.length;
      vertexU.push(u);
      vertexV.push(v);
      vertexIds.set(key, id);
    }
    return id;
  };
  /** Brings u into [uLeft, uRight) and reports how many turns that took. */
  const wrap = (u: number): [number, number] => {
    let turn = Math.floor(u - uLeft);
    let w = u - turn;
    if (w < uLeft) { w += 1; turn -= 1; }
    if (w >= uRight) { w -= 1; turn += 1; }
    return [w, turn];
  };

  const tagOf = (seed: number, shift: number): number => seed * 3 + shift + 1;
  const seedOf = (tag: number): number => Math.floor(tag / 3);
  const shiftOf = (tag: number): number => (tag % 3) - 1;

  /**
   * The corner of cell `cell` between edges tagged `incoming` and `outgoing`, in canonical form.
   * (fu, fv) is where clipping put it, in the cell's own frame.
   */
  const corner = (cell: number, incoming: number, outgoing: number, fu: number, fv: number, slot: string): Corner => {
    let key = '';
    let point: [number, number] | null = null;
    let base = 0;
    const boundary = incoming < 0 ? incoming : outgoing < 0 ? outgoing : 0;
    if (incoming >= 0 || outgoing >= 0) {
      // Everything that meets here, as (seed, turn) pairs in a fixed order; the first sets the frame.
      const meet: Array<[number, number]> = [[cell, 0]];
      if (incoming >= 0) meet.push([seedOf(incoming), shiftOf(incoming)]);
      if (outgoing >= 0) meet.push([seedOf(outgoing), shiftOf(outgoing)]);
      meet.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
      base = meet[0][1];
      const [a] = meet[0];
      const [b, sb] = [meet[1][0], meet[1][1] - base];
      const first = bisector(a, 0, b, sb);
      if (meet.length === 3) {
        const [c, sc] = [meet[2][0], meet[2][1] - base];
        key = `${a}|${b}:${sb}|${c}:${sc}`;
        point = intersect(first, bisector(a, 0, c, sc));
      } else if (boundary === EDGE_RIM || boundary === EDGE_POLE) {
        const v = boundary === EDGE_RIM ? 1 : 0;
        key = `${boundary}|${a}|${b}:${sb}`;
        if (Math.abs(first.a) > 1e-12) point = [(first.c - first.b * v) / first.a, v];
      }
    }
    // If the canonical construction disagrees with what clipping found (a near-degenerate
    // junction, or a corner of the starting box), keep the clipped position and do not share it.
    if (!point || Math.hypot(point[0] + base - fu, point[1] - fv) > 1e-7) {
      const [u, turn] = wrap(fu);
      return { vid: register(`X${slot}`, u, fv), u, v: fv, turn, tag: outgoing };
    }
    const [u, turn] = wrap(point[0]);
    const vid = register(key, u, point[1]);
    return { vid, u: vertexU[vid], v: vertexV[vid], turn: turn + base, tag: outgoing };
  };

  /** Where the edge between two corners in neighbouring turns crosses the seam. */
  const seamCrossing = (p: Corner, q: Corner): { vid: number; v: number } => {
    // p is in the earlier turn, q in the later one. Work from the lower vertex id so that both
    // cells sharing this edge compute the very same number.
    let v: number;
    if (p.vid < q.vid) {
      const t = (uRight - p.u) / (q.u + 1 - p.u);
      v = p.v + (q.v - p.v) * t;
    } else {
      const t = (uLeft - q.u) / (p.u - 1 - q.u);
      v = q.v + (p.v - q.v) * t;
    }
    const lo = Math.min(p.v, q.v), hi = Math.max(p.v, q.v);
    v = Math.min(hi, Math.max(lo, v));
    const key = p.vid < q.vid ? `M${p.vid}|${q.vid}` : `M${q.vid}|${p.vid}`;
    const vid = register(key, uLeft, v);
    return { vid, v: vertexV[vid] };
  };

  const cells: DiagramCell[] = [];
  const bySeed: number[][] = Array.from({ length: n }, () => []);
  const emit = (seed: number, part: Array<{ u: number; v: number; vid: number; tag: number }>): void => {
    if (part.length < 3) return;
    let area = 0;
    for (let k = 0, m = part.length; k < m; k++) {
      const l = k + 1 === m ? 0 : k + 1;
      area += part[k].u * part[l].v - part[l].u * part[k].v;
    }
    area *= 0.5;
    if (!(area > 0)) return;
    bySeed[seed].push(cells.length);
    cells.push({
      seed,
      u: part.map((p) => p.u),
      v: part.map((p) => p.v),
      vid: part.map((p) => p.vid),
      tag: part.map((p) => p.tag),
      areaUV: area,
    });
  };

  for (let i = 0; i < n; i++) {
    const su = seeds[i].u;
    let poly: TaggedPolygon = {
      u: [su - 1.25, su + 1.25, su + 1.25, su - 1.25],
      v: [0, 0, 1, 1],
      tag: [EDGE_POLE, EDGE_OPEN, EDGE_RIM, EDGE_OPEN],
    };
    for (let j = 0; j < n && poly.u.length >= 3; j++) {
      for (let shift = -1; shift <= 1 && poly.u.length >= 3; shift++) {
        if (j === i && shift === 0) continue;
        poly = clipLine(poly, bisector(i, 0, j, shift), 1, tagOf(j, shift));
      }
    }
    const count = poly.u.length;
    if (count < 3 || poly.tag.includes(EDGE_OPEN)) continue;

    // Canonical corners, with repeats collapsed.
    const corners: Corner[] = [];
    for (let k = 0; k < count; k++) {
      const incoming = poly.tag[(k + count - 1) % count];
      const c = corner(i, incoming, poly.tag[k], poly.u[k], poly.v[k], `${i}:${k}`);
      if (corners.length > 0 && corners[corners.length - 1].vid === c.vid) {
        corners[corners.length - 1].tag = c.tag;
        continue;
      }
      corners.push(c);
    }
    if (corners.length > 1 && corners[0].vid === corners[corners.length - 1].vid) corners.pop();
    if (corners.length < 3) continue;
    // From here on an edge only needs to name its neighbour, not which copy of it.
    for (const c of corners) if (c.tag >= 0) c.tag = seedOf(c.tag);

    let first = Infinity, last = -Infinity;
    for (const c of corners) { first = Math.min(first, c.turn); last = Math.max(last, c.turn); }
    if (first === last) {
      emit(i, corners);
      continue;
    }
    if (last - first !== 1) continue; // wider than a whole turn: cannot happen with seeds all round

    // The cell straddles the seam: cut it into the part before (A) and the part after (B).
    // A corner lying exactly on the seam belongs to both.
    const side = corners.map((c) => (c.turn === last && c.u === uLeft ? 0 : c.turn === first ? -1 : 1));
    const A: Array<{ u: number; v: number; vid: number; tag: number }> = [];
    const B: Array<{ u: number; v: number; vid: number; tag: number }> = [];
    for (let k = 0, m = corners.length; k < m; k++) {
      const l = k + 1 === m ? 0 : k + 1;
      const c = corners[k], next = side[l];
      if (side[k] <= 0) A.push({ u: side[k] === 0 ? uRight : c.u, v: c.v, vid: c.vid, tag: side[k] === 0 && next === 1 ? EDGE_SEAM : c.tag });
      if (side[k] >= 0) B.push({ u: side[k] === 0 ? uLeft : c.u, v: c.v, vid: c.vid, tag: side[k] === 0 && next === -1 ? EDGE_SEAM : c.tag });
      if (side[k] === -1 && next === 1) {
        const x = seamCrossing(c, corners[l]);
        A.push({ u: uRight, v: x.v, vid: x.vid, tag: EDGE_SEAM });
        B.push({ u: uLeft, v: x.v, vid: x.vid, tag: c.tag });
      } else if (side[k] === 1 && next === -1) {
        const x = seamCrossing(corners[l], c);
        B.push({ u: uLeft, v: x.v, vid: x.vid, tag: EDGE_SEAM });
        A.push({ u: uRight, v: x.v, vid: x.vid, tag: c.tag });
      }
    }
    emit(i, A);
    emit(i, B);
  }
  return { cells, bySeed, vertexU, vertexV };
}
