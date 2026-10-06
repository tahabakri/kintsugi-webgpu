import { clamp, lerp, smoothstep } from '../config';
import type { BowlSurface } from '../ceramic/uv-surface';
import { hashInts, mulberry32 } from '../math/random';
import type { Chart, ImpactSpec } from './impact';

/**
 * Where a crack's vertices are, and what the interesting ones are:
 *   impact        where the blow landed
 *   branch        where a side crack leaves its parent
 *   intersection  where a crack meets, or crosses, another
 *   rim, base     where a crack runs out at the lip, or into the underside
 *   terminal      where a crack simply stops, for want of energy
 *   path          an ordinary point along a crack
 */
export type NodeKind = 'impact' | 'branch' | 'intersection' | 'rim' | 'base' | 'terminal' | 'path';

export type CrackKind = 'primary' | 'branch' | 'arc' | 'ring' | 'foot';

/** One crack, from where it starts to where it stops: a polyline through the network's vertices. */
export interface NetworkCrack {
  id: number;
  kind: CrackKind;
  /** The crack it grew from, or -1. */
  parentId: number;
  /** 0 for the cracks that start at the impact, 1 for what grows from those, and so on. */
  generation: number;
  /** Energy the crack started with, in world units of length it could still travel. */
  localEnergy: number;
  /** Vertex ids in order; a closed loop ends where it begins. */
  vertices: number[];
}

/**
 * The cracks the blow made, in the bowl's material space (u around, v from the base to the rim),
 * unwrapped over one turn centred on the impact. Vertices are shared: wherever two cracks meet
 * they meet at one vertex, and `segments` are the straight pieces between vertices, no two of
 * which cross.
 */
export interface CrackNetwork {
  u: number[];
  v: number[];
  kind: NodeKind[];
  paths: NetworkCrack[];
  segments: Array<[number, number]>;
  stats: NetworkStats;
}

export interface NetworkStats {
  primary: number;
  branches: number;
  arcs: number;
  rings: number;
  /** Total length of all cracks, world units. */
  totalLength: number;
  vertices: number;
}

/** Step of the propagation, in world units along the bowl's surface. */
const STEP = 0.11;
/** Cracks keep this far (in u) from the cut where the turn closes. */
const SEAM_MARGIN = 0.012;
/**
 * Cracks stay out of the disc at the centre of the underside (v below this). It is a single point
 * in space, so a crack running into it leaves cells with no area to mesh, and it is never seen.
 */
const POLE_REACH = 0.07;
/** Where the foot ring turns into the wall (v). */
const FOOT_TOP = 0.3;
/** World units of travel per unit of normalised energy. */
const REACH = 4.6;
/** Smallest circumference radius used when turning a step into a change of u, so the pole is not singular. */
const MIN_RADIUS = 0.12;

interface Piece {
  a: number;
  b: number;
  path: number;
}

interface Crossing {
  t: number;
  piece: number;
  u: number;
  v: number;
}

/** Everything the generator needs to know about the bowl and the blow. */
export interface NetworkInput {
  surface: BowlSurface;
  impact: ImpactSpec;
  chart: Chart;
  rngSeed: number;
  /** The unwrapped turn the geometry lives in. */
  uLeft: number;
  uRight: number;
}

class Builder {
  readonly u: number[] = [];
  readonly v: number[] = [];
  readonly kind: NodeKind[] = [];
  readonly pieces: Piece[] = [];
  readonly paths: NetworkCrack[] = [];

  constructor(readonly surface: BowlSurface, readonly uMin: number, readonly uMax: number) {}

  /** World distance between two points of the material space. */
  distance(au: number, av: number, bu: number, bv: number): number {
    return Math.hypot((au - bu) * this.circumference((av + bv) / 2), (av - bv) * this.surface.profile.length);
  }

  /** World length per unit of u at latitude v. */
  circumference(v: number): number {
    return Math.PI * 2 * Math.max(this.surface.radiusAt(clamp(v)), MIN_RADIUS);
  }

  vertex(u: number, v: number, kind: NodeKind = 'path'): number {
    this.u.push(u);
    this.v.push(v);
    this.kind.push(kind);
    return this.u.length - 1;
  }

  mark(vertex: number, kind: NodeKind): void {
    // The more specific meaning wins: an impact stays an impact.
    const was = this.kind[vertex];
    if (was === 'path' || was === 'terminal') this.kind[vertex] = kind;
  }

  newPath(kind: CrackKind, parentId: number, generation: number, energy: number, start: number): NetworkCrack {
    const path: NetworkCrack = { id: this.paths.length, kind, parentId, generation, localEnergy: energy, vertices: [start] };
    this.paths.push(path);
    return path;
  }

  connect(path: NetworkCrack, from: number, to: number): void {
    if (from === to) return;
    this.pieces.push({ a: from, b: to, path: path.id });
    path.vertices.push(to);
  }

  /**
   * Crossings of the step from (pu, pv) to (qu, qv) with the existing pieces, nearest first.
   * Pieces that touch a vertex in `skip` are ignored: they are the ones the step starts from.
   */
  crossings(pu: number, pv: number, qu: number, qv: number, skip: ReadonlySet<number>): Crossing[] {
    const out: Crossing[] = [];
    const du = qu - pu, dv = qv - pv;
    for (let i = 0; i < this.pieces.length; i++) {
      const { a, b } = this.pieces[i];
      if (skip.has(a) || skip.has(b)) continue;
      const au = this.u[a], av = this.v[a];
      const eu = this.u[b] - au, ev = this.v[b] - av;
      const denominator = du * ev - dv * eu;
      if (Math.abs(denominator) < 1e-15) continue;
      const t = ((au - pu) * ev - (av - pv) * eu) / denominator;
      const s = ((au - pu) * dv - (av - pv) * du) / denominator;
      if (t < 1e-7 || t > 1 + 1e-7 || s < -1e-7 || s > 1 + 1e-7) continue;
      const tt = Math.min(1, t);
      out.push({ t: tt, piece: i, u: pu + du * tt, v: pv + dv * tt });
    }
    return out.sort((x, y) => x.t - y.t);
  }

  /** Splits a piece where a crack meets it; returns the vertex there (an existing one if it is that close). */
  split(piece: number, u: number, v: number): number {
    const { a, b, path } = this.pieces[piece];
    for (const end of [a, b]) {
      if (this.distance(this.u[end], this.v[end], u, v) < 1e-6) return end;
    }
    const w = this.vertex(u, v, 'intersection');
    this.pieces[piece] = { a, b: w, path };
    this.pieces.push({ a: w, b, path });
    const list = this.paths[path].vertices;
    for (let k = 0; k + 1 < list.length; k++) {
      if (list[k] === a && list[k + 1] === b) { list.splice(k + 1, 0, w); break; }
    }
    return w;
  }
}

/**
 * Generates the cracks of one blow. They start at the impact, run outwards as polylines whose
 * direction persists, drifts with the bowl's stress and wanders a little, lose energy as they go,
 * branch, and stop when they run out of energy, meet another crack, or reach the rim or the base.
 * Round the impact a ring crack (the cone a hard point load leaves) cuts out the crushed zone;
 * arcs run across the radial cracks; a hard blow also opens the foot ring. Everything is
 * deterministic in (impact, seed).
 */
export function generateCrackNetwork(input: NetworkInput): CrackNetwork {
  const { surface, impact, chart, rngSeed, uLeft, uRight } = input;
  const rand = mulberry32(hashInts(rngSeed, 0xc7ac4));
  const L = surface.profile.length;
  const E = clamp(impact.energy);
  const builder = new Builder(surface, uLeft, uRight);
  const uLow = uLeft + SEAM_MARGIN, uHigh = uRight - SEAM_MARGIN;
  // Cracks start on the surface, not on its very edge: the lip's crown and the pole are boundaries.
  const u0 = clamp(chart.u0, uLow, uHigh), v0 = clamp(impact.v, POLE_REACH + 0.004, 0.996);

  // Direction of the blow along the surface, and how glancing it was.
  const tangent = impact.tangent ?? [0, 0];
  const glance = clamp(Math.hypot(tangent[0], tangent[1]));
  const slide = glance > 0.12 ? Math.atan2(tangent[1], tangent[0]) : rand() * Math.PI * 2;
  const slideDirection: [number, number] = [Math.cos(slide), Math.sin(slide)];

  const impactVertex = builder.vertex(u0, v0, 'impact');
  const worldFromImpact = (u: number, v: number): [number, number] => [
    (u - u0) * builder.circumference((v + v0) / 2), (v - v0) * L,
  ];

  let branchBudget = Math.round(E * 7 + (rand() - 0.3));
  const pending: Array<{ from: number; theta: number; energy: number; generation: number; parent: number; kind: CrackKind }> = [];
  const stats: NetworkStats = { primary: 0, branches: 0, arcs: 0, rings: 0, totalLength: 0, vertices: 0 };

  /**
   * Grows a crack from a vertex until it stops. `circling` makes it curve round the impact instead
   * of running away from it (the arcs).
   */
  const grow = (start: number, theta0: number, energy: number, generation: number, parent: number, kind: CrackKind, circling = 0): void => {
    const path = builder.newPath(kind, parent, generation, energy, start);
    let current = start;
    let u = builder.u[start], v = builder.v[start];
    let theta = theta0, wander = 0, e = energy;
    let skip: Set<number> = new Set([start]);
    const e0 = energy;

    for (let step = 0; step < 220 && e > 0; step++) {
      // Direction: persists, is drawn to the way the stress runs (along the wall's profile on the wall,
      // round the foot on the foot), leans away from (or round) the impact, and wanders a little.
      const wall = smoothstep(FOOT_TOP - 0.04, FOOT_TOP + 0.06, v) * 2 - 1;
      const stress = 0.5 * 0.06 * Math.sin(2 * theta) * wall;
      const [wx, wy] = worldFromImpact(u, v);
      const away = Math.atan2(wy, wx);
      const lean = circling !== 0
        ? 0.16 * Math.sin(away + circling * Math.PI / 2 - theta)
        : 0.05 * Math.sin(away - theta);
      wander = 0.85 * wander + 0.15 * (rand() - 0.5) * 1.3;
      theta += stress + lean + wander;
      // Brittle cracks now and then change their mind: a short kink, then on again.
      if (rand() < 0.05) theta += (rand() < 0.5 ? -1 : 1) * (0.25 + 0.3 * rand());

      const ds = STEP;
      const circumference = builder.circumference(v);
      let qu = u + (ds * Math.cos(theta)) / circumference;
      let qv = v + (ds * Math.sin(theta)) / L;
      let ending: NodeKind | null = null;

      // Where the crack leaves the bowl's surface or the turn it lives in, it stops on the edge.
      const toEdge = (t: number, kind: NodeKind): void => {
        qu = u + (qu - u) * t;
        qv = v + (qv - v) * t;
        ending = kind;
      };
      if (qv >= 1) { toEdge((1 - v) / (qv - v), 'rim'); qv = 1; }
      else if (qv < v && qv <= POLE_REACH) { builder.mark(current, 'terminal'); return finish(path); }
      if (qu < uLow) { toEdge((uLow - u) / (qu - u), 'terminal'); qu = uLow; }
      else if (qu > uHigh) { toEdge((uHigh - u) / (qu - u), 'terminal'); qu = uHigh; }

      // A crack that has nowhere left to go (it was already on the edge) stops where it is.
      if (Math.hypot((qu - u) * circumference, (qv - v) * L) < 1e-4) {
        if (ending) builder.mark(current, ending);
        return finish(path);
      }
      const hits = builder.crossings(u, v, qu, qv, skip);
      if (hits.length > 0) {
        const hit = hits[0];
        const w = builder.split(hit.piece, hit.u, hit.v);
        builder.connect(path, current, w);
        builder.mark(w, 'intersection');
        return finish(path);
      }
      const q = builder.vertex(qu, qv, 'path');
      builder.connect(path, current, q);
      current = q; u = qu; v = qv;
      skip = new Set([current]);
      if (ending) { builder.mark(q, ending); return finish(path); }

      // Cost of travelling: the foot ring and the base are tougher going than the wall.
      const toughness = v < FOOT_TOP + 0.02 ? 1.5 : 1;
      e -= ds * toughness;

      // Side cracks leave a crack that still has energy, never right at the impact.
      const distance = Math.hypot(wx, wy);
      if (branchBudget > 0 && distance > 0.4 && e > 0.25 && kind !== 'ring' && generation < 2 && circling === 0) {
        const chance = clamp(0.5 * ds * (0.35 + e / e0), 0, 0.22);
        if (rand() < chance) {
          branchBudget--;
          const sign = rand() < 0.5 ? -1 : 1;
          pending.push({ from: current, theta: theta + sign * (0.5 + 0.55 * rand()), energy: e * (0.4 + 0.2 * rand()), generation: generation + 1, parent: path.id, kind: 'branch' });
          builder.mark(current, 'branch');
          e -= 0.12;
        }
      }
    }
    builder.mark(current, 'terminal');
    finish(path);
  };
  const finish = (path: NetworkCrack): void => {
    if (path.kind === 'primary') stats.primary++;
    else if (path.kind === 'branch') stats.branches++;
    else if (path.kind === 'arc') stats.arcs++;
  };

  /**
   * Adds an open or closed polyline, clipped to the turn and to the bowl's surface. It is cut
   * wherever it crosses another crack, and carries on across it. A closed loop that stays inside
   * closes on its own first vertex.
   */
  const lay = (points: Array<[number, number]>, closed: boolean, kind: CrackKind, parent: number, energy: number, bounds: [number, number] = [uLow, uHigh]): void => {
    const inside = (p: [number, number]) => p[1] > POLE_REACH && p[1] < 1 && p[0] > uLow && p[0] < uHigh;
    if (closed && points.every(inside)) { place(points, kind, parent, energy, true); return; }
    let ring = points;
    if (closed) {
      // Start from a point that is outside, so that no run has to wrap round the start.
      const out = points.findIndex((p) => !inside(p));
      if (out < 0) return;
      ring = [...points.slice(out), ...points.slice(0, out)];
    }
    const edges = closed ? ring.length : ring.length - 1;
    let run: Array<[number, number]> = [];
    const flush = () => { if (run.length >= 2) place(run, kind, parent, energy, false); run = []; };
    for (let i = 0; i < edges; i++) {
      const to = ring[(i + 1) % ring.length];
      const piece = clipSegment(ring[i], to, bounds[0], bounds[1]);
      if (!piece) { flush(); continue; }
      if (run.length === 0 || Math.hypot(run[run.length - 1][0] - piece[0][0], run[run.length - 1][1] - piece[0][1]) > 1e-9) { flush(); run.push(piece[0]); }
      run.push(piece[1]);
      // A piece that was cut short ends the run: the crack has left the bowl.
      if (piece[1] !== to) flush();
    }
    flush();
  };

  const place = (run: Array<[number, number]>, kind: CrackKind, parent: number, energy: number, closedLoop: boolean): void => {
    const edge = (p: [number, number]): NodeKind => (p[1] === 1 ? 'rim' : p[1] === POLE_REACH ? 'terminal' : 'path');
    const first = builder.vertex(run[0][0], run[0][1], edge(run[0]));
    const path = builder.newPath(kind, parent, 1, energy, first);
    let current = first;
    // Lays the step from the current vertex to a point (or to an existing vertex), splitting
    // whatever it crosses on the way.
    const stepTo = (qu: number, qv: number, target: number | null, kindOf: NodeKind): void => {
      const skip = new Set([current, ...(target === null ? [] : [target])]);
      for (const hit of builder.crossings(builder.u[current], builder.v[current], qu, qv, skip)) {
        const w = builder.split(hit.piece, hit.u, hit.v);
        if (w === current) continue;
        builder.connect(path, current, w);
        builder.mark(w, 'intersection');
        current = w;
        skip.add(w);
      }
      const q = target ?? builder.vertex(qu, qv, kindOf);
      builder.connect(path, current, q);
      current = q;
    };
    for (let i = 1; i < run.length; i++) stepTo(run[i][0], run[i][1], null, edge(run[i]));
    if (closedLoop) stepTo(builder.u[first], builder.v[first], first, 'path');
    if (kind === 'ring') stats.rings++;
  };

  // ---- 1. The cracks that leave the impact ---------------------------------------------------
  const primaries = clamp(Math.round(1.2 + 7.5 * E), 2, 9);
  const inFoot = v0 < FOOT_TOP - 0.02;
  const gaps: number[] = [];
  let sum = 0;
  for (let k = 0; k < primaries; k++) { const g = 0.55 + 0.9 * rand(); gaps.push(g); sum += g; }
  let angle = slide + (rand() - 0.5) * 0.5;
  for (let k = 0; k < primaries; k++) {
    // The crack tends to the way the stress runs: up and down the wall, round the foot.
    const toVertical = inFoot ? 0 : 0.28;
    const nearest = Math.round((angle - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
    let theta = angle + toVertical * (nearest - angle);
    if (inFoot) { const flat = Math.round(angle / Math.PI) * Math.PI; theta = angle + 0.3 * (flat - angle); }
    const along = glance > 0.12 ? Math.cos(theta - slide) : 0;
    const reach = E * REACH * (0.55 + 0.45 * Math.abs(Math.sin(theta))) * (1 + 0.55 * glance * along) * (inFoot ? 0.7 : 1);
    grow(impactVertex, theta, reach, 0, -1, 'primary');
    angle += (gaps[k] / sum) * Math.PI * 2;
  }

  // ---- 2. The cone the blow cut out: an irregular ring round the impact -------------------------
  const ringAround = (radius: number, around: number, fraction: number, stretch: number, rotate: number): Array<[number, number]> => {
    const count = 15 + Math.round(8 * E);
    const phase = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const points: Array<[number, number]> = [];
    const span = fraction * Math.PI * 2;
    const from = rotate;
    const total = fraction >= 1 ? count : count + 1;
    for (let i = 0; i < total; i++) {
      const a = from + (span * i) / count + (rand() - 0.5) * 0.18;
      const bumps = 0.2 * Math.sin(2 * a + phase[0]) + 0.14 * Math.sin(3 * a + phase[1]) + 0.08 * Math.sin(5 * a + phase[2]);
      const r = radius * (1 + bumps);
      // Drawn out along the way the blow slid, and carried a little the same way.
      const x = r * Math.cos(a) * (1 + stretch * 0.5) + around * Math.cos(slide);
      const y = r * Math.sin(a) * (1 - stretch * 0.15) + around * Math.sin(slide);
      points.push([u0 + x / builder.circumference(v0), v0 + y / L]);
    }
    return fraction >= 1 ? chaikin(points, true) : chaikin(points, false);
  };
  const crush = lerp(0.3, 0.92, smoothstep(0.18, 1, E));
  // A light blow cuts a closed cone out of the glaze; a hard one breaks the ring in places.
  if (E < 0.4) lay(ringAround(crush, 0.22 * crush * glance, 1, glance, 0), true, 'ring', -1, 0);
  else lay(ringAround(crush, 0.22 * crush * glance, 0.6 + 0.3 * rand(), glance, rand() * Math.PI * 2), false, 'ring', -1, 0);
  if (E > 0.42) {
    const start = rand() * Math.PI * 2;
    lay(ringAround(crush * lerp(1.7, 2.2, rand()), 0.1 * glance, 0.4 + 0.35 * rand(), glance, start), false, 'ring', -1, 0);
  }

  // ---- 3. A hard blow opens the foot ring, and with it the wall comes away from the foot -------
  // What reaches the wall. A blow on the wall sends all its strain through it; one on the foot has
  // to travel up first, and does so only if it is hard: the harder, the more of it arrives.
  const Ew = v0 > FOOT_TOP - 0.02 ? E : E * lerp(0.3, 1, smoothstep(0.3, 0.85, E));
  if (Ew >= 0.8) {
    // So hard that the foot ring opens the whole way round: a cut that runs from one end of the turn
    // to the other, level at both ends (they are the same place on the bowl), so that the wall comes
    // away from the foot all round and no bridge is left across the seam.
    const level = FOOT_TOP + 0.03;
    const phase = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const count = Math.max(12, Math.round(builder.circumference(level) / (STEP * 1.3)));
    const cut: Array<[number, number]> = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const wobble = 0.03 * Math.sin(Math.PI * 2 * t + phase[0]) + 0.014 * Math.sin(Math.PI * 4 * t + phase[1]) + 0.007 * Math.sin(Math.PI * 6 * t + phase[2]);
      cut.push([i === 0 ? uLeft : i === count ? uRight : uLeft + (uRight - uLeft) * t, level + wobble]);
    }
    cut[count][1] = cut[0][1];
    lay(cut, false, 'foot', -1, 0, [uLeft, uRight]);
  } else if (Ew >= 0.26) {
    const width = clamp(lerp(0.1, 0.52, Math.pow(Ew, 0.8)) * (0.85 + 0.3 * rand()), 0.08, 0.5);
    const centre = u0 + (rand() - 0.5) * 0.08;
    const cut: Array<[number, number]> = [];
    const phase = rand() * 6.28;
    const count = Math.max(6, Math.round((2 * width * builder.circumference(FOOT_TOP + 0.03)) / (STEP * 1.3)));
    for (let i = 0; i <= count; i++) {
      const u = centre - width + (2 * width * i) / count;
      cut.push([u, FOOT_TOP + 0.03 + 0.03 * Math.sin(phase + u * 17) + 0.014 * Math.sin(phase * 2 + u * 43) + 0.006 * Math.sin(phase * 3 + u * 97)]);
    }
    lay(cut, false, 'foot', -1, 0);
  }

  // ---- 3b. Cracks that run the height of the wall, round the bowl, from the blow ----------------
  // A hard blow sends the strain round the whole wall: tall cracks, close together beside the
  // impact and further apart as the energy runs out, up towards the rim and down to the foot.
  // Each starts where the strain runs from, level with the blow, and grows both ways.
  const spread = 0.465 * smoothstep(0.2, 0.8, Ew);
  if (spread > 0.03) {
    for (const side of [-1, 1]) {
      let offset = 0.05 + 0.05 * rand();
      while (offset < spread) {
        const fall = Math.exp(-offset / (0.55 * spread));
        // Level with the blow on the wall; just above the foot when the blow was on the foot.
        const level = v0 > FOOT_TOP - 0.02 ? clamp(v0 + (rand() - 0.5) * 0.14, 0.4, 0.9) : 0.44 + 0.1 * rand();
        const u = u0 + side * offset;
        if (u > uLow + 0.02 && u < uHigh - 0.02) {
          const start = builder.vertex(u, level, 'branch');
          const reach = Ew * REACH * (0.5 + 0.7 * fall) * (0.8 + 0.4 * rand());
          const lean = (rand() - 0.5) * 0.4;
          const up = rand() < 0.5;
          // Upwards first or downwards first: whichever grows first claims the junctions.
          const order = up ? [Math.PI / 2 + lean, -Math.PI / 2 + lean] : [-Math.PI / 2 + lean, Math.PI / 2 + lean];
          grow(start, order[0], reach, 1, -1, 'primary');
          grow(start, order[1], reach, 1, -1, 'primary');
        }
        // Dense near the impact, sparse far from it.
        offset += lerp(0.07, 0.24, Math.pow(clamp(offset / spread), 0.85)) * (0.7 + 0.6 * rand());
      }
    }
  }

  // ---- 4. Arcs that run across the radial cracks (the transverse cracks of a brittle break) -----
  const arcs = Math.round(E * 3.5 + rand() * 0.8);
  const radials = builder.paths.filter((p) => p.kind === 'primary');
  for (let k = 0; k < arcs && radials.length > 0; k++) {
    const parent = radials[Math.floor(rand() * radials.length)];
    if (parent.vertices.length < 8) continue;
    const at = parent.vertices[Math.floor(parent.vertices.length * (0.35 + 0.5 * rand()))];
    if (builder.kind[at] !== 'path') continue;
    builder.mark(at, 'branch');
    const [rx, ry] = worldFromImpact(builder.u[at], builder.v[at]);
    const side = rand() < 0.5 ? -1 : 1;
    const heading = Math.atan2(ry, rx) + side * Math.PI / 2;
    pending.push({ from: at, theta: heading + (rand() - 0.5) * 0.3, energy: E * REACH * (0.18 + 0.18 * rand()), generation: 1, parent: parent.id, kind: 'arc' });
  }

  // ---- 5. Side cracks and arcs, in the order they were decided ----------------------------------
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const [rx, ry] = worldFromImpact(builder.u[p.from], builder.v[p.from]);
    const outward = Math.atan2(ry, rx);
    const circling = p.kind === 'arc' ? (Math.cos(p.theta - outward) > 0 ? 1 : -1) : 0;
    const sign = Math.sin(p.theta - outward) >= 0 ? 1 : -1;
    grow(p.from, p.theta, p.energy, p.generation, p.parent, p.kind, p.kind === 'arc' ? sign : circling);
  }

  // Cracks are walked in small steps; straighten what is straight, keeping every junction and
  // end exactly where it is. If that made two cracks cross, keep the original.
  const original = builder.paths.map((p) => [...p.vertices]);
  simplify(builder, L);
  if (crosses(builder)) builder.paths.forEach((p, i) => { p.vertices = original[i]; });

  // Straight pieces, without repeats.
  const seen = new Set<string>();
  let segments: Array<[number, number]> = [];
  for (const path of builder.paths) {
    for (let i = 0; i + 1 < path.vertices.length; i++) {
      const a = path.vertices[i], b = path.vertices[i + 1];
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push([a, b]);
    }
  }
  // A crack that stops inside a piece, with nothing at its end, separates nothing: it is not a
  // break, and nothing is drawn or repaired along it. Leave it out, and whatever it left dangling.
  const degree = new Map<number, number>();
  for (const [a, b] of segments) { degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1); }
  // Cracks that run out at the rim, or on to the seam where the turn closes, are attached to something.
  const attached = (vertex: number) => builder.v[vertex] === 1 || builder.u[vertex] === uLeft || builder.u[vertex] === uRight;
  for (let changed = true; changed;) {
    changed = false;
    segments = segments.filter(([a, b]) => {
      const loose = (v: number) => degree.get(v) === 1 && !attached(v);
      if (!loose(a) && !loose(b)) return true;
      degree.set(a, degree.get(a)! - 1);
      degree.set(b, degree.get(b)! - 1);
      changed = true;
      return false;
    });
  }
  let totalLength = 0;
  for (const [a, b] of segments) {
    const x = (builder.u[b] - builder.u[a]) * builder.circumference((builder.v[a] + builder.v[b]) / 2), y = (builder.v[b] - builder.v[a]) * L;
    totalLength += Math.hypot(x, y);
  }
  stats.totalLength = totalLength;
  stats.vertices = builder.u.length;
  return { u: builder.u, v: builder.v, kind: builder.kind, paths: builder.paths, segments, stats };
}

/** One round of corner cutting: a smooth curve through the corners of a polyline. Open ends stay put. */
function chaikin(points: Array<[number, number]>, closed: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = points.length;
  if (!closed) out.push(points[0]);
  const edges = closed ? n : n - 1;
  for (let i = 0; i < edges; i++) {
    const a = points[i], b = points[(i + 1) % n];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

/** The part of the segment p→q inside [uLow, uHigh] × [0, 1], with ends on the edge snapped exactly onto it. */
function clipSegment(p: [number, number], q: [number, number], uLow: number, uHigh: number): [[number, number], [number, number]] | null {
  let t0 = 0, t1 = 1;
  const du = q[0] - p[0], dv = q[1] - p[1];
  const edges: Array<[number, number]> = [[-du, p[0] - uLow], [du, uHigh - p[0]], [-dv, p[1] - POLE_REACH], [dv, 1 - p[1]]];
  for (const [d, dist] of edges) {
    if (Math.abs(d) < 1e-15) { if (dist < 0) return null; continue; }
    const t = dist / d;
    if (d < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  if (t1 - t0 < 1e-9) return null;
  const snap = (t: number): [number, number] => {
    let u = p[0] + du * t, v = p[1] + dv * t;
    if (Math.abs(v - 1) < 1e-9) v = 1;
    if (Math.abs(v - POLE_REACH) < 1e-9) v = POLE_REACH;
    if (Math.abs(u - uLow) < 1e-9) u = uLow;
    if (Math.abs(u - uHigh) < 1e-9) u = uHigh;
    return [u, v];
  };
  const a = t0 === 0 ? p : snap(t0), b = t1 === 1 ? q : snap(t1);
  return [a, b];
}

/** Largest distance (world units) a vertex may be moved off its crack by straightening it. */
const STRAIGHTEN = 0.01;

/** Douglas–Peucker on every stretch of every crack between two vertices that must stay. */
function simplify(builder: Builder, L: number): void {
  const uses = new Map<number, number>();
  for (const path of builder.paths) for (const v of path.vertices) uses.set(v, (uses.get(v) ?? 0) + 1);
  const fixed = (v: number) => builder.kind[v] !== 'path' || (uses.get(v) ?? 0) > 1;
  const point = (v: number): [number, number] => {
    const c = builder.circumference(builder.v[v]);
    return [builder.u[v] * c, builder.v[v] * L];
  };
  for (const path of builder.paths) {
    const list = path.vertices;
    const keep = new Uint8Array(list.length);
    keep[0] = keep[list.length - 1] = 1;
    list.forEach((v, i) => { if (fixed(v)) keep[i] = 1; });
    const run = (lo: number, hi: number): void => {
      if (hi - lo < 2) return;
      const [ax, ay] = point(list[lo]), [bx, by] = point(list[hi]);
      const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy) || 1;
      let far = -1, worst = STRAIGHTEN;
      for (let i = lo + 1; i < hi; i++) {
        const [px, py] = point(list[i]);
        const d = Math.abs((px - ax) * dy - (py - ay) * dx) / length;
        if (d > worst) { worst = d; far = i; }
      }
      if (far < 0) return;
      keep[far] = 1;
      run(lo, far);
      run(far, hi);
    };
    let from = 0;
    for (let i = 1; i < list.length; i++) if (keep[i]) { run(from, i); from = i; }
    path.vertices = list.filter((_, i) => keep[i]);
  }
}

/** True if any two straight pieces of the network cross, or touch away from a shared vertex. */
function crosses(builder: Builder): boolean {
  const pieces: Array<[number, number]> = [];
  for (const path of builder.paths) for (let i = 0; i + 1 < path.vertices.length; i++) pieces.push([path.vertices[i], path.vertices[i + 1]]);
  for (let i = 0; i < pieces.length; i++) {
    const [a, b] = pieces[i];
    for (let j = i + 1; j < pieces.length; j++) {
      const [c, d] = pieces[j];
      if (a === c || a === d || b === c || b === d) continue;
      const du = builder.u[b] - builder.u[a], dv = builder.v[b] - builder.v[a];
      const eu = builder.u[d] - builder.u[c], ev = builder.v[d] - builder.v[c];
      const denominator = du * ev - dv * eu;
      if (Math.abs(denominator) < 1e-18) continue;
      const t = ((builder.u[c] - builder.u[a]) * ev - (builder.v[c] - builder.v[a]) * eu) / denominator;
      const s = ((builder.u[c] - builder.u[a]) * dv - (builder.v[c] - builder.v[a]) * du) / denominator;
      if (t > -1e-9 && t < 1 + 1e-9 && s > -1e-9 && s < 1 + 1e-9) return true;
    }
  }
  return false;
}
