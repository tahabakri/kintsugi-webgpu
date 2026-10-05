import { INNER, OUTER, type BowlSurface } from '../ceramic/uv-surface';
import { polylineLength } from '../math/geometry';
import { sub3, type Vec2, type Vec3 } from '../math/vec';
import { crossAtU, crossAtV, makeSupport, supportParam, type Support } from './clipping';
import type { FracturePattern } from './pattern';

/** A straight piece of crack between two canonical diagram vertices. */
export interface CrackSegment {
  /** Canonical vertex ids. Travelling a → b, faceA is on the left. */
  a: number;
  b: number;
  faceA: number;
  faceB: number;
  support: Support;
  /** Material-space points from a to b, including every tessellation grid crossing. */
  samples: Vec2[];
}

/** Per-sample resin state along one crack edge. */
export interface ResinField {
  /** Occupancy of the crack at each sample, 0…1. */
  fill: Float32Array;
  /** Cure of the resin at each sample, 0…1. */
  cure: Float32Array;
  /** Simulation temperature factor of the resin at each sample, 0 (ambient) … 1 (hot). */
  temperature: Float32Array;
  /** Net flow through each sample during the last step (signed, for shading). */
  flow: Float32Array;
  /** World distance between neighbouring samples. */
  spacing: number;
}

export interface CrackEdge {
  id: number;
  shardA: number;
  /** null would mark an exposed boundary with no mating shard. */
  shardB: number | null;
  /** Graph nodes at the start and end of the polyline. */
  nodeStart: number;
  nodeEnd: number;
  polylineMaterial: Vec2[];
  /** Outer-surface polyline in bowl space. */
  polyline: Vec3[];
  /** Inner-surface polyline in bowl space (same sample count). */
  polylineInner: Vec3[];
  /** The same outer polyline expressed in each shard's own frame. */
  polylineLocalA: Vec3[];
  polylineLocalB: Vec3[];
  length: number;
  /** World distance from the impact to the middle of the edge. */
  impactDistance: number;
  /** Current RMS gap between the two sides; 0 while the shards are still mated. */
  aperture: number;
  fill: number;
  cure: number;
  temperature: number;
  joined: boolean;
  resin: ResinField;
  /** Which sides have had resin brushed onto them (bit 0 = A, bit 1 = B). */
  painted: number;
  /** True while the two sides are close enough and oriented well enough to bond. */
  aligned: boolean;
}

export interface CrackNode {
  id: number;
  uv: Vec2;
  /** Edge ends that meet here. end 0 = the edge starts here, 1 = it ends here. */
  ends: Array<{ edge: number; end: 0 | 1 }>;
  boundary: 'rim' | 'pole' | null;
}

export interface CrackGraph {
  segments: CrackSegment[];
  edges: CrackEdge[];
  nodes: CrackNode[];
  totalLength: number;
}

const RESIN_SPACING = 0.03;

/** Points from (au, av) to (bu, bv) along a support, with every grid-line crossing in between. */
export function segmentSamples(surface: BowlSurface, support: Support, au: number, av: number, bu: number, bv: number): Vec2[] {
  const ta = supportParam(support, au, av), tb = supportParam(support, bu, bv);
  const lo = Math.min(ta, tb) + 1e-12, hi = Math.max(ta, tb) - 1e-12;
  const crossings: Array<{ t: number; u: number; v: number }> = [];
  const U = surface.U;

  if (support.qu !== support.pu) {
    const first = Math.floor(Math.min(support.pu, support.qu) * U) - 1;
    const last = Math.ceil(Math.max(support.pu, support.qu) * U) + 1;
    for (let i = first; i <= last; i++) {
      const u = i / U;
      const t = (u - support.pu) / (support.qu - support.pu);
      if (t > lo && t < hi) crossings.push({ t, u, v: crossAtU(support, u) });
    }
  }
  if (support.qv !== support.pv) {
    for (let j = 0; j < surface.rows.length; j++) {
      const v = surface.rows[j];
      const t = (v - support.pv) / (support.qv - support.pv);
      if (t > lo && t < hi) crossings.push({ t, u: crossAtV(support, v), v });
    }
  }
  crossings.sort((x, y) => x.t - y.t);
  const points: Vec2[] = [];
  let previous = -Infinity;
  for (const c of crossings) {
    if (c.t - previous < 1e-12) continue; // the support passes through a grid corner
    points.push([c.u, c.v]);
    previous = c.t;
  }
  if (ta > tb) points.reverse();
  return [[au, av], ...points, [bu, bv]];
}

/** Every boundary between two different faces, once, oriented counter-clockwise for faceA. */
export function collectSegments(surface: BowlSurface, pattern: FracturePattern): CrackSegment[] {
  const { diagram, cellFace } = pattern;
  const segments: CrackSegment[] = [];
  const seen = new Set<string>();
  diagram.cells.forEach((cell) => {
    const face = cellFace[cell.seed];
    for (let k = 0, m = cell.vid.length; k < m; k++) {
      const l = k + 1 === m ? 0 : k + 1;
      const tag = cell.tag[k];
      // The rim, the pole and the seam of the unwrapped turn are not cracks.
      if (tag < 0) continue;
      const other = cellFace[tag];
      if (other < 0 || other === face) continue;
      const support: Support = makeSupport(cell.u[k], cell.v[k], cell.u[l], cell.v[l]);
      const a = cell.vid[k], b = cell.vid[l];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push({
        a, b, faceA: face, faceB: other, support,
        samples: segmentSamples(surface, support, cell.u[k], cell.v[k], cell.u[l], cell.v[l]),
      });
    }
  });
  return segments;
}

function resinField(length: number): ResinField {
  const count = Math.max(6, Math.min(64, Math.round(length / RESIN_SPACING) + 1));
  return {
    fill: new Float32Array(count),
    cure: new Float32Array(count),
    temperature: new Float32Array(count),
    flow: new Float32Array(count),
    spacing: length / (count - 1),
  };
}

/**
 * Chains crack segments into edges (maximal runs between two faces) joined at nodes (junctions
 * where three or more faces meet, or where a crack reaches the rim or the pole).
 */
export function buildCrackGraph(surface: BowlSurface, pattern: FracturePattern, segments: CrackSegment[], centroids: readonly Vec3[]): CrackGraph {
  const { diagram, chart } = pattern;
  const incident = new Map<number, number[]>();
  segments.forEach((segment, index) => {
    for (const vertex of [segment.a, segment.b]) {
      const list = incident.get(vertex);
      if (list) list.push(index);
      else incident.set(vertex, [index]);
    }
  });
  const pairKey = (s: CrackSegment) => (s.faceA < s.faceB ? `${s.faceA}|${s.faceB}` : `${s.faceB}|${s.faceA}`);
  const isNode = (vertex: number): boolean => {
    const list = incident.get(vertex)!;
    return list.length !== 2 || pairKey(segments[list[0]]) !== pairKey(segments[list[1]]);
  };

  const nodes: CrackNode[] = [];
  const nodeOfVertex = new Map<number, number>();
  const nodeFor = (vertex: number): number => {
    let id = nodeOfVertex.get(vertex);
    if (id === undefined) {
      id = nodes.length;
      const v = diagram.vertexV[vertex];
      nodes.push({ id, uv: [diagram.vertexU[vertex], v], ends: [], boundary: v === 1 ? 'rim' : v === 0 ? 'pole' : null });
      nodeOfVertex.set(vertex, id);
    }
    return id;
  };

  const edges: CrackEdge[] = [];
  const visited = new Uint8Array(segments.length);
  const walk = (startVertex: number, firstSegment: number) => {
    // `exact` keeps the samples as the meshes use them; `material` is the same path with u made
    // continuous, since a crack that crosses the seam of the unwrapped turn jumps by one there.
    const exact: Vec2[] = [];
    const material: Vec2[] = [];
    let vertex = startVertex, index = firstSegment;
    let left = -1, right = -1;
    for (;;) {
      visited[index] = 1;
      const segment = segments[index];
      const forward = segment.a === vertex;
      const samples = forward ? segment.samples : [...segment.samples].reverse();
      if (left < 0) { left = forward ? segment.faceA : segment.faceB; right = forward ? segment.faceB : segment.faceA; }
      for (let i = material.length === 0 ? 0 : 1; i < samples.length; i++) {
        const [u, v] = samples[i];
        const previous = material.length > 0 ? material[material.length - 1][0] : u;
        exact.push(samples[i]);
        material.push([u - Math.round(u - previous), v]);
      }
      vertex = forward ? segment.b : segment.a;
      if (vertex === startVertex || isNode(vertex)) break;
      const [s0, s1] = incident.get(vertex)!;
      index = s0 === index ? s1 : s0;
      if (visited[index]) break;
    }
    const polyline = exact.map(([u, v]) => surface.position(OUTER, u, v));
    const polylineInner = exact.map(([u, v]) => surface.position(INNER, u, v));
    const length = polylineLength(polyline);
    const id = edges.length;
    const mid = material[material.length >> 1];
    const nodeStart = nodeFor(startVertex), nodeEnd = nodeFor(vertex);
    nodes[nodeStart].ends.push({ edge: id, end: 0 });
    nodes[nodeEnd].ends.push({ edge: id, end: 1 });
    edges.push({
      id, shardA: left, shardB: right, nodeStart, nodeEnd,
      polylineMaterial: material, polyline, polylineInner,
      polylineLocalA: polyline.map((p) => sub3(p, centroids[left])),
      polylineLocalB: polyline.map((p) => sub3(p, centroids[right])),
      length,
      impactDistance: Math.hypot((mid[0] - chart.u0 - Math.round(mid[0] - chart.u0)) * chart.scaleU, (mid[1] - chart.v0) * chart.scaleV),
      aperture: 0, fill: 0, cure: 0, temperature: 0, joined: false,
      resin: resinField(length), painted: 0, aligned: true,
    });
  };

  for (const [vertex, list] of incident) {
    if (!isNode(vertex)) continue;
    for (const index of list) if (!visited[index]) walk(vertex, index);
  }
  // Closed loops with no junction (a fragment completely enclosed by one neighbour).
  segments.forEach((segment, index) => { if (!visited[index]) walk(segment.a, index); });

  const totalLength = edges.reduce((sum, edge) => sum + edge.length, 0);
  return { segments, edges, nodes, totalLength };
}
