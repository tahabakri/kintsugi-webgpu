import { FRACTURE, type Controls } from '../config';
import type { BowlSurface } from '../ceramic/uv-surface';
import type { ImpactSpec } from './impact';
import { buildCrackGraph, collectSegments, type CrackGraph } from './crack-graph';
import { buildPattern, type FracturePattern } from './pattern';
import { buildShards, type ShardGeometry } from './shard-builder';

export interface FractureResult {
  pattern: FracturePattern;
  /** shards[i].id === i; shard 0 is the surviving shell. */
  shards: ShardGeometry[];
  graph: CrackGraph;
  /** Time spent generating the fracture, for the debug overlay. */
  elapsedMs: number;
  /** Where that time went, in milliseconds. */
  timings: { pattern: number; segments: number; shards: number; graph: number };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function meshIsFinite(shard: ShardGeometry): boolean {
  const { vertices, indices } = shard.mesh;
  if (indices.length === 0) return false;
  for (let i = 0; i < vertices.length; i++) if (!Number.isFinite(vertices[i])) return false;
  return Number.isFinite(shard.volume) && shard.volume > 0 && shard.centroid.every(Number.isFinite);
}

/**
 * Impact → material-space power diagram → closed shard meshes → crack graph.
 * Returns null when the blow is too weak to fracture or the pattern degenerates; the caller then
 * simply leaves the bowl intact.
 */
export function fractureBowl(
  surface: BowlSurface,
  impact: ImpactSpec,
  resetSeed: number,
  controls: Pick<Controls, 'brittleness' | 'thickness'>,
): FractureResult | null {
  if (!Number.isFinite(impact.u) || !Number.isFinite(impact.v) || !Number.isFinite(impact.energy)) return null;
  if (impact.energy < FRACTURE.threshold) return null;
  const started = now();
  const pattern = buildPattern(surface, impact, resetSeed, controls);
  const t1 = now();
  if (pattern.faceCount < 2) return null;
  const segments = collectSegments(surface, pattern);
  const t2 = now();
  const shards = buildShards(surface, pattern, segments);
  const t3 = now();
  if (!shards.every(meshIsFinite)) return null;
  const graph = buildCrackGraph(surface, pattern, segments, shards.map((shard) => shard.centroid));
  if (graph.edges.length === 0) return null;
  const done = now();
  return { pattern, shards, graph, elapsedMs: done - started, timings: { pattern: t1 - started, segments: t2 - t1, shards: t3 - t2, graph: done - t3 } };
}

/** The intact bowl is the degenerate fracture with a single face covering everything. */
export function buildIntactBowl(surface: BowlSurface): ShardGeometry {
  return buildShards(surface, null, [])[0];
}
