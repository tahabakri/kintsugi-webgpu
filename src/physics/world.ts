import RAPIER from '@dimforge/rapier3d-compat';
import { MATERIAL_PHYSICS, SIM, STAGE } from '../config';
import type { ShardGeometry } from '../fracture/shard-builder';
import { quatRotate, type Quat } from '../math/quat';
import { add3, clampLength3, len3, type Vec3 } from '../math/vec';
import { attachShardColliders, createShardBody, SHARD_DAMPING } from './shard-body';

export type Body = RAPIER.RigidBody;

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

/**
 * A ceramic piece in the simulation; the intact bowl is simply piece 0 with no siblings.
 * Shards that have been bonded share one body: `root` names the shard whose centre of mass is
 * that body's origin and `offset` is this shard's centre in the body's frame.
 */
export interface Piece {
  id: number;
  body: Body;
  geometry: ShardGeometry;
  root: number;
  offset: Vec3;
  colliders: RAPIER.Collider[];
}

export type BodyTag = { kind: 'shard'; id: number } | { kind: 'ball'; index: number } | { kind: 'static'; name: string } | { kind: 'grab' };

/** What the intact bowl ran into during a step, with pre-solve velocities. */
export interface Contact {
  other: 'ball' | 'static';
  ballIndex: number;
  /** Contact position and normal (pointing into the bowl) in world space. */
  point: Vec3;
  normal: Vec3;
  /** Velocity of the other body relative to the bowl at the contact, before the solver ran. */
  relativeVelocity: Vec3;
  normalSpeed: number;
  effectiveMass: number;
}

/** One rigid body of ceramic: the shards riding on it and a sphere round all of them. */
export interface Group {
  body: Body;
  shards: number[];
  centre: Vec3;
  radius: number;
}

/**
 * How far contacts may sink before the solver pushes back, in world units. A fresh fracture is
 * given some slack; once the pieces have parted they are held to a tighter fit.
 */
const CONTACT_SLACK = { fresh: 0.015, settled: 0.004 } as const;

/** Two pieces pressed into each other, as the narrow phase sees them. */
export interface Overlap {
  a: number;
  b: number;
  depth: number;
  normal: Vec3;
}

export const toVec = (v: RAPIER.Vector): Vec3 => [v.x, v.y, v.z];
export const toQuat = (q: RAPIER.Rotation): Quat => [q.x, q.y, q.z, q.w];
export const fromVec = (v: Vec3): RAPIER.Vector => ({ x: v[0], y: v[1], z: v[2] });
export const fromQuat = (q: Quat): RAPIER.Rotation => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

let rapierReady: Promise<void> | null = null;

/** Loads Rapier's WebAssembly once. */
export function loadRapier(): Promise<void> {
  if (!rapierReady) {
    // The compat build calls its own generated initialiser the old way, which logs a deprecation
    // warning that is not ours to fix. Silence exactly that message for the duration of init.
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('deprecated parameters for the initialization function')) return;
      warn.apply(console, args);
    };
    rapierReady = RAPIER.init().finally(() => { console.warn = warn; });
  }
  return rapierReady;
}

interface Snapshot {
  linear: Vec3;
  angular: Vec3;
  centre: Vec3;
}

/**
 * Rapier world for the study: the plinth, the wall and the room bounds as fixed colliders, the
 * ceramic pieces and steel strikers as dynamic bodies. Runs at a fixed 1/120 s step.
 */
export class PhysicsWorld {
  world: RAPIER.World;
  private events: RAPIER.EventQueue;
  readonly pieces = new Map<number, Piece>();
  /** Shards whose convex hull could not be built and that fell back to a ball collider. */
  colliderFallbacks = 0;
  private fixedBody!: Body;
  /** Invisible limits of the room; they stop stray pieces but never count as something in view. */
  private boundsBody!: Body;
  /** Which shard each collider belongs to, since bonded shards share a body. */
  private readonly colliderShard = new Map<number, number>();
  /** Spring joints steadying nearly mated pieces, by crack edge id. */
  private readonly tacks = new Map<number, { joints: RAPIER.ImpulseJoint[]; bodies: [Body, Body] }>();
  /** How many tacks hold each body, so its extra damping can be lifted when the last one goes. */
  private readonly tackHolds = new Map<number, number>();

  private constructor() {
    this.world = this.createWorld();
    this.events = new RAPIER.EventQueue(true);
  }

  static async create(): Promise<PhysicsWorld> {
    await loadRapier();
    return new PhysicsWorld();
  }

  private createWorld(): RAPIER.World {
    const world = new RAPIER.World({ x: 0, y: -SIM.gravity, z: 0 });
    world.timestep = SIM.dt;
    // Pieces are of the order of one world unit across, which is what Rapier's default length
    // unit assumes. (Scaling it to "10 units per metre" widens every contact margin tenfold and
    // triples the cost of a step for no visible gain.)
    world.integrationParameters.numSolverIterations = 4;
    // Convex hulls of neighbouring shards can overlap by a millimetre or so where a crack is not
    // planar. Tolerating that much penetration keeps a fresh fracture from popping apart.
    world.integrationParameters.normalizedAllowedLinearError = CONTACT_SLACK.fresh;

    this.fixedBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setUserData({ kind: 'static', name: 'studio' } satisfies BodyTag));
    this.boundsBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setUserData({ kind: 'static', name: 'bounds' } satisfies BodyTag));
    const fixed = (desc: RAPIER.ColliderDesc, friction: number = MATERIAL_PHYSICS.tableFriction, body: Body = this.fixedBody) =>
      world.createCollider(desc.setFriction(friction).setRestitution(0.1), body);

    const turn: RAPIER.Rotation = { x: 0, y: Math.sin(STAGE.azimuth / 2), z: 0, w: Math.cos(STAGE.azimuth / 2) };
    const front: Vec3 = [Math.sin(STAGE.azimuth), 0, Math.cos(STAGE.azimuth)];

    // Table: a block from the wall to its front edge, top surface at y = 0.
    const tableHalf = -STAGE.floorY / 2;
    const tableDepth = (STAGE.wallDistance + STAGE.tableFront) / 2, tableCentre = (STAGE.tableFront - STAGE.wallDistance) / 2;
    fixed(RAPIER.ColliderDesc.cuboid(STAGE.tableHalfWidth, tableHalf, tableDepth)
      .setTranslation(front[0] * tableCentre, -tableHalf, front[2] * tableCentre)
      .setRotation(turn));
    fixed(RAPIER.ColliderDesc.cuboid(40, 0.5, 40).setTranslation(0, STAGE.floorY - 0.5, 0));

    // Back wall, plus invisible bounds on the other three sides and above so nothing leaves the room.
    const side: Vec3 = [Math.cos(STAGE.azimuth), 0, -Math.sin(STAGE.azimuth)];
    const slab = (centre: Vec3, hx: number, hz: number, body: Body) =>
      fixed(RAPIER.ColliderDesc.cuboid(hx, 12, hz).setTranslation(centre[0], 8, centre[2]).setRotation(turn), 0.4, body);
    const reach = 9;
    slab([-front[0] * (STAGE.wallDistance + 0.5), 0, -front[2] * (STAGE.wallDistance + 0.5)], 30, 0.5, this.fixedBody);
    slab([front[0] * (reach + 0.5), 0, front[2] * (reach + 0.5)], 30, 0.5, this.boundsBody);
    slab([side[0] * (reach + 0.5), 0, side[2] * (reach + 0.5)], 0.5, 30, this.boundsBody);
    slab([-side[0] * (reach + 0.5), 0, -side[2] * (reach + 0.5)], 0.5, 30, this.boundsBody);
    fixed(RAPIER.ColliderDesc.cuboid(40, 0.5, 40).setTranslation(0, 16, 0), 0.4, this.boundsBody);
    return world;
  }

  /** Throws everything away and starts an empty room. */
  reset(): void {
    this.world.free();
    this.events.free();
    this.pieces.clear();
    this.colliderShard.clear();
    this.tacks.clear();
    this.tackHolds.clear();
    this.colliderFallbacks = 0;
    this.world = this.createWorld();
    this.events = new RAPIER.EventQueue(true);
  }

  /**
   * Adds a ceramic piece. `origin` and `rotation` place the bowl's own frame in the world; the
   * body sits at the piece's centre of mass.
   */
  addPiece(geometry: ShardGeometry, origin: Vec3, rotation: Quat, options: { reportContacts?: boolean; sleeping?: boolean } = {}): Piece {
    const { body, colliders, fallback } = createShardBody(this.world, geometry, origin, rotation, options);
    if (fallback) this.colliderFallbacks++;
    const piece: Piece = { id: geometry.id, body, geometry, root: geometry.id, offset: [0, 0, 0], colliders };
    for (const collider of colliders) this.colliderShard.set(collider.handle, geometry.id);
    this.pieces.set(geometry.id, piece);
    return piece;
  }

  /**
   * Once a fracture's pieces have moved apart there is no reason to let them rest sunk into one
   * another: `settled` holds contacts to a fit of under half a millimetre.
   */
  setContactSlack(settled: boolean): void {
    this.world.integrationParameters.normalizedAllowedLinearError = settled ? CONTACT_SLACK.settled : CONTACT_SLACK.fresh;
  }

  /** Removes a piece that has a body to itself (the intact bowl, at the moment it breaks). */
  removePiece(id: number): void {
    const piece = this.pieces.get(id);
    if (!piece) return;
    for (const collider of piece.colliders) this.colliderShard.delete(collider.handle);
    this.world.removeRigidBody(piece.body);
    this.pieces.delete(id);
  }

  /** Every distinct rigid body that carries ceramic. */
  bodies(): Body[] {
    const seen = new Set<number>();
    const list: Body[] = [];
    for (const piece of this.pieces.values()) {
      if (seen.has(piece.body.handle)) continue;
      seen.add(piece.body.handle);
      list.push(piece.body);
    }
    return list;
  }

  /** Every separate rigid body of ceramic, with what rides on it and how much room it takes. */
  groups(): Group[] {
    const byBody = new Map<number, Group>();
    for (const piece of this.pieces.values()) {
      let group = byBody.get(piece.body.handle);
      if (!group) byBody.set(piece.body.handle, group = { body: piece.body, shards: [], centre: toVec(piece.body.worldCom()), radius: 0 });
      group.shards.push(piece.id);
      const at = this.pose(piece.id)!.position;
      group.radius = Math.max(group.radius, Math.hypot(at[0] - group.centre[0], at[1] - group.centre[1], at[2] - group.centre[2]) + piece.geometry.boundingRadius);
    }
    return [...byBody.values()];
  }

  /**
   * Where a body's origin would be with its centre of mass over (x, z), the way up it already
   * is, and its lowest point `gap` above the table.
   */
  private restingPlace(body: Body, x: number, z: number, gap: number): RAPIER.Vector {
    const rotation = toQuat(body.rotation());
    let lowest = Infinity;
    for (const piece of this.pieces.values()) {
      if (piece.body.handle !== body.handle) continue;
      const o = piece.offset;
      for (const hull of piece.geometry.hulls) {
        for (let i = 0; i < hull.length; i += 3) {
          lowest = Math.min(lowest, quatRotate(rotation, [hull[i] + o[0], hull[i + 1] + o[1], hull[i + 2] + o[2]])[1]);
        }
      }
    }
    if (!Number.isFinite(lowest)) lowest = 0;
    const com = quatRotate(rotation, toVec(body.localCom()));
    return { x: x - com[0], y: gap - lowest, z: z - com[2] };
  }

  /**
   * True if the body, set down as `setDown` would set it, would touch nothing: no other piece,
   * no striker, not the wall. Tested with its real collision shapes against the world as of the
   * last step.
   */
  fitsAt(body: Body, x: number, z: number, gap: number): boolean {
    const at = this.restingPlace(body, x, z, gap), rotation = body.rotation();
    let clear = true;
    for (const piece of this.pieces.values()) {
      if (piece.body.handle !== body.handle) continue;
      for (const collider of piece.colliders) {
        this.world.intersectionsWithShape(at, rotation, collider.shape, () => { clear = false; return false; }, undefined, undefined, undefined, body);
        if (!clear) return false;
      }
    }
    return clear;
  }

  /**
   * Sets a body down on the table with its centre of mass over (x, z), the way up it already is,
   * its lowest point `gap` above the surface, and at rest.
   */
  setDown(body: Body, x: number, z: number, gap: number): void {
    body.setTranslation(this.restingPlace(body, x, z, gap), true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Pose of a shard's own frame (its centre of mass and the bowl's axes) in the world. */
  pose(id: number): Pose | null {
    const piece = this.pieces.get(id);
    if (!piece) return null;
    const rotation = toQuat(piece.body.rotation());
    const origin = toVec(piece.body.translation());
    const o = piece.offset;
    return { position: o[0] === 0 && o[1] === 0 && o[2] === 0 ? origin : add3(origin, quatRotate(rotation, o)), rotation };
  }

  /** World position of a point given in bowl coordinates and riding on piece `id`. */
  worldPoint(id: number, bowlPoint: Vec3): Vec3 | null {
    const piece = this.pieces.get(id);
    if (!piece) return null;
    const c = this.pieces.get(piece.root)!.geometry.centroid;
    const local: Vec3 = [bowlPoint[0] - c[0], bowlPoint[1] - c[1], bowlPoint[2] - c[2]];
    return add3(toVec(piece.body.translation()), quatRotate(toQuat(piece.body.rotation()), local));
  }

  /** Shard a collider belongs to, or -1. */
  shardOf(collider: RAPIER.Collider): number {
    return this.colliderShard.get(collider.handle) ?? -1;
  }

  private snapshot(body: Body): Snapshot {
    return { linear: toVec(body.linvel()), angular: toVec(body.angvel()), centre: toVec(body.worldCom()) };
  }

  /**
   * Advances one fixed step. When `watch` is a piece, returns the hardest contact that began on it
   * during the step, described with velocities from before the solver responded.
   */
  step(watch: Piece | null, ballBodies: readonly Body[] = []): Contact | null {
    const before = watch ? this.snapshot(watch.body) : null;
    const ballsBefore = watch ? ballBodies.map((body) => this.snapshot(body)) : [];
    this.world.step(this.events);

    let hardest: Contact | null = null;
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started || !watch || !before) return;
      const c1 = this.world.getCollider(h1), c2 = this.world.getCollider(h2);
      if (!c1 || !c2) return;
      const b1 = c1.parent(), b2 = c2.parent();
      if (!b1 || !b2) return;
      const watchFirst = b1.handle === watch.body.handle;
      if (!watchFirst && b2.handle !== watch.body.handle) return;
      const otherBody = watchFirst ? b2 : b1;
      const tag = otherBody.userData as BodyTag | undefined;
      if (!tag || tag.kind === 'shard' || tag.kind === 'grab') return;

      // Contact geometry from the narrow phase where it is available.
      let point: Vec3 | null = null;
      let normal: Vec3 | null = null;
      this.world.contactPair(c1, c2, (manifold, flipped) => {
        const n = toVec(manifold.normal());
        // The manifold normal points from its first collider towards its second.
        const towardsWatch = watchFirst !== flipped ? -1 : 1;
        normal = [n[0] * towardsWatch, n[1] * towardsWatch, n[2] * towardsWatch];
        if (manifold.numSolverContacts() > 0) point = toVec(manifold.solverContactPoint(0));
      });

      const ballIndex = tag.kind === 'ball' ? tag.index : -1;
      const otherBefore = ballIndex >= 0 ? ballsBefore[ballBodies.findIndex((body) => body.handle === otherBody.handle)] : null;
      if (ballIndex >= 0 && !otherBefore) return;
      if (!point) point = otherBefore ? otherBefore.centre : this.lowestPoint(watch);
      if (!normal) normal = [0, 1, 0];

      const r: Vec3 = [point[0] - before.centre[0], point[1] - before.centre[1], point[2] - before.centre[2]];
      const w = before.angular;
      const watchVelocity: Vec3 = [
        before.linear[0] + w[1] * r[2] - w[2] * r[1],
        before.linear[1] + w[2] * r[0] - w[0] * r[2],
        before.linear[2] + w[0] * r[1] - w[1] * r[0],
      ];
      const otherVelocity: Vec3 = otherBefore ? otherBefore.linear : [0, 0, 0];
      const relativeVelocity: Vec3 = [otherVelocity[0] - watchVelocity[0], otherVelocity[1] - watchVelocity[1], otherVelocity[2] - watchVelocity[2]];
      const normalSpeed = Math.abs(relativeVelocity[0] * normal[0] + relativeVelocity[1] * normal[1] + relativeVelocity[2] * normal[2]);
      const mass = watch.body.mass();
      const otherMass = otherBefore ? otherBody.mass() : Infinity;
      const effectiveMass = Number.isFinite(otherMass) ? (mass * otherMass) / (mass + otherMass) : mass;
      const energy = effectiveMass * normalSpeed * normalSpeed;
      if (!hardest || energy > hardest.effectiveMass * hardest.normalSpeed * hardest.normalSpeed) {
        hardest = { other: ballIndex >= 0 ? 'ball' : 'static', ballIndex, point, normal, relativeVelocity, normalSpeed, effectiveMass };
      }
    });

    this.limitSpeeds();
    return hardest;
  }

  /** Lowest world-space point among a piece's hull points; a stand-in when no manifold exists. */
  private lowestPoint(piece: Piece): Vec3 {
    let best: Vec3 = toVec(piece.body.translation());
    const rotation = toQuat(piece.body.rotation());
    const origin = toVec(piece.body.translation());
    for (const hull of piece.geometry.hulls) {
      for (let i = 0; i < hull.length; i += 3) {
        const p = add3(origin, quatRotate(rotation, [hull[i], hull[i + 1], hull[i + 2]]));
        if (p[1] < best[1]) best = p;
      }
    }
    return best;
  }

  private limitSpeeds(): void {
    for (const body of this.bodies()) {
      if (body.isSleeping()) continue;
      const linear = toVec(body.linvel()), angular = toVec(body.angvel());
      if (!Number.isFinite(linear[0] + linear[1] + linear[2] + angular[0] + angular[1] + angular[2])) {
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        continue;
      }
      if (len3(linear) > SIM.maxLinearSpeed) body.setLinvel(fromVec(clampLength3(linear, SIM.maxLinearSpeed)), true);
      if (len3(angular) > SIM.maxAngularSpeed) body.setAngvel(fromVec(clampLength3(angular, SIM.maxAngularSpeed)), true);
    }
  }

  /** Nearest dynamic body along a ray, as seen by the colliders. `shard` is -1 for a striker. */
  castRay(origin: Vec3, direction: Vec3, maxDistance = 60): { tag: BodyTag; body: Body; shard: number; point: Vec3; distance: number } | null {
    const ray = new RAPIER.Ray(fromVec(origin), fromVec(direction));
    const hit = this.world.castRay(ray, maxDistance, true, RAPIER.QueryFilterFlags.EXCLUDE_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
    if (!hit) return null;
    const body = hit.collider.parent();
    const tag = body?.userData as BodyTag | undefined;
    if (!body || !tag) return null;
    const t = hit.timeOfImpact;
    const point: Vec3 = [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t];
    return { tag, body, shard: this.shardOf(hit.collider), point, distance: t };
  }

  /** Distance along a ray to the first visible thing: a piece, a striker, the plinth or the wall. */
  castRayAny(origin: Vec3, direction: Vec3, maxDistance = 60): number {
    const hit = this.world.castRay(
      new RAPIER.Ray(fromVec(origin), fromVec(direction)), maxDistance, true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC, undefined, undefined, this.boundsBody,
    );
    return hit ? hit.timeOfImpact : Infinity;
  }

  /**
   * Bonds two shards by welding their bodies into one compound body, each shard in its original
   * place relative to the other. This is the perfectly stiff equivalent of a fixed joint: chains
   * of impulse joints between pieces a few grams to a few kilograms apart sag under real
   * gravity, a compound body cannot. The lighter group is carried over onto the heavier one.
   * Returns the body that ceased to exist, if any.
   */
  weld(a: number, b: number): Body | null {
    const pa = this.pieces.get(a), pb = this.pieces.get(b);
    if (!pa || !pb || pa.body.handle === pb.body.handle) return null;
    // Weigh the two groups by their shards: a body that is being held still reports no mass.
    const weigh = (body: Body): number => {
      let mass = 0;
      for (const piece of this.pieces.values()) if (piece.body.handle === body.handle) mass += piece.geometry.mass;
      return mass;
    };
    const [keep, absorb] = weigh(pa.body) >= weigh(pb.body) ? [pa, pb] : [pb, pa];
    const held = absorb.body.isFixed();
    const body = keep.body, gone = absorb.body;
    const rootCentre = this.pieces.get(keep.root)!.geometry.centroid;
    for (const piece of this.pieces.values()) {
      if (piece.body.handle !== gone.handle) continue;
      for (const collider of piece.colliders) this.colliderShard.delete(collider.handle);
      const c = piece.geometry.centroid;
      piece.offset = [c[0] - rootCentre[0], c[1] - rootCentre[1], c[2] - rootCentre[2]];
      piece.root = keep.root;
      piece.body = body;
      const { colliders } = attachShardColliders(this.world, body, piece.geometry, piece.offset, false);
      piece.colliders = colliders;
      for (const collider of colliders) this.colliderShard.set(collider.handle, piece.id);
    }
    this.world.removeRigidBody(gone);
    // If the group that was being held still is the one absorbed, the hold passes to the whole.
    if (held) body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    body.wakeUp();
    return gone;
  }

  /**
   * Holds the body of a shard still, as a second hand would steady the bowl while a piece is
   * fitted to it. Returns the body, or null when it is moving, or is the one being carried.
   */
  steady(shard: number, carried: number): Body | null {
    const anchor = this.pieces.get(shard), other = this.pieces.get(carried);
    if (!anchor || !other || anchor.body.handle === other.body.handle || !anchor.body.isDynamic()) return null;
    const v = anchor.body.linvel(), w = anchor.body.angvel();
    if (Math.hypot(v.x, v.y, v.z) > 0.6 || Math.hypot(w.x, w.y, w.z) > 1.2) return null;
    anchor.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    return anchor.body;
  }

  /** Lets go of whatever `steady` is holding: the body of the given shard becomes free again. */
  unsteady(shard: number): void {
    const piece = this.pieces.get(shard);
    if (piece && piece.body.isValid() && piece.body.isFixed()) piece.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  }

  /**
   * Steadies two nearly mated pieces with soft springs between matching points (given in bowl
   * coordinates). The springs are ordinary solver constraints, so a whole reassembled bowl of
   * tacked pieces stays stable; they are removed again by `untack`.
   */
  tack(edge: number, a: number, b: number, anchors: readonly Vec3[], stiffness: number, damping: number): void {
    const pa = this.pieces.get(a), pb = this.pieces.get(b);
    if (!pa || !pb || pa.body.handle === pb.body.handle || this.tacks.has(edge)) return;
    const ca = this.pieces.get(pa.root)!.geometry.centroid, cb = this.pieces.get(pb.root)!.geometry.centroid;
    const joints = anchors.map((p) =>
      this.world.createImpulseJoint(
        RAPIER.JointData.spring(
          0, stiffness, damping,
          { x: p[0] - ca[0], y: p[1] - ca[1], z: p[2] - ca[2] },
          { x: p[0] - cb[0], y: p[1] - cb[1], z: p[2] - cb[2] },
        ),
        pa.body, pb.body, true,
      ));
    // Held together by the springs, the two pieces need not also push on each other; letting
    // contacts and springs argue only makes them chatter.
    for (const joint of joints) joint.setContactsEnabled(false);
    this.tacks.set(edge, { joints, bodies: [pa.body, pb.body] });
    // A piece that is being steadied should come to rest, not ring on its springs.
    for (const body of [pa.body, pb.body]) {
      const holds = this.tackHolds.get(body.handle) ?? 0;
      if (holds === 0) { body.setLinearDamping(1.6); body.setAngularDamping(5); }
      this.tackHolds.set(body.handle, holds + 1);
    }
  }

  untack(edge: number): void {
    const tack = this.tacks.get(edge);
    if (!tack) return;
    // A joint whose body was welded away has already gone with it.
    for (const joint of tack.joints) if (joint.isValid()) this.world.removeImpulseJoint(joint, true);
    for (const body of tack.bodies) {
      const holds = (this.tackHolds.get(body.handle) ?? 1) - 1;
      if (holds > 0) { this.tackHolds.set(body.handle, holds); continue; }
      this.tackHolds.delete(body.handle);
      if (body.isValid()) { body.setLinearDamping(SHARD_DAMPING.linear); body.setAngularDamping(SHARD_DAMPING.angular); }
    }
    this.tacks.delete(edge);
  }

  get tackCount(): number {
    return this.tacks.size;
  }

  /**
   * Pairs of separate pieces whose collision shapes are pressed into each other by more than
   * `deeper` world units, deepest first. `normal` points from piece `a` towards piece `b`.
   */
  overlaps(deeper: number): Overlap[] {
    const found = new Map<string, Overlap>();
    for (const piece of this.pieces.values()) {
      for (const collider of piece.colliders) {
        this.world.contactPairsWith(collider, (other) => {
          if (other.handle <= collider.handle) return;
          const shard = this.colliderShard.get(other.handle);
          const mate = shard === undefined ? undefined : this.pieces.get(shard);
          if (!mate || mate.body.handle === piece.body.handle) return;
          this.world.contactPair(collider, other, (manifold, flipped) => {
            let depth = 0;
            for (let i = 0; i < manifold.numContacts(); i++) depth = Math.max(depth, -manifold.contactDist(i));
            if (depth <= deeper) return;
            const key = `${Math.min(piece.body.handle, mate.body.handle)}:${Math.max(piece.body.handle, mate.body.handle)}`;
            const known = found.get(key);
            if (known && known.depth >= depth) return;
            const n = toVec(manifold.normal());
            const sign = flipped ? -1 : 1;
            found.set(key, { a: piece.id, b: mate.id, depth, normal: [n[0] * sign, n[1] * sign, n[2] * sign] });
          });
        });
      }
    }
    return [...found.values()].sort((p, q) => q.depth - p.depth);
  }

  /**
   * Eases apart pieces that have come to rest pressed further into one another than `deeper`.
   * The lighter of each pair is moved out along the contact by the excess and no further than
   * `most`; the piece `keep` (what is left standing) is never the one moved. This is for a
   * fracture that has settled with a piece wedged, and is used once: it does not arrange anything.
   * Returns how many pieces were moved.
   */
  easeApart(deeper: number, most: number, keep: number): number {
    const anchor = this.pieces.get(keep)?.body.handle;
    const moved = new Set<number>();
    for (const { a, b, depth, normal } of this.overlaps(deeper)) {
      const pa = this.pieces.get(a), pb = this.pieces.get(b);
      if (!pa || !pb) continue;
      let mover = pa.body.mass() <= pb.body.mass() ? pa : pb;
      if (mover.body.handle === anchor) mover = mover === pa ? pb : pa;
      if (!mover.body.isDynamic() || moved.has(mover.body.handle) || this.tackHolds.has(mover.body.handle)) continue;
      // The normal points from a to b: b leaves along it, a against it.
      const shift = Math.min(most, depth - CONTACT_SLACK.settled) * (mover === pb ? 1 : -1);
      const t = mover.body.translation();
      mover.body.setTranslation({ x: t.x + normal[0] * shift, y: t.y + normal[1] * shift, z: t.z + normal[2] * shift }, true);
      (mover === pa ? pb : pa).body.wakeUp();
      moved.add(mover.body.handle);
    }
    return moved.size;
  }

  counts(): { active: number; sleeping: number } {
    let active = 0, sleeping = 0;
    for (const body of this.bodies()) {
      if (body.isSleeping()) sleeping++;
      else active++;
    }
    return { active, sleeping };
  }
}

export { RAPIER };
