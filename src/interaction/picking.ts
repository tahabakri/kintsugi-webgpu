import type { CrackEdge } from '../fracture/crack-graph';
import type { Camera, Ray } from '../gpu/camera';
import { pointSegment2D } from '../math/geometry';
import { dot3, sub3, type Vec3 } from '../math/vec';
import type { Body, PhysicsWorld } from '../physics/world';

export interface BodyHit {
  kind: 'shard' | 'ball';
  /** Shard id, or the ball's index. */
  id: number;
  body: Body;
  point: Vec3;
  distance: number;
}

export interface CrackHit {
  edge: CrackEdge;
  /** Position along the edge by arc length, 0…1. */
  s: number;
  /** Which shard's side was under the pointer; null when the two sides are together. */
  side: 0 | 1 | null;
  pixels: number;
}

/** First dynamic body under a ray. */
export function pickBody(physics: PhysicsWorld, ray: Ray): BodyHit | null {
  const hit = physics.castRay(ray.origin, ray.direction);
  if (!hit) return null;
  if (hit.tag.kind === 'shard') return { kind: 'shard', id: hit.shard >= 0 ? hit.shard : hit.tag.id, body: hit.body, point: hit.point, distance: hit.distance };
  if (hit.tag.kind === 'ball') return { kind: 'ball', id: hit.tag.index, body: hit.body, point: hit.point, distance: hit.distance };
  return null;
}

/** Cumulative arc length along a polyline, normalised to 0…1, cached on first use. */
const arcCache = new WeakMap<CrackEdge, Float32Array>();
function arcFractions(edge: CrackEdge): Float32Array {
  let cached = arcCache.get(edge);
  if (!cached) {
    const points = edge.polyline;
    cached = new Float32Array(points.length);
    for (let i = 1; i < points.length; i++) {
      cached[i] = cached[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
    }
    const total = cached[points.length - 1] || 1;
    for (let i = 0; i < cached.length; i++) cached[i] /= total;
    arcCache.set(edge, cached);
  }
  return cached;
}

/**
 * Nearest visible crack to a screen position. Every crack polyline is projected to the screen as
 * it currently sits on its shards (both skins, both sides when the shards are apart) and the
 * closest segment within `radius` pixels wins, provided nothing nearer to the camera covers it.
 * With `closedOnly`, only cracks whose two sides are together count, and of those only the ones
 * that can still take resin.
 */
export function pickCrack(
  edges: readonly CrackEdge[],
  physics: PhysicsWorld,
  camera: Camera,
  x: number,
  y: number,
  radius: number,
  closedOnly = false,
): CrackHit | null {
  const ray = camera.ray(x, y);
  const surface = physics.castRayAny(ray.origin, ray.direction);
  let best: CrackHit | null = null;
  let bestScore = radius;

  for (const edge of edges) {
    if (edge.shardB === null) continue;
    if (closedOnly && (!edge.aligned || (edge.joined && edge.fill >= 0.999))) continue;
    const fractions = arcFractions(edge);
    const sides: Array<{ shard: number; side: 0 | 1 | null }> = edge.aligned
      ? [{ shard: edge.shardA, side: null }]
      : [{ shard: edge.shardA, side: 0 }, { shard: edge.shardB, side: 1 }];
    for (const { shard, side } of sides) {
      for (const skin of [edge.polyline, edge.polylineInner]) {
        let previous: [number, number, number] | null = null;
        let previousWorld: Vec3 | null = null;
        for (let i = 0; i < skin.length; i++) {
          const world = physics.worldPoint(shard, skin[i]);
          const screen = world ? camera.project(world) : null;
          if (previous && screen && previousWorld && world) {
            const hit = pointSegment2D(x, y, previous[0], previous[1], screen[0], screen[1]);
            const pixels = Math.sqrt(hit.d2);
            if (pixels < bestScore) {
              // Reject cracks hidden behind whatever the pointer is actually over.
              const at: Vec3 = [
                previousWorld[0] + (world[0] - previousWorld[0]) * hit.t,
                previousWorld[1] + (world[1] - previousWorld[1]) * hit.t,
                previousWorld[2] + (world[2] - previousWorld[2]) * hit.t,
              ];
              const depth = dot3(sub3(at, ray.origin), ray.direction);
              if (depth <= surface + 0.16) {
                bestScore = pixels;
                best = { edge, side, pixels, s: fractions[i - 1] + (fractions[i] - fractions[i - 1]) * hit.t };
              }
            }
          }
          previous = screen;
          previousWorld = world;
        }
      }
    }
  }
  return best;
}
