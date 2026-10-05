import { describe, expect, it } from 'vitest';
import { BowlSurface } from '../src/ceramic/uv-surface';
import { BOWL, DEFAULT_CONTROLS, FRACTURE } from '../src/config';
import { buildIntactBowl, fractureBowl, type FractureResult } from '../src/fracture/fracture-system';
import { fractureEnergy, fractureRadius, seedCount, CONTACT } from '../src/fracture/impact';
import { VERTEX_FLOATS } from '../src/fracture/mesh-assembler';
import { buildPattern } from '../src/fracture/pattern';
import { EDGE_POLE, EDGE_RIM, EDGE_SEAM } from '../src/fracture/power-diagram';
import { allFinite, closedness } from './helpers';

const surface = new BowlSurface();
const SEED = 20260214;
const fracture = (u: number, v: number, energy: number, seed = SEED): FractureResult => {
  const result = fractureBowl(surface, { u, v, energy }, seed, DEFAULT_CONTROLS);
  if (!result) throw new Error(`no fracture for u=${u} v=${v} energy=${energy}`);
  return result;
};

/** A spread of impacts: mid wall, near the rim, low on the belly, on the rim, by the foot, across u = 0, on the base. */
const IMPACTS: Array<[number, number]> = [[0.17, 0.64], [0.02, 0.92], [0.6, 0.3], [0.85, 1], [0.4, 0.22], [0.99, 0.5], [0.3, 0.05]];

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
  it('normalises energy and respects the controls', () => {
    const base = fractureEnergy(0.07, 25, CONTACT.steel, DEFAULT_CONTROLS);
    expect(base).toBeGreaterThan(FRACTURE.threshold);
    expect(base).toBeLessThan(1);
    expect(fractureEnergy(0.07, 25, CONTACT.steel, { brittleness: 95, thickness: 46 })).toBeGreaterThan(base);
    expect(fractureEnergy(0.07, 25, CONTACT.steel, { brittleness: 58, thickness: 95 })).toBeLessThan(base);
    expect(fractureEnergy(0.07, 2, CONTACT.steel, DEFAULT_CONTROLS)).toBeLessThan(FRACTURE.threshold);
    expect(fractureEnergy(10, 1e6, CONTACT.steel, DEFAULT_CONTROLS)).toBe(FRACTURE.maxEnergy);
    expect(fractureEnergy(Number.NaN, 1, 1, DEFAULT_CONTROLS)).toBe(0);
  });

  it('grows the damaged radius and the seed count with energy', () => {
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

describe('fracture generation', () => {
  it('is deterministic: same seed, impact and settings give the same pattern', () => {
    const a = buildPattern(surface, { u: 0.17, v: 0.64, energy: 0.72 }, SEED, DEFAULT_CONTROLS);
    const b = buildPattern(surface, { u: 0.17, v: 0.64, energy: 0.72 }, SEED, DEFAULT_CONTROLS);
    expect(b.seeds).toEqual(a.seeds);
    expect(b.faceCount).toBe(a.faceCount);
    expect(Array.from(b.cellFace)).toEqual(Array.from(a.cellFace));
    expect(b.diagram.vertexU).toEqual(a.diagram.vertexU);
    expect(b.diagram.vertexV).toEqual(a.diagram.vertexV);

    const first = fracture(0.17, 0.64, 0.72), second = fracture(0.17, 0.64, 0.72);
    expect(second.shards.length).toBe(first.shards.length);
    expect(second.graph.edges.map((e) => [e.shardA, e.shardB, e.length])).toEqual(first.graph.edges.map((e) => [e.shardA, e.shardB, e.length]));
    first.shards.forEach((shard, i) => {
      expect(Array.from(second.shards[i].mesh.vertices.subarray(0, 300))).toEqual(Array.from(shard.mesh.vertices.subarray(0, 300)));
    });
  });

  it('changes with the seed and with where the bowl is hit', () => {
    const base = buildPattern(surface, { u: 0.17, v: 0.64, energy: 0.72 }, SEED, DEFAULT_CONTROLS);
    const otherSeed = buildPattern(surface, { u: 0.17, v: 0.64, energy: 0.72 }, SEED + 1, DEFAULT_CONTROLS);
    const otherPlace = buildPattern(surface, { u: 0.52, v: 0.4, energy: 0.72 }, SEED, DEFAULT_CONTROLS);
    expect(otherSeed.seeds).not.toEqual(base.seeds);
    expect(otherPlace.seeds).not.toEqual(base.seeds);
    // The damage is centred on the impact.
    expect(base.seeds[0].u).toBeCloseTo(0.17, 2);
    expect(otherPlace.seeds[0].v).toBeCloseTo(0.4, 2);
  });

  it('produces finite cells with real area, and symmetric adjacency', () => {
    for (const [u, v] of IMPACTS) {
      for (const energy of [0.22, 0.8]) {
      const { diagram, columnStart } = buildPattern(surface, { u, v, energy }, SEED, DEFAULT_CONTROLS);
      const cells = diagram.cells;
      expect(cells.length).toBeGreaterThan(3);
      let covered = 0;
      for (const cell of cells) {
        covered += cell.areaUV;
        // Everything lives in one unwrapped turn that starts opposite the impact.
        for (const value of cell.u) {
          expect(value).toBeGreaterThanOrEqual(columnStart / surface.U);
          expect(value).toBeLessThanOrEqual((columnStart + surface.U) / surface.U);
        }
        expect(allFinite(cell.u)).toBe(true);
        expect(allFinite(cell.v)).toBe(true);
        expect(cell.areaUV).toBeGreaterThan(1e-10);
        expect(cell.u.length).toBeGreaterThanOrEqual(3);
        // Every cell lies on the bowl.
        for (const value of cell.v) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
        // If a cell says seed j is across an edge, cell j says the same about this one.
        cell.tag.forEach((tag) => {
          if (tag < 0) {
            expect([EDGE_RIM, EDGE_POLE, EDGE_SEAM]).toContain(tag);
            return;
          }
          const neighbour = diagram.bySeed[tag].map((index) => diagram.cells[index]);
          expect(neighbour.length).toBeGreaterThan(0);
          expect(neighbour.some((piece) => piece.tag.includes(cell.seed))).toBe(true);
        });
      }
      // The cells tile the bowl: all of it, once.
      expect(covered).toBeCloseTo(1, 9);
      }
    }
  });

  it('knocks a hole out of the bowl when hit lightly, and breaks the wall right round when hit hard', () => {
    const whole = buildIntactBowl(surface);
    for (const [u, v] of [[0.17, 0.64], [0.02, 0.92], [0.6, 0.45], [0.99, 0.5]]) {
      const light = fracture(u, v, 0.22);
      expect(light.pattern.shattered).toBe(false);
      // What is left standing is still most of a bowl.
      expect(light.shards[0].volume / whole.volume).toBeGreaterThan(0.75);

      const hard = fracture(u, v, 0.6);
      expect(hard.pattern.shattered).toBe(true);
      const foot = hard.shards[0];
      expect(foot.survivor).toBe(true);
      // Only the foot is left: a low piece that sits on the axis, well short of the rim.
      let top = -Infinity;
      for (let i = 1; i < foot.mesh.vertices.length; i += VERTEX_FLOATS) top = Math.max(top, foot.mesh.vertices[i] + foot.centroid[1]);
      expect(top).toBeLessThan(BOWL.height * 0.6);
      expect(Math.hypot(foot.centroid[0], foot.centroid[2])).toBeLessThan(BOWL.footOuter);
      expect(foot.volume / whole.volume).toBeLessThan(0.45);
      // The wall comes away in pieces narrow enough to fall: none reaches halfway round the bowl.
      for (const shard of hard.shards.slice(1)) {
        let sumX = 0, sumZ = 0, count = 0;
        const angles: number[] = [];
        for (let i = 0; i < shard.mesh.vertices.length; i += VERTEX_FLOATS * 5) {
          const x = shard.mesh.vertices[i] + shard.centroid[0], z = shard.mesh.vertices[i + 2] + shard.centroid[2];
          if (Math.hypot(x, z) < 0.3) continue;
          sumX += x; sumZ += z; count++;
          angles.push(Math.atan2(z, x));
        }
        if (count === 0) continue;
        const middle = Math.atan2(sumZ, sumX);
        let spread = 0;
        for (const angle of angles) {
          let d = angle - middle;
          d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
          spread = Math.max(spread, Math.abs(d));
        }
        expect(spread).toBeLessThan(Math.PI * 0.48);
      }
    }
  });

  it('builds a crack graph that matches the shards', () => {
    for (const [u, v] of IMPACTS) {
      const { shards, graph } = fracture(u, v, 0.75);
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
        expect(edge.polyline.every((p) => p.every(Number.isFinite))).toBe(true);
        expect(edge.resin.fill.length).toBeGreaterThanOrEqual(6);
        expect(edge.resin.fill.length).toBeLessThanOrEqual(64);
        // Both sides hold the same polyline, each in its own shard's frame.
        const p = edge.polyline[0], la = edge.polylineLocalA[0], lb = edge.polylineLocalB[0];
        for (let k = 0; k < 3; k++) {
          expect(la[k] + shards[a].centroid[k]).toBeCloseTo(p[k], 9);
          expect(lb[k] + shards[b].centroid[k]).toBeCloseTo(p[k], 9);
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
    }
  });

  it('breaks into more pieces the harder it is hit', () => {
    const energies = [0.2, 0.38, 0.55, 0.7, 0.85, 1];
    const totals = energies.map(() => 0);
    for (const seed of [1, SEED, 777]) {
      for (const [u, v] of IMPACTS) {
        // The number of shards is the number of faces of the pattern; no need to mesh them here.
        const counts = energies.map((energy) => buildPattern(surface, { u, v, energy }, seed, DEFAULT_CONTROLS).faceCount);
        counts.forEach((count, i) => {
          totals[i] += count;
          expect(count).toBeLessThanOrEqual(FRACTURE.maxFragments);
          if (i > 0) expect(count).toBeGreaterThanOrEqual(counts[i - 1] - 1);
        });
        expect(counts[counts.length - 1]).toBeGreaterThan(counts[0]);
      }
    }
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThan(totals[i - 1]);
  });

  it('does not treat u = 0 / 1 as special', () => {
    const counts: number[] = [];
    for (const u of [0.999, 0, 0.001, 0.5]) {
      const { shards, pattern } = fracture(u, 0.6, 0.7);
      counts.push(shards.length);
      // The turn is cut opposite the impact, wherever that is.
      const cut = (pattern.columnStart / surface.U) % 1;
      expect(Math.abs(((cut - u - 0.5) % 1 + 1.5) % 1 - 0.5)).toBeLessThan(1 / surface.U);
      for (const shard of shards) expect(closedness(shard.mesh).open).toBe(0);
    }
    // Hitting across the wrap gives the same kind of break as hitting anywhere else.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(6);
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
    expect(shards.length).toBeGreaterThanOrEqual(20);
    expect(shards.length).toBeLessThanOrEqual(48);
    const triangles = shards.reduce((sum, shard) => sum + shard.mesh.indices.length / 3, 0);
    expect(triangles).toBeLessThan(150_000);
  });
});
