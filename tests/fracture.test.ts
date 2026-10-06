import { describe, expect, it } from 'vitest';
import { BowlSurface, OUTER } from '../src/ceramic/uv-surface';
import { BOWL, DEFAULT_CONTROLS, FRACTURE } from '../src/config';
import type { CrackNetwork } from '../src/fracture/crack-network';
import { buildIntactBowl, fractureBowl, type FractureResult } from '../src/fracture/fracture-system';
import { fractureRadius, seedCount } from '../src/fracture/impact';
import { VERTEX_FLOATS } from '../src/fracture/mesh-assembler';
import { buildPattern, buildVoronoiPattern, type FracturePattern } from '../src/fracture/pattern';
import { EDGE_POLE, EDGE_RIM, EDGE_SEAM } from '../src/fracture/power-diagram';
import { mulberry32 } from '../src/math/random';
import { len3, sub3, type Vec2 } from '../src/math/vec';
import { allFinite, closedness } from './helpers';

const surface = new BowlSurface();
const SEED = 20260214;
const fracture = (u: number, v: number, energy: number, seed = SEED, tangent?: Vec2): FractureResult => {
  const result = fractureBowl(surface, { u, v, energy, tangent }, seed, DEFAULT_CONTROLS);
  if (!result) throw new Error(`no fracture for u=${u} v=${v} energy=${energy}`);
  return result;
};
const pattern = (u: number, v: number, energy: number, seed = SEED, tangent?: Vec2): FracturePattern =>
  buildPattern(surface, { u, v, energy, tangent }, seed, DEFAULT_CONTROLS);
const networkOf = (p: FracturePattern): CrackNetwork => {
  if (!p.network) throw new Error('the pattern fell back to the Voronoi diagram');
  return p.network;
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** A spread of impacts: mid wall, near the rim, low on the belly, on the rim, by the foot, across u = 0, on the base. */
const IMPACTS: Array<[number, number]> = [[0.17, 0.64], [0.02, 0.92], [0.6, 0.3], [0.85, 1], [0.4, 0.22], [0.99, 0.5], [0.3, 0.05]];
const WALL: Array<[number, number]> = [[0.17, 0.64], [0.6, 0.85], [0.7, 0.4]];
/** The blows whose cracks can separate something. A blow on the very centre of the underside has nowhere for them to go and uses the fallback. */
const CRACKING = IMPACTS.filter(([, v]) => v > 0.1);

describe('procedural bowl', () => {
  it('has the intended proportions', () => {
    const rim = surface.profile.outer(1);
    expect(rim.r).toBeCloseTo(BOWL.rimRadius, 3);
    expect(rim.y).toBeCloseTo(BOWL.height, 3);
    expect(surface.profile.outer(0).r).toBe(0);
    // Wall thickness is uniform along the belly and a little greater at the lip.
    for (const v of [0.45, 0.6, 0.8]) {
      const o = surface.profile.outer(v), i = surface.profile.inner(v);
      expect(Math.hypot(o.r - i.r, o.y - i.y)).toBeCloseTo(BOWL.defaultWall, 3);
    }
    const o = surface.profile.outer(1), i = surface.profile.inner(1);
    expect(Math.hypot(o.r - i.r, o.y - i.y)).toBeGreaterThan(BOWL.defaultWall);
  });

  it('meshes the intact bowl as one closed, outward-facing solid', () => {
    const bowl = buildIntactBowl(surface);
    expect(allFinite(bowl.mesh.vertices)).toBe(true);
    const result = closedness(bowl.mesh);
    expect(result.open).toBe(0);
    expect(result.nonManifold).toBe(0);
    expect(bowl.volume).toBeGreaterThan(1);
    expect(bowl.mass).toBeCloseTo(bowl.volume * BOWL.density, 6);
    // Centre of mass on the axis, between the table and the rim.
    expect(Math.hypot(bowl.centroid[0], bowl.centroid[2])).toBeLessThan(1e-3);
    expect(bowl.centroid[1]).toBeGreaterThan(0.3);
    expect(bowl.centroid[1]).toBeLessThan(BOWL.height);
    expect(bowl.hulls.length).toBeGreaterThan(40);
  });

  it('maps bowl-space points back to material coordinates', () => {
    for (const [u, v] of [[0.1, 0.5], [0.73, 0.9], [0.42, 0.28]]) {
      const hit = surface.materialOf(surface.position(0, u, v));
      expect(hit.u).toBeCloseTo(u, 3);
      expect(hit.v).toBeCloseTo(v, 2);
      expect(hit.inner).toBe(false);
    }
  });
});

describe('impact model', () => {
  it('grows the damaged radius with energy, and the fallback seed count with energy and brittleness', () => {
    expect(fractureRadius(0.2)).toBeCloseTo(FRACTURE.radiusMin, 6);
    expect(fractureRadius(1)).toBeCloseTo(FRACTURE.radiusMax, 6);
    expect(seedCount(0.9, DEFAULT_CONTROLS)).toBeGreaterThan(seedCount(0.3, DEFAULT_CONTROLS));
    expect(seedCount(0.6, { brittleness: 100, thickness: 46 })).toBeGreaterThanOrEqual(seedCount(0.6, { brittleness: 0, thickness: 46 }));
  });

  it('does not fracture below the threshold or on nonsense input', () => {
    expect(fractureBowl(surface, { u: 0.3, v: 0.6, energy: 0.19 }, SEED, DEFAULT_CONTROLS)).toBeNull();
    expect(fractureBowl(surface, { u: Number.NaN, v: 0.6, energy: 0.8 }, SEED, DEFAULT_CONTROLS)).toBeNull();
    expect(fractureBowl(surface, { u: 0.3, v: 0.6, energy: Number.POSITIVE_INFINITY }, SEED, DEFAULT_CONTROLS)).toBeNull();
  });
});

describe('crack network', () => {
  it('is deterministic: same seed, impact and direction give the same cracks, regions and shards', () => {
    const a = pattern(0.17, 0.64, 0.72, SEED, [0.4, 0.2]), b = pattern(0.17, 0.64, 0.72, SEED, [0.4, 0.2]);
    const na = networkOf(a), nb = networkOf(b);
    expect(nb.u).toEqual(na.u);
    expect(nb.v).toEqual(na.v);
    expect(nb.kind).toEqual(na.kind);
    expect(nb.segments).toEqual(na.segments);
    expect(nb.paths.map((p) => [p.kind, p.parentId, p.generation, p.vertices])).toEqual(na.paths.map((p) => [p.kind, p.parentId, p.generation, p.vertices]));
    expect(b.faceCount).toBe(a.faceCount);
    expect(Array.from(b.cellFace)).toEqual(Array.from(a.cellFace));
    expect(b.faceCells).toEqual(a.faceCells);
    expect(b.diagram.vertexU).toEqual(a.diagram.vertexU);
    expect(b.diagram.vertexV).toEqual(a.diagram.vertexV);

    const first = fracture(0.17, 0.64, 0.72), second = fracture(0.17, 0.64, 0.72);
    expect(second.shards.length).toBe(first.shards.length);
    expect(second.graph.edges.map((e) => [e.shardA, e.shardB, e.length])).toEqual(first.graph.edges.map((e) => [e.shardA, e.shardB, e.length]));
    first.shards.forEach((shard, i) => {
      expect(Array.from(second.shards[i].mesh.vertices.subarray(0, 300))).toEqual(Array.from(shard.mesh.vertices.subarray(0, 300)));
    });
  });

  it('changes with the seed and with where the bowl is hit, and starts at the blow', () => {
    const base = networkOf(pattern(0.17, 0.64, 0.72));
    const otherSeed = networkOf(pattern(0.17, 0.64, 0.72, SEED + 1));
    const otherPlace = networkOf(pattern(0.52, 0.4, 0.72));
    expect(otherSeed.v).not.toEqual(base.v);
    expect(otherPlace.v).not.toEqual(base.v);
    // Vertex 0 is the impact, and every primary crack grows from it.
    expect(base.kind[0]).toBe('impact');
    expect(base.u[0]).toBeCloseTo(0.17, 6);
    expect(base.v[0]).toBeCloseTo(0.64, 6);
    expect(otherPlace.v[0]).toBeCloseTo(0.4, 6);
    expect(base.paths.filter((p) => p.kind === 'primary' && p.generation === 0).every((p) => p.vertices[0] === 0)).toBe(true);
  });

  it('makes cracks that never cross, only meet at vertices', () => {
    for (const [u, v] of CRACKING) {
      for (const energy of [0.25, 0.6, 0.95]) {
        const n = networkOf(pattern(u, v, energy));
        for (let i = 0; i < n.segments.length; i++) {
          const [a, b] = n.segments[i];
          for (let j = i + 1; j < n.segments.length; j++) {
            const [c, d] = n.segments[j];
            if (a === c || a === d || b === c || b === d) continue;
            const du = n.u[b] - n.u[a], dv = n.v[b] - n.v[a], eu = n.u[d] - n.u[c], ev = n.v[d] - n.v[c];
            const denominator = du * ev - dv * eu;
            if (Math.abs(denominator) < 1e-18) continue;
            const t = ((n.u[c] - n.u[a]) * ev - (n.v[c] - n.v[a]) * eu) / denominator;
            const s = ((n.u[c] - n.u[a]) * dv - (n.v[c] - n.v[a]) * du) / denominator;
            expect(t > -1e-9 && t < 1 + 1e-9 && s > -1e-9 && s < 1 + 1e-9, `pieces ${i} and ${j} cross`).toBe(false);
          }
        }
      }
    }
  });

  it('carries the direction of the blow: the same blow the other way makes different cracks', () => {
    // How many of the cracks' vertices (to a centimetre) the two networks share.
    const overlap = (x: CrackNetwork, y: CrackNetwork) => {
      const key = (n: CrackNetwork, i: number) => `${Math.round(n.u[i] * 120)}:${Math.round(n.v[i] * 80)}`;
      const other = new Set(y.u.map((_, i) => key(y, i)));
      let shared = 0;
      for (let i = 0; i < x.u.length; i++) if (other.has(key(x, i))) shared++;
      return shared / Math.max(x.u.length, y.u.length);
    };
    for (const [u, v] of WALL) {
      const forward = networkOf(pattern(u, v, 0.55, SEED, [0.85, 0.1]));
      const back = networkOf(pattern(u, v, 0.55, SEED, [-0.85, -0.1]));
      const square = networkOf(pattern(u, v, 0.55, SEED));
      expect(overlap(forward, back)).toBeLessThan(0.45);
      expect(overlap(forward, square)).toBeLessThan(0.45);
      // And the pieces that result differ in number or in size, not just in place.
      const sizes = (t: Vec2) => fracture(u, v, 0.55, SEED, t).shards.map((s) => +s.surfaceArea.toFixed(3)).sort((a, b) => a - b);
      expect(sizes([0.85, 0.1])).not.toEqual(sizes([-0.85, -0.1]));
    }
  });

  it('cracks more the harder it is hit: more length, branches, broken surface and pieces', () => {
    const energies = [0.25, 0.45, 0.7, 0.95];
    const rows = energies.map((energy) => {
      const length: number[] = [], branches: number[] = [], pieces: number[] = [], broken: number[] = [];
      for (const seed of [1, SEED, 777]) {
        for (const [u, v] of WALL) {
          const p = pattern(u, v, energy, seed);
          const n = networkOf(p);
          length.push(n.stats.totalLength);
          branches.push(n.stats.branches + n.stats.arcs);
          pieces.push(p.faceCount);
          // Surface that has come away from the standing body, in (u, v) area.
          let loose = 0;
          p.faceCells.forEach((cells, face) => { if (face !== 0) for (const i of cells) loose += p.diagram.cells[i].areaUV; });
          broken.push(loose);
        }
      }
      return { length: mean(length), branches: mean(branches), pieces: mean(pieces), broken: mean(broken) };
    });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].length).toBeGreaterThan(rows[i - 1].length);
      expect(rows[i].pieces).toBeGreaterThan(rows[i - 1].pieces);
      expect(rows[i].broken).toBeGreaterThan(rows[i - 1].broken);
    }
    expect(rows[3].branches).toBeGreaterThan(rows[0].branches);
  });

  it('gives a chip for a light blow, a missing part for a medium one, and a smashed wall for a hard one', () => {
    const whole = buildIntactBowl(surface);
    for (const [u, v] of WALL) {
      const light = fracture(u, v, 0.22);
      expect(light.shards.length).toBeLessThanOrEqual(8);
      expect(light.shards[0].volume / whole.volume).toBeGreaterThan(0.9);

      const medium = fracture(u, v, 0.55);
      expect(medium.shards.length).toBeGreaterThan(light.shards.length);
      expect(medium.shards[0].volume / whole.volume).toBeLessThan(0.95);

      const hard = fracture(u, v, 0.95);
      const foot = hard.shards[0];
      expect(foot.survivor).toBe(true);
      expect(hard.shards.length).toBeGreaterThanOrEqual(10);
      // All that stands is the foot: low, on the axis, and a small part of the bowl.
      let top = -Infinity;
      for (let i = 1; i < foot.mesh.vertices.length; i += VERTEX_FLOATS) top = Math.max(top, foot.mesh.vertices[i] + foot.centroid[1]);
      expect(top).toBeLessThan(BOWL.height * 0.3);
      expect(Math.hypot(foot.centroid[0], foot.centroid[2])).toBeLessThan(BOWL.footOuter);
      expect(foot.volume / whole.volume).toBeLessThan(0.3);
      // The wall comes away in a few large curved pieces as well as small ones.
      expect(hard.shards.slice(1).filter((s) => s.surfaceArea > 1).length).toBeGreaterThanOrEqual(2);
      expect(Math.min(...hard.shards.slice(1).map((s) => s.surfaceArea))).toBeLessThan(0.15);
    }
  });

  it('breaks differently by place: the rim sheds chips, a blow by the foot leaves the wall standing', () => {
    const whole = buildIntactBowl(surface);
    const rim = fracture(0.4, 0.97, 0.6);
    expect(rim.graph.nodes.some((node) => node.boundary === 'rim')).toBe(true);
    const wallHits = [0.17, 0.5, 0.8].map((u) => fracture(u, 0.64, 0.6).shards[0].volume / whole.volume);
    const footHits = [0.17, 0.5, 0.8].map((u) => fracture(u, 0.22, 0.6).shards[0].volume / whole.volume);
    expect(mean(footHits)).toBeGreaterThan(mean(wallHits) + 0.15);
  });

  it('makes pieces small beside the impact and large away from it', () => {
    const near: number[] = [], far: number[] = [];
    for (const seed of [1, SEED, 777]) {
      for (const [u, v] of WALL) {
        const result = fracture(u, v, 0.9, seed);
        const hit = surface.position(OUTER, u, v);
        const ranked = result.shards.slice(1).map((s) => ({ d: len3(sub3(s.centroid, hit)), a: s.surfaceArea })).sort((a, b) => a.d - b.d);
        const third = Math.max(1, Math.floor(ranked.length / 3));
        near.push(mean(ranked.slice(0, third).map((x) => x.a)));
        far.push(mean(ranked.slice(-third).map((x) => x.a)));
      }
    }
    expect(mean(far)).toBeGreaterThan(2 * mean(near));
  });
});

describe('regions of the bowl', () => {
  const checkCells = (p: FracturePattern) => {
    const { diagram, columnStart } = p;
    const cells = diagram.cells;
    expect(cells.length).toBeGreaterThan(3);
    let covered = 0;
    cells.forEach((cell, index) => {
      covered += cell.areaUV;
      // Everything lives in one unwrapped turn that starts opposite the impact.
      for (const value of cell.u) {
        expect(value).toBeGreaterThanOrEqual(columnStart / surface.U);
        expect(value).toBeLessThanOrEqual((columnStart + surface.U) / surface.U);
      }
      expect(allFinite(cell.u)).toBe(true);
      expect(allFinite(cell.v)).toBe(true);
      expect(cell.areaUV).toBeGreaterThan(0);
      expect(cell.u.length).toBeGreaterThanOrEqual(3);
      expect(new Set(cell.vid).size).toBe(cell.vid.length);
      for (const value of cell.v) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      // Counter-clockwise and convex: the tessellation depends on it.
      const n = cell.u.length;
      for (let k = 0; k < n; k++) {
        const l = (k + 1) % n, m = (k + 2) % n;
        expect((cell.u[l] - cell.u[k]) * (cell.v[m] - cell.v[l]) - (cell.v[l] - cell.v[k]) * (cell.u[m] - cell.u[l])).toBeGreaterThan(-1e-9);
      }
      // What lies across every edge is another cell that has the same edge the other way round, or a boundary.
      cell.tag.forEach((tag, k) => {
        if (tag < 0) {
          expect([EDGE_RIM, EDGE_POLE, EDGE_SEAM]).toContain(tag);
          return;
        }
        const next = (k + 1) % n;
        const matched = diagram.bySeed[tag].some((i) => {
          const other = diagram.cells[i];
          const m = other.vid.length;
          return other.vid.some((id, j) => id === cell.vid[next] && other.vid[(j + 1) % m] === cell.vid[k] && other.tag[j] === cell.seed);
        });
        expect(matched, `cell ${index} edge ${k}`).toBe(true);
      });
    });
    // The cells tile the bowl: all of it, once.
    expect(covered).toBeCloseTo(1, 9);
    // Every face is made of its cells; with cracks, every cell belongs to a face.
    expect(p.faceCells.flat().length).toBe(cells.length);
    if (p.network) expect(Array.from(p.cellFace).every((face) => face >= 0 && face < p.faceCount)).toBe(true);
  };

  it('tiles the bowl with convex cells, edge for edge', () => {
    let cracked = 0;
    for (const [u, v] of IMPACTS) {
      for (const energy of [0.22, 0.8]) {
        const p = pattern(u, v, energy);
        if (p.network) cracked++;
        checkCells(p);
      }
    }
    // Only a blow on the centre of the underside may fall back.
    expect(cracked).toBeGreaterThanOrEqual((IMPACTS.length - 1) * 2);
  });

  it('falls back to the Voronoi diagram only where cracks cannot go', () => {
    const base = pattern(0.3, 0.05, 0.7);
    expect(base.faceCount).toBeGreaterThan(1);
    for (const [u, v] of CRACKING) expect(pattern(u, v, 0.7).network).not.toBeNull();
  });

  it('does the same for the Voronoi fallback', () => {
    for (const [u, v] of IMPACTS) {
      const p = buildVoronoiPattern(surface, { u, v, energy: 0.6 }, SEED, DEFAULT_CONTROLS);
      expect(p.network).toBeNull();
      expect(p.faceCount).toBeGreaterThan(1);
      let covered = 0;
      for (const cell of p.diagram.cells) covered += cell.areaUV;
      expect(covered).toBeCloseTo(1, 9);
    }
  });

  it('never leaves a piece joined to itself at a point', () => {
    // A face that reached the same vertex from two sides, with another between, would not be a solid.
    for (const [u, v] of IMPACTS) {
      for (const energy of [0.3, 0.5, 0.9]) {
        const { shards } = fracture(u, v, energy);
        for (const shard of shards) expect(closedness(shard.mesh).nonManifold).toBe(0);
      }
    }
  });
});

describe('fracture generation', () => {
  it('builds a crack graph that matches the shards, and the cracks are the shard boundaries', () => {
    for (const [u, v] of IMPACTS) {
      const { shards, graph, pattern: p } = fracture(u, v, 0.75);
      expect(graph.edges.length).toBeGreaterThan(0);
      expect(Number.isFinite(graph.totalLength)).toBe(true);
      expect(graph.totalLength).toBeGreaterThan(0);

      const neighbours = new Map<number, Set<number>>();
      for (const edge of graph.edges) {
        expect(edge.shardB).not.toBeNull();
        const a = edge.shardA, b = edge.shardB as number;
        expect(a).not.toBe(b);
        expect(shards[a]).toBeDefined();
        expect(shards[b]).toBeDefined();
        expect(edge.length).toBeGreaterThan(0);
        expect(edge.polyline.length).toBe(edge.polylineMaterial.length);
        expect(edge.polylineLocalA.length).toBe(edge.polyline.length);
        expect(edge.polylineLocalB.length).toBe(edge.polyline.length);
        expect(edge.polyline.every((q) => q.every(Number.isFinite))).toBe(true);
        expect(edge.resin.fill.length).toBeGreaterThanOrEqual(6);
        expect(edge.resin.fill.length).toBeLessThanOrEqual(64);
        // Both sides hold the same polyline, each in its own shard's frame.
        const point = edge.polyline[0], la = edge.polylineLocalA[0], lb = edge.polylineLocalB[0];
        for (let k = 0; k < 3; k++) {
          expect(la[k] + shards[a].centroid[k]).toBeCloseTo(point[k], 9);
          expect(lb[k] + shards[b].centroid[k]).toBeCloseTo(point[k], 9);
        }
        for (const [x, y] of [[a, b], [b, a]]) {
          if (!neighbours.has(x)) neighbours.set(x, new Set());
          neighbours.get(x)!.add(y);
        }
      }
      // Every shard borders at least one other, and the relation is mutual.
      for (const shard of shards) {
        expect(neighbours.get(shard.id)?.size ?? 0).toBeGreaterThan(0);
        for (const other of neighbours.get(shard.id)!) expect(neighbours.get(other)!.has(shard.id)).toBe(true);
      }
      // Every graph node knows the edge ends that meet there.
      for (const node of graph.nodes) {
        expect(node.ends.length).toBeGreaterThan(0);
        for (const end of node.ends) {
          const edge = graph.edges[end.edge];
          expect(end.end === 0 ? edge.nodeStart : edge.nodeEnd).toBe(node.id);
        }
      }
      // A crack is where two faces meet: every cell edge between different faces is in the graph, once.
      let boundary = 0;
      p.diagram.cells.forEach((cell, index) => cell.tag.forEach((tag) => { if (tag > index && p.cellFace[tag] !== p.cellFace[index]) boundary++; }));
      expect(graph.segments.length).toBe(boundary);
    }
  });

  it('breaks into more pieces the harder it is hit', () => {
    const energies = [0.2, 0.38, 0.55, 0.7, 0.85, 1];
    const totals = energies.map(() => 0);
    for (const seed of [1, SEED, 777]) {
      for (const [u, v] of IMPACTS) {
        // The number of shards is the number of faces of the pattern; no need to mesh them here.
        const counts = energies.map((energy) => pattern(u, v, energy, seed).faceCount);
        counts.forEach((count, i) => {
          totals[i] += count;
          expect(count).toBeLessThanOrEqual(FRACTURE.maxFragments);
        });
        // A blow by the foot may make no more of a mess hard than light; most places do.
        expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(counts[0] - 2);
      }
    }
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1] * 0.95);
    expect(totals[totals.length - 1]).toBeGreaterThan(totals[0] * 2.5);
  });

  it('does not treat u = 0 / 1 as special', () => {
    const counts: number[] = [];
    for (const u of [0.999, 0, 0.001, 0.5]) {
      const { shards, pattern: p } = fracture(u, 0.6, 0.7);
      counts.push(shards.length);
      // The turn is cut opposite the impact, wherever that is.
      const cut = (p.columnStart / surface.U) % 1;
      expect(Math.abs(((cut - u - 0.5) % 1 + 1.5) % 1 - 0.5)).toBeLessThan(1 / surface.U);
      for (const shard of shards) expect(closedness(shard.mesh).open).toBe(0);
    }
    // Hitting across the wrap gives the same kind of break as hitting anywhere else.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(10);
  });

  it('copes with a blow on the rim or at the centre of the base', () => {
    for (const v of [1, 0.9999, 0, 0.001]) {
      const result = fracture(0.37, v, 0.7);
      expect(result.shards.length).toBeGreaterThan(1);
      for (const shard of result.shards) expect(closedness(shard.mesh).open + closedness(shard.mesh).nonManifold).toBe(0);
    }
  });
});

describe('shard geometry', () => {
  const intactVolume = buildIntactBowl(surface).volume;

  it('makes every shard a closed solid with exposed fracture faces', () => {
    for (const [u, v] of IMPACTS) {
      for (const energy of [0.3, 0.9]) {
        const { shards } = fracture(u, v, energy);
        expect(shards.length).toBeGreaterThan(1);
        expect(shards[0].survivor).toBe(true);
        let volume = 0;
        for (const shard of shards) {
          const { vertices, indices } = shard.mesh;
          expect(allFinite(vertices)).toBe(true);
          expect(indices.length % 3).toBe(0);
          expect(indices.length).toBeGreaterThan(0);
          const vertexCount = vertices.length / VERTEX_FLOATS;
          let maxIndex = 0;
          for (let i = 0; i < indices.length; i++) maxIndex = Math.max(maxIndex, indices[i]);
          expect(maxIndex).toBeLessThan(vertexCount);
          // Unit normals.
          for (let i = 0; i < vertices.length; i += VERTEX_FLOATS * 37) {
            expect(Math.hypot(vertices[i + 3], vertices[i + 4], vertices[i + 5])).toBeCloseTo(1, 3);
          }
          const solid = closedness(shard.mesh);
          expect(solid.open).toBe(0);
          expect(solid.nonManifold).toBe(0);
          expect(shard.fractureTriangles).toBeGreaterThan(0);
          expect(shard.centroid.every(Number.isFinite)).toBe(true);
          expect(shard.volume).toBeGreaterThan(0);
          expect(shard.mass).toBeGreaterThan(0);
          expect(shard.inertia.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
          expect(shard.hulls.length).toBeGreaterThan(0);
          for (const hull of shard.hulls) expect(allFinite(hull)).toBe(true);
          volume += shard.volume;
        }
        // Nothing is lost or invented: the pieces add up to the bowl.
        expect(Math.abs(volume - intactVolume) / intactVolume).toBeLessThan(0.004);
      }
    }
  });

  it('keeps the fragment count within the budget', () => {
    const { shards } = fracture(0.17, 0.64, 1);
    expect(shards.length).toBeGreaterThanOrEqual(12);
    expect(shards.length).toBeLessThanOrEqual(FRACTURE.maxFragments);
    const triangles = shards.reduce((sum, shard) => sum + shard.mesh.indices.length / 3, 0);
    expect(triangles).toBeLessThan(150_000);
  });

  it('holds for random blows: closed shards, exact volume, sound mass properties and a consistent crack graph', () => {
    const rand = mulberry32(12345);
    const times: number[] = [];
    for (let n = 0; n < 40; n++) {
      const u = rand();
      const v = rand() < 0.15 ? (rand() < 0.5 ? 1 : 0.001 + rand() * 0.05) : 0.05 + rand() * 0.95;
      const energy = 0.2 + rand() * 0.8;
      const tangent: Vec2 | undefined = rand() < 0.5 ? undefined : [Math.cos(rand() * 6.28) * rand(), Math.sin(rand() * 6.28) * rand()];
      const seed = Math.floor(rand() * 1e6);
      const started = performance.now();
      const result = fractureBowl(surface, { u, v, energy, tangent }, seed, DEFAULT_CONTROLS);
      times.push(performance.now() - started);
      expect(result, `blow ${n}`).not.toBeNull();
      const { shards, graph } = result!;
      let volume = 0;
      for (const shard of shards) {
        const solid = closedness(shard.mesh);
        expect(solid.open + solid.nonManifold, `blow ${n} shard ${shard.id}`).toBe(0);
        expect(shard.volume).toBeGreaterThan(0);
        expect(shard.mass).toBeGreaterThan(0);
        expect(shard.centroid.every(Number.isFinite)).toBe(true);
        expect(shard.inertia.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
        volume += shard.volume;
      }
      expect(Math.abs(volume - intactVolume) / intactVolume, `blow ${n}`).toBeLessThan(0.004);
      // Every crack has exactly two sides, and they are different shards.
      for (const edge of graph.edges) {
        expect(edge.shardB, `blow ${n}`).not.toBeNull();
        expect(edge.shardA).not.toBe(edge.shardB);
        expect(edge.length).toBeGreaterThan(0);
      }
    }
    // Not a benchmark: only a guard against a pathological blow (the machine decides the rest).
    times.sort((a, b) => a - b);
    expect(times[times.length - 1]).toBeLessThan(4000);
  }, 180_000);
});
