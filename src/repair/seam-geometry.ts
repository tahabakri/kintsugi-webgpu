import { INNER, OUTER, type BowlSurface, type SurfaceSide } from '../ceramic/uv-surface';
import type { CrackEdge, CrackGraph } from '../fracture/crack-graph';
import type { ShardGeometry } from '../fracture/shard-builder';
import { SEAM_VERTEX_FLOATS } from '../gpu/layouts';
import type { SeamGeometry } from '../gpu/renderer';
import { cross3, norm3, sub3, type Vec2, type Vec3 } from '../math/vec';

/** Points around a bead's cross-section (a half ellipse standing on the surface). */
const BEAD_POINTS = 7;

const PART_BEAD_OUTER = 0;
const PART_BEAD_INNER = 1;
const PART_FILM = 2;
const PART_HAIRLINE = 3;

class SeamBuilder {
  readonly vertices: number[] = [];
  /** Triangle indices grouped by the shard whose transform they ride on. */
  readonly byShard = new Map<number, number[]>();

  vertex(centre: Vec3, binormal: Vec3, normal: Vec3, cos: number, sin: number, sample: number, edge: number, side: number, part: number): number {
    this.vertices.push(
      centre[0], centre[1], centre[2],
      binormal[0], binormal[1], binormal[2],
      normal[0], normal[1], normal[2],
      cos, sin,
      sample, edge, side, part,
    );
    return this.vertices.length / SEAM_VERTEX_FLOATS - 1;
  }

  quad(shard: number, a: number, b: number, c: number, d: number): void {
    let list = this.byShard.get(shard);
    if (!list) this.byShard.set(shard, (list = []));
    list.push(a, b, c, a, c, d);
  }
}

/** A cross-section of the seam: where it is, and which resin sample drives it. */
interface Station {
  uv: Vec2;
  /** Index of the nearest resin sample on the edge. */
  sample: number;
  /** Arc length from the start of the edge. */
  along: number;
}

/**
 * Cross-sections along an edge: every point of the crack polyline (so the seam turns exactly
 * where the crack does, including round the foot) plus every resin sample position in between
 * (so the fill can vary smoothly along straight stretches).
 */
function stations(edge: CrackEdge): { list: Station[]; total: number } {
  const points = edge.polyline, material = edge.polylineMaterial;
  const cumulative = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    cumulative[i] = cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
  }
  const total = cumulative[points.length - 1];
  const samples = edge.resin.fill.length;
  const spacing = samples > 1 ? total / (samples - 1) : total;
  const nearest = (s: number) => Math.max(0, Math.min(samples - 1, spacing > 0 ? Math.round(s / spacing) : 0));

  const list: Station[] = points.map((_, i) => ({ uv: material[i], sample: nearest(cumulative[i]), along: cumulative[i] }));
  let segment = 0;
  for (let k = 0; k < samples; k++) {
    const s = k * spacing;
    while (segment < points.length - 2 && cumulative[segment + 1] < s) segment++;
    const from = cumulative[segment], to = cumulative[segment + 1];
    // A polyline point close by already stands for this sample.
    if (s - from < 0.006 || to - s < 0.006) continue;
    const t = (s - from) / (to - from);
    const a = material[segment], b = material[segment + 1];
    list.push({ uv: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], sample: k, along: s });
  }
  list.sort((p, q) => p.along - q.along);
  return { list, total };
}

/** How much the bead swells at an end of an edge: more where three or more cracks meet. */
function pooling(node: number, graph: CrackGraph): number {
  const at = graph.nodes[node];
  if (!at || at.boundary !== null) return 0.15;
  return at.ends.length >= 3 ? 0.55 : 0.2;
}

/**
 * Builds every piece of gold the fracture could ever show: for each crack edge and each of its two
 * sides, a bead along the outer skin, one along the inner skin, a film over the broken face, a
 * bead over the lip where the crack runs out through the rim, and (on one side) a hairline that
 * marks the crack while it is closed but unfilled. All of it is in the owning shard's frame, so it
 * moves rigidly with the shard and never needs rebuilding. The vertex shader scales each part by
 * the live resin field, so only filled stretches of the right side are visible.
 */
export function buildSeamGeometry(surface: BowlSurface, graph: CrackGraph, shards: readonly ShardGeometry[], sampleOffsets: Int32Array): SeamGeometry {
  const builder = new SeamBuilder();
  const rimSegments = surface.profile.rimSegments;
  const scratch = new Float64Array(6);

  graph.edges.forEach((edge, edgeIndex) => {
    const { list, total } = stations(edge);
    const count = list.length;
    const offset = sampleOffsets[edgeIndex];
    const outer = list.map(({ uv }) => surface.position(OUTER, uv[0], uv[1]));
    const inner = list.map(({ uv }) => surface.position(INNER, uv[0], uv[1]));
    const poolStart = pooling(edge.nodeStart, graph), poolEnd = pooling(edge.nodeEnd, graph);
    const sides: Array<{ shard: number; side: number }> = [{ shard: edge.shardA, side: 0 }];
    if (edge.shardB !== null) sides.push({ shard: edge.shardB, side: 1 });

    for (const { shard, side } of sides) {
      const centroid = shards[shard].centroid;
      const local = (p: Vec3): Vec3 => sub3(p, centroid);
      // Side A's broken face looks along tangent × through-thickness; side B's the other way.
      const faceSign = side === 0 ? 1 : -1;
      const tangentAt = (points: Vec3[], i: number): Vec3 =>
        norm3(sub3(points[Math.min(count - 1, i + 1)], points[Math.max(0, i - 1)]), [1, 0, 0]);

      const bead = (skin: SurfaceSide, points: Vec3[], part: number): void => {
        const rings: number[][] = [];
        for (let i = 0; i < count; i++) {
          const normal = surface.normal(skin, list[i].uv[0], list[i].uv[1]);
          const binormal = norm3(cross3(tangentAt(points, i), normal), [0, 0, 1]);
          // Resin pools where cracks meet: the bead swells towards a junction.
          const swell = 1 + poolStart * Math.exp(-list[i].along / 0.07) + poolEnd * Math.exp(-(total - list[i].along) / 0.07);
          const ring: number[] = [];
          for (let k = 0; k < BEAD_POINTS; k++) {
            const phi = (k / (BEAD_POINTS - 1)) * Math.PI;
            ring.push(builder.vertex(local(points[i]), binormal, normal, Math.cos(phi) * swell, Math.sin(phi) * swell, offset + list[i].sample, edgeIndex, side, part));
          }
          rings.push(ring);
        }
        for (let i = 0; i < count - 1; i++) {
          for (let k = 0; k < BEAD_POINTS - 1; k++) builder.quad(shard, rings[i][k], rings[i + 1][k], rings[i + 1][k + 1], rings[i][k + 1]);
        }
      };
      bead(OUTER, outer, PART_BEAD_OUTER);
      bead(INNER, inner, PART_BEAD_INNER);

      // Film on the broken face: a strip from the outer edge to the inner edge. Each vertex also
      // carries the way to the middle of the wall, where the shader folds the strip away to
      // nothing wherever there is no resin to show.
      let previous: [number, number] | null = null;
      for (let i = 0; i < count; i++) {
        const through = sub3(inner[i], outer[i]);
        const face = norm3(cross3(tangentAt(outer, i), through), [0, 1, 0]);
        const normal: Vec3 = [face[0] * faceSign, face[1] * faceSign, face[2] * faceSign];
        const half: Vec3 = [through[0] / 2, through[1] / 2, through[2] / 2];
        const a = builder.vertex(local(outer[i]), half, normal, 0, 0, offset + list[i].sample, edgeIndex, side, PART_FILM);
        const b = builder.vertex(local(inner[i]), [-half[0], -half[1], -half[2]], normal, 0, 0, offset + list[i].sample, edgeIndex, side, PART_FILM);
        if (previous) builder.quad(shard, previous[0], a, b, previous[1]);
        previous = [a, b];
      }

      // Over the lip, where the crack leaves through the rim.
      for (const end of [0, count - 1]) {
        if (list[end].uv[1] !== 1) continue;
        const u = list[end].uv[0];
        const around = norm3([-outer[end][2], 0, outer[end][0]], [1, 0, 0]); // circumferential direction
        const rings: number[][] = [];
        for (let k = 0; k <= rimSegments; k++) {
          surface.rimPoint(u, k, scratch);
          const centre: Vec3 = [scratch[0], scratch[1], scratch[2]];
          const normal: Vec3 = [scratch[3], scratch[4], scratch[5]];
          const ring: number[] = [];
          for (let j = 0; j < BEAD_POINTS; j++) {
            const phi = (j / (BEAD_POINTS - 1)) * Math.PI;
            // Over the lip the bead is laid thinner, so it does not stand up as a knob on the rim.
            ring.push(builder.vertex(local(centre), around, normal, Math.cos(phi) * 0.85, Math.sin(phi) * 0.5, offset + list[end].sample, edgeIndex, side, PART_BEAD_OUTER));
          }
          rings.push(ring);
        }
        for (let k = 0; k < rimSegments; k++) {
          for (let j = 0; j < BEAD_POINTS - 1; j++) builder.quad(shard, rings[k][j], rings[k + 1][j], rings[k + 1][j + 1], rings[k][j + 1]);
        }
      }

      // Hairline: only one copy is needed, since it shows only while the two sides are together.
      if (side === 0 && edge.shardB !== null) {
        for (const [skin, points] of [[OUTER, outer], [INNER, inner]] as const) {
          let last: [number, number] | null = null;
          for (let i = 0; i < count; i++) {
            const normal = surface.normal(skin, list[i].uv[0], list[i].uv[1]);
            const binormal = norm3(cross3(tangentAt(points, i), normal), [0, 0, 1]);
            const a = builder.vertex(local(points[i]), binormal, normal, -1, 0, offset + list[i].sample, edgeIndex, side, PART_HAIRLINE);
            const b = builder.vertex(local(points[i]), binormal, normal, 1, 0, offset + list[i].sample, edgeIndex, side, PART_HAIRLINE);
            if (last) builder.quad(shard, last[0], a, b, last[1]);
            last = [a, b];
          }
        }
      }
    }
  });

  // Concatenate the per-shard index lists into one buffer with a draw range per shard.
  const ranges: SeamGeometry['ranges'] = [];
  let total = 0;
  for (const list of builder.byShard.values()) total += list.length;
  const indices = new Uint32Array(total);
  let first = 0;
  for (const [shard, list] of builder.byShard) {
    indices.set(list, first);
    ranges.push({ shard, first, count: list.length });
    first += list.length;
  }
  const sampleCount = graph.edges.reduce((sum, edge) => sum + edge.resin.fill.length, 0);
  return { vertices: new Float32Array(builder.vertices), indices, ranges, sampleCount, edgeCount: graph.edges.length };
}
