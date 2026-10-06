import type { CrackNetwork } from './crack-network';
import { EDGE_POLE, EDGE_RIM, EDGE_SEAM, type Diagram, type DiagramCell } from './power-diagram';

/**
 * The bowl's surface cut along a crack network: convex cells, and which connected region
 * (which piece, before small ones are merged away) each belongs to.
 */
export interface Regions {
  /** Convex cells. Every cell is its own "seed": cell i is `diagram.cells[i]` and `bySeed[i] === [i]`. */
  diagram: Diagram;
  /** Region of each cell. */
  region: Int32Array;
  regionCount: number;
}

interface Cell {
  u: number[];
  v: number[];
  vid: number[];
  /** Across the edge from vertex i to i + 1: another cell's index (≥ 0), or one of the EDGE_ constants. */
  tag: number[];
}

/** An edge that a cell has with the slab to its left or right, to be given its neighbour once every slab exists. */
interface Pending {
  cell: number;
  edge: number;
  side: -1 | 1;
}

const EPSILON = 1e-12;
/** Vertices closer than this in u are put on one vertical line. */
const SNAP = 1e-9;
/** A piece closer to vertical than this is turned a hair, so that the sweep can order it. */
const VERTICAL = 1e-7;

/**
 * Cuts the unwrapped turn [uLeft, uRight] × [0, 1] along the network's cracks. A vertical sweep
 * stops at every vertex: between two stops no piece starts or ends, the pieces crossing it do not
 * cross each other, and the strips between consecutive pieces are convex quadrilaterals. Strips
 * that are side by side are one region (nothing lies between them); regions are the connected
 * stretches of surface between cracks, joined across the seam where the turn closes. Cells inside
 * a region are then merged wherever the union stays convex.
 *
 * The rim (v = 1) and the pole (v = 0) are cut at every crack that reaches them; no crack touches
 * the seam, so the first and last strips span the whole height.
 */
export function buildRegions(network: CrackNetwork, uLeft: number, uRight: number): Regions {
  const vertexU = [...network.u], vertexV = [...network.v];
  // Two vertices in one place are one vertex.
  const merged = new Int32Array(vertexU.length).map((_, i) => i);
  const placed = new Map<string, number>();
  vertexU.forEach((u, i) => {
    const key = `${u}|${vertexV[i]}`;
    const first = placed.get(key);
    if (first === undefined) placed.set(key, i);
    else merged[i] = first;
  });
  const corner = (u: number, v: number): number => { vertexU.push(u); vertexV.push(v); return vertexU.length - 1; };
  const bl = corner(uLeft, 0), br = corner(uRight, 0), tl = corner(uLeft, 1), tr = corner(uRight, 1);

  // Pieces: the cracks, and the rim and the pole cut where the cracks meet them.
  interface Piece { a: number; b: number; edge: number }
  const pieces: Piece[] = network.segments.map(([a, b]) => ({ a: merged[a], b: merged[b], edge: 0 })).filter((p) => p.a !== p.b);
  const along = (v: number, first: number, last: number, edge: number) => {
    const on = [first, last];
    for (let i = 0; i < network.u.length; i++) if (network.v[i] === v && merged[i] === i) on.push(i);
    on.sort((x, y) => vertexU[x] - vertexU[y]);
    for (let i = 0; i + 1 < on.length; i++) if (on[i] !== on[i + 1]) pieces.push({ a: on[i], b: on[i + 1], edge });
  };
  along(0, bl, br, EDGE_POLE);
  along(1, tl, tr, EDGE_RIM);

  // Vertices on one vertical line share it exactly; a piece too near vertical is turned a hair.
  const order = vertexU.map((_, i) => i).sort((p, q) => vertexU[p] - vertexU[q]);
  for (let i = 1; i < order.length; i++) {
    // Only crack vertices move; the corners are exactly where the turn begins and ends.
    if (order[i] < bl && vertexU[order[i]] - vertexU[order[i - 1]] < SNAP) vertexU[order[i]] = vertexU[order[i - 1]];
  }
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const p of pieces) {
      if (Math.abs(vertexU[p.a] - vertexU[p.b]) < VERTICAL && p.edge === 0) {
        vertexU[p.b] += 4 * VERTICAL;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // Left to right.
  for (const p of pieces) if (vertexU[p.a] > vertexU[p.b]) { const t = p.a; p.a = p.b; p.b = t; }
  const live = pieces.filter((p) => vertexU[p.a] < vertexU[p.b]);

  const xs = [...new Set(vertexU)].sort((p, q) => p - q);
  const slabs = xs.length - 1;
  const xIndex = new Map<number, number>(xs.map((x, i) => [x, i]));
  const starts = live.map((_, i) => i).sort((p, q) => vertexU[live[p].a] - vertexU[live[q].a] || p - q);

  const pointV = (piece: Piece, x: number): number => {
    const ua = vertexU[piece.a], ub = vertexU[piece.b];
    return vertexV[piece.a] + ((vertexV[piece.b] - vertexV[piece.a]) * (x - ua)) / (ub - ua);
  };
  // The vertex where a piece crosses a vertical line: its own end, or a new one shared by what lies either side.
  const wallVertex = new Map<string, number>();
  const vertexOn = (index: number, x: number): number => {
    const piece = live[index];
    if (x === vertexU[piece.a]) return piece.a;
    if (x === vertexU[piece.b]) return piece.b;
    const key = `${index}:${xIndex.get(x)}`;
    let id = wallVertex.get(key);
    if (id === undefined) {
      vertexU.push(x);
      vertexV.push(pointV(piece, x));
      id = vertexU.length - 1;
      wallVertex.set(key, id);
    }
    return id;
  };

  // Sweep.
  const cells: Cell[] = [];
  const pending: Pending[] = [];
  /** Per slab: the pieces crossing it, bottom to top, and the cells between them. */
  const crossing: number[][] = [];
  const slabCells: Array<Array<{ id: number; lo: number; hi: number; leftLow: number; leftHigh: number; rightLow: number; rightHigh: number }>> = [];
  const active: number[] = [];
  let next = 0;
  for (let s = 0; s < slabs; s++) {
    const x0 = xs[s], x1 = xs[s + 1], xm = (x0 + x1) / 2;
    while (next < starts.length && vertexU[live[starts[next]].a] <= x0) active.push(starts[next++]);
    for (let i = active.length - 1; i >= 0; i--) if (vertexU[live[active[i]].b] <= x0) active.splice(i, 1);
    active.sort((p, q) => pointV(live[p], xm) - pointV(live[q], xm));
    crossing.push([...active]);
  }

  // Every vertex that lies on the vertical line at xs[w], with the pieces on either side of it.
  const wall: Array<Array<{ v: number; id: number }>> = [];
  for (let w = 0; w <= slabs; w++) {
    const x = xs[w];
    const found = new Map<number, number>();
    for (const side of [w - 1, w]) {
      if (side < 0 || side >= slabs) continue;
      for (const index of crossing[side]) { const id = vertexOn(index, x); found.set(id, vertexV[id]); }
    }
    wall.push([...found].map(([id, v]) => ({ id, v })).sort((p, q) => p.v - q.v));
  }

  for (let s = 0; s < slabs; s++) {
    const x0 = xs[s], x1 = xs[s + 1];
    const list = crossing[s];
    const here: typeof slabCells[number] = [];
    for (let j = 0; j + 1 < list.length; j++) {
      const lo = list[j], hi = list[j + 1];
      const ll = vertexOn(lo, x0), lr = vertexOn(lo, x1), ul = vertexOn(hi, x0), ur = vertexOn(hi, x1);
      const rightMid = wall[s + 1].filter((p) => p.v > vertexV[lr] + EPSILON && p.v < vertexV[ur] - EPSILON);
      const leftMid = wall[s].filter((p) => p.v > vertexV[ll] + EPSILON && p.v < vertexV[ul] - EPSILON).reverse();
      const ring: Array<{ id: number; kind: 'bottom' | 'right' | 'top' | 'left' }> = [
        { id: ll, kind: 'bottom' }, { id: lr, kind: 'right' }, ...rightMid.map((p) => ({ id: p.id, kind: 'right' as const })),
        { id: ur, kind: 'top' }, { id: ul, kind: 'left' }, ...leftMid.map((p) => ({ id: p.id, kind: 'left' as const })),
      ];
      // Drop vertices that repeat the one before (a strip that closes to a point at one end).
      // The vertex that stays is the later one: it carries the edge that really leaves the point.
      const clean = ring.filter((p, i) => p.id !== ring[(i + 1) % ring.length].id);
      if (clean.length < 3) continue;
      const id = cells.length;
      const cell: Cell = { u: [], v: [], vid: [], tag: [] };
      clean.forEach((p, i) => {
        cell.u.push(vertexU[p.id]); cell.v.push(vertexV[p.id]); cell.vid.push(p.id);
        // Placeholders, settled once every slab exists: -10 across the bottom edge, -11 across the top.
        cell.tag.push(p.kind === 'bottom' ? -10 : p.kind === 'top' ? -11 : -9);
        if (p.kind === 'right') pending.push({ cell: id, edge: i, side: 1 });
        else if (p.kind === 'left') pending.push({ cell: id, edge: i, side: -1 });
      });
      cells.push(cell);
      here.push({ id, lo, hi, leftLow: vertexV[ll], leftHigh: vertexV[ul], rightLow: vertexV[lr], rightHigh: vertexV[ur] });
    }
    slabCells.push(here);
  }

  // Across a crack, the cell above or below in the same slab; across a wall, the one beside.
  slabCells.forEach((here, s) => {
    here.forEach((c, j) => {
      const cell = cells[c.id];
      cell.tag.forEach((t, i) => {
        if (t === -10) {
          const below = here.slice(0, j).reverse().find((o) => o.hi === c.lo);
          cell.tag[i] = below ? below.id : live[c.lo].edge === EDGE_POLE ? EDGE_POLE : -9;
        } else if (t === -11) {
          const above = here.slice(j + 1).find((o) => o.lo === c.hi);
          cell.tag[i] = above ? above.id : live[c.hi].edge === EDGE_RIM ? EDGE_RIM : -9;
        }
      });
    });
  });
  const slabOf = new Int32Array(cells.length);
  slabCells.forEach((here, s) => { for (const c of here) slabOf[c.id] = s; });
  const parent = Int32Array.from({ length: cells.length }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const join = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const neighbourOnWall = (slab: number, v: number, side: 'left' | 'right'): number => {
    for (const o of slabCells[slab] ?? []) {
      const low = side === 'left' ? o.leftLow : o.rightLow, high = side === 'left' ? o.leftHigh : o.rightHigh;
      if (v >= low - EPSILON && v <= high + EPSILON) return o.id;
    }
    return -9;
  };
  for (const p of pending) {
    const cell = cells[p.cell];
    const k = p.edge, l = (k + 1) % cell.vid.length;
    const mid = (cell.v[k] + cell.v[l]) / 2;
    const s = slabOf[p.cell];
    const seam = p.side === 1 ? s === slabs - 1 : s === 0;
    if (seam) {
      cell.tag[k] = EDGE_SEAM;
      // What lies across the seam is the other end of the same turn.
      const other = neighbourOnWall(p.side === 1 ? 0 : slabs - 1, mid, p.side === 1 ? 'left' : 'right');
      if (other >= 0) join(p.cell, other);
    } else {
      const other = neighbourOnWall(s + p.side, mid, p.side === 1 ? 'left' : 'right');
      cell.tag[k] = other;
      if (other >= 0) join(p.cell, other);
    }
  }

  // Merge cells of one region wherever the union is convex.
  const regionOf = Int32Array.from({ length: cells.length }, (_, i) => find(i));
  if (marks.length < vertexU.length) marks = new Int32Array(vertexU.length * 2);
  const alive = new Uint8Array(cells.length).fill(1);
  const redirect = Int32Array.from({ length: cells.length }, (_, i) => i);
  const version = new Int32Array(cells.length);
  const failed = new Map<number, number>();
  const resolve = (x: number): number => {
    if (x < 0) return x;
    while (redirect[x] !== x) { redirect[x] = redirect[redirect[x]]; x = redirect[x]; }
    return x;
  };
  // Whether turning at the middle point of a → b → c keeps the polygon convex.
  const turnsLeft = (au: number, av: number, bu: number, bv: number, cu: number, cv: number): boolean =>
    (bu - au) * (cv - bv) - (bv - av) * (cu - bu) >= -1e-12;
  // A pair that could not be joined can only become joinable if one of the two changes, so the
  // cells to look at are a worklist: all of them to begin with, then those next to a merge.
  const work: number[] = [];
  const queued = new Uint8Array(cells.length).fill(1);
  for (let i = cells.length - 1; i >= 0; i--) work.push(i);
  for (let guard = 0; work.length > 0 && guard < cells.length * 40; guard++) {
    {
      const a = work.pop()!;
      queued[a] = 0;
      if (!alive[a]) continue;
      for (let again = true; again;) {
        again = false;
        const A = cells[a];
        const nA = A.vid.length;
        for (let k = 0; k < nA; k++) {
          const b = resolve(A.tag[k]);
          if (b < 0 || b === a || !alive[b] || regionOf[b] !== regionOf[a]) continue;
          const key = a * cells.length + b;
          const stamp = version[a] + version[b] * 4096;
          if (failed.get(key) === stamp) continue;
          const B = cells[b];
          const nB = B.vid.length;
          const l = (k + 1) % nA;
          const kb = B.vid.findIndex((id, i) => id === A.vid[l] && B.vid[(i + 1) % nB] === A.vid[k] && resolve(B.tag[i]) === a);
          if (kb < 0) { failed.set(key, stamp); continue; }
          // Only the two points where the cells part company can turn the wrong way.
          const pA = (k + nA - 1) % nA, qA = (k + 2) % nA, pB = (kb + 2) % nB, qB = (kb + nB - 1) % nB;
          const ok = turnsLeft(A.u[pA], A.v[pA], A.u[k], A.v[k], B.u[pB], B.v[pB])
            && turnsLeft(B.u[qB], B.v[qB], B.u[kb], B.v[kb], A.u[qA], A.v[qA]);
          const union = ok ? splice(A, k, B, kb, resolve, a, b) : null;
          if (!union) { failed.set(key, stamp); continue; }
          cells[a] = union;
          alive[b] = 0;
          redirect[b] = a;
          version[a]++;
          // What lay next to either cell may now be able to join the new one.
          for (const t of union.tag) { const r = resolve(t); if (r >= 0 && r !== a && !queued[r]) { queued[r] = 1; work.push(r); } }
          again = true;
          break;
        }
      }
    }
  }

  // A vertex that lies in a straight line between two neighbours, with the same cell across both
  // edges, is not a corner of anything: the sweep only put it there. It goes from every cell that
  // has it, or from none, so that cells keep agreeing on their shared edges.
  const removable = new Map<number, boolean>();
  for (let i = 0; i < cells.length; i++) {
    if (!alive[i]) continue;
    const c = cells[i];
    const n = c.vid.length;
    for (let k = 0; k < n; k++) {
      const before = (k + n - 1) % n, after = (k + 1) % n;
      const across = resolve(c.tag[before]);
      const straight = across >= 0 && across === resolve(c.tag[k]) && Math.abs(
        (c.u[k] - c.u[before]) * (c.v[after] - c.v[k]) - (c.v[k] - c.v[before]) * (c.u[after] - c.u[k]),
      ) < 1e-13 && (c.u[k] - c.u[before]) * (c.u[after] - c.u[k]) + (c.v[k] - c.v[before]) * (c.v[after] - c.v[k]) > 0;
      removable.set(c.vid[k], (removable.get(c.vid[k]) ?? true) && straight);
    }
  }
  for (let i = 0; i < cells.length; i++) {
    if (!alive[i]) continue;
    const c = cells[i];
    if (!c.vid.some((id) => removable.get(id))) continue;
    const keep = c.vid.map((id) => !removable.get(id));
    // Dropping a vertex joins two edges that face the same cell, so the edge from the one before it keeps its tag.
    const next: Cell = { u: [], v: [], vid: [], tag: [] };
    c.vid.forEach((id, k) => {
      if (!keep[k]) return;
      next.u.push(c.u[k]); next.v.push(c.v[k]); next.vid.push(id); next.tag.push(c.tag[k]);
    });
    if (next.vid.length >= 3) cells[i] = next;
  }

  // Compact, renumber, and measure.
  const newIndex = new Int32Array(cells.length).fill(-1);
  let count = 0;
  for (let i = 0; i < cells.length; i++) if (alive[i]) newIndex[i] = count++;
  const out: DiagramCell[] = [];
  const region = new Int32Array(count);
  const regionIds = new Map<number, number>();
  for (let i = 0; i < cells.length; i++) {
    if (!alive[i]) continue;
    const c = cells[i];
    let area = 0;
    for (let k = 0, n = c.u.length; k < n; k++) { const l = (k + 1) % n; area += c.u[k] * c.v[l] - c.u[l] * c.v[k]; }
    const tag = c.tag.map((t) => { const r = resolve(t); return r < 0 ? r : newIndex[r]; });
    out.push({ seed: newIndex[i], u: c.u, v: c.v, vid: c.vid, tag, areaUV: area / 2 });
    const root = regionOf[i];
    if (!regionIds.has(root)) regionIds.set(root, regionIds.size);
    region[newIndex[i]] = regionIds.get(root)!;
  }
  return {
    diagram: { cells: out, bySeed: out.map((_, i) => [i]), vertexU, vertexV },
    region,
    regionCount: regionIds.size,
  };
}

/**
 * The cell made by joining A and B along the edge A has from vertex k to k + 1, which is B's edge
 * kb the other way. Null if the union is not convex, or would not be a simple polygon.
 */
let marks = new Int32Array(0);
let epoch = 0;

function splice(A: Cell, k: number, B: Cell, kb: number, resolve: (x: number) => number, a: number, b: number): Cell | null {
  const nA = A.vid.length, nB = B.vid.length;
  const out: Cell = { u: [], v: [], vid: [], tag: [] };
  const take = (c: Cell, i: number) => { out.u.push(c.u[i]); out.v.push(c.v[i]); out.vid.push(c.vid[i]); out.tag.push(c.tag[i]); };
  for (let i = 1; i < nA; i++) take(A, (k + i) % nA);
  for (let i = 1; i < nB; i++) take(B, (kb + i) % nB);
  const n = out.vid.length;
  if (n < 3) return null;
  // No vertex twice: a polygon that touches itself is not one cell.
  epoch++;
  for (let i = 0; i < n; i++) {
    if (marks[out.vid[i]] === epoch) return null;
    marks[out.vid[i]] = epoch;
  }
  // A neighbour that was on both cells would now be on the cell twice over, or on itself.
  for (const t of out.tag) { const r = resolve(t); if (r === a || r === b) return null; }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, l = (i + 2) % n;
    const cross = (out.u[j] - out.u[i]) * (out.v[l] - out.v[j]) - (out.v[j] - out.v[i]) * (out.u[l] - out.u[j]);
    if (cross < -1e-12) return null;
  }
  return out;
}
