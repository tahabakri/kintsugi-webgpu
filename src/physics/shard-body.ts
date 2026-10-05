import RAPIER from '@dimforge/rapier3d-compat';
import { MATERIAL_PHYSICS } from '../config';
import type { ShardGeometry } from '../fracture/shard-builder';
import { quatRotate, type Quat } from '../math/quat';
import type { Vec3 } from '../math/vec';

/**
 * Enough damping that a curved shard rocks a few times and lies still, as it would on linen,
 * rather than seesawing across the table.
 */
export const SHARD_DAMPING = { linear: 0.12, angular: 0.85 } as const;

export interface ShardBodyOptions {
  /** Emit collision events for this body's colliders (used for the intact bowl). */
  reportContacts?: boolean;
  /** Start asleep, e.g. the bowl resting on the plinth. */
  sleeping?: boolean;
}

export interface ShardColliders {
  colliders: RAPIER.Collider[];
  /** True when no convex hull could be built and a ball stands in for the shard. */
  fallback: boolean;
}

/**
 * Attaches a shard's collision shapes to a body: one convex hull per collision block of the shard,
 * shifted by `offset` (the shard's position in the body's frame). If no hull can be built the
 * shard falls back to a ball and the caller counts it.
 */
export function attachShardColliders(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  geometry: ShardGeometry,
  offset: Vec3,
  reportContacts: boolean,
): ShardColliders {
  const shifted = offset[0] !== 0 || offset[1] !== 0 || offset[2] !== 0;
  const colliders: RAPIER.Collider[] = [];
  const finish = (desc: RAPIER.ColliderDesc) => {
    desc.setDensity(1).setFriction(MATERIAL_PHYSICS.ceramicFriction).setRestitution(MATERIAL_PHYSICS.ceramicRestitution);
    if (reportContacts) desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    colliders.push(world.createCollider(desc, body));
  };
  for (const source of geometry.hulls) {
    let points = source;
    if (shifted) {
      points = new Float32Array(source.length);
      for (let i = 0; i < source.length; i += 3) {
        points[i] = source[i] + offset[0];
        points[i + 1] = source[i + 1] + offset[1];
        points[i + 2] = source[i + 2] + offset[2];
      }
    }
    const hull = RAPIER.ColliderDesc.convexHull(points);
    if (hull) finish(hull);
  }
  let fallback = false;
  if (colliders.length === 0) {
    fallback = true;
    finish(RAPIER.ColliderDesc.ball(Math.max(0.03, geometry.boundingRadius * 0.55)).setTranslation(offset[0], offset[1], offset[2]));
  }

  // Hulls overlap and overfill the shell, so their summed volume is not the shard's. Scale the
  // density so these colliders together weigh what the closed mesh says the shard should.
  let volume = 0;
  for (const collider of colliders) volume += collider.volume();
  const density = geometry.mass / Math.max(volume, 1e-6);
  for (const collider of colliders) collider.setDensity(density);
  return { colliders, fallback };
}

/** Dynamic body for one ceramic piece, placed at the piece's centre of mass. */
export function createShardBody(
  world: RAPIER.World,
  geometry: ShardGeometry,
  origin: Vec3,
  rotation: Quat,
  options: ShardBodyOptions = {},
): { body: RAPIER.RigidBody; colliders: RAPIER.Collider[]; fallback: boolean } {
  const centre = quatRotate(rotation, geometry.centroid);
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(origin[0] + centre[0], origin[1] + centre[1], origin[2] + centre[2])
    .setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] })
    .setLinearDamping(SHARD_DAMPING.linear)
    .setAngularDamping(SHARD_DAMPING.angular)
    // No continuous collision here: the striker carries it, and the plinth is thick. Sweeping
    // dozens of compound shards through a pile costs far more than the rare pass-through is worth.
    .setUserData({ kind: 'shard', id: geometry.id });
  if (options.sleeping) desc.setSleeping(true);
  const body = world.createRigidBody(desc);
  const { colliders, fallback } = attachShardColliders(world, body, geometry, [0, 0, 0], options.reportContacts === true);
  return { body, colliders, fallback };
}
