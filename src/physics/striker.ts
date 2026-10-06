import RAPIER from '@dimforge/rapier3d-compat';
import { MATERIAL_PHYSICS, SIM } from '../config';
import type { Quat } from '../math/quat';
import { len3, sub3, type Vec3 } from '../math/vec';
import { toQuat, toVec, type Body, type BodyTag } from './world';

/** How many balls may be on the table at once; the oldest goes when another is thrown. */
const MAX_BALLS = 8;
/** A ball that has lain still this long (seconds) is let go of. */
const IDLE_SECONDS = 45;
const IDLE_SPEED = 0.15;
const SHRINK_TIME = 0.35;

interface Ball {
  body: Body;
  age: number;
  /** Seconds since the ball started to shrink away, or -1 while it is still in play. */
  leaving: number;
  /** Seconds it has lain more or less still. */
  idle: number;
}

/**
 * Steel balls thrown at the bowl. A ball is an ordinary dynamic body: it flies a ballistic arc
 * under real gravity and the fracture is decided by its actual collision, not by the click.
 */
export class Strikers {
  private balls: Ball[] = [];
  private nextIndex = 0;

  constructor(private world: RAPIER.World) {}

  /** Points the strikers at a new world after a reset. */
  rebind(world: RAPIER.World): void {
    this.world = world;
    this.balls = [];
  }

  get bodies(): Body[] {
    return this.balls.map((ball) => ball.body);
  }

  /** Balls in play: not counting one that is already shrinking away. */
  get count(): number {
    return this.balls.filter((ball) => ball.leaving < 0).length;
  }

  /**
   * Launches a ball from `from` so that it arrives at `target` travelling at roughly `speed`.
   * The launch velocity is the ballistic solution, so gravity bends the path honestly.
   */
  launch(from: Vec3, target: Vec3, speed: number): void {
    if (this.balls.length >= MAX_BALLS) this.remove(this.balls[0]);
    const offset = sub3(target, from);
    const distance = Math.max(0.2, len3(offset));
    const flight = distance / Math.max(1, speed);
    const velocity: Vec3 = [offset[0] / flight, offset[1] / flight + 0.5 * SIM.gravity * flight, offset[2] / flight];
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(from[0], from[1], from[2])
        .setLinvel(velocity[0], velocity[1], velocity[2])
        .setAngularDamping(0.4)
        .setCcdEnabled(true)
        .setUserData({ kind: 'ball', index: this.nextIndex++ } satisfies BodyTag),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(MATERIAL_PHYSICS.strikerRadius)
        .setDensity(MATERIAL_PHYSICS.steelDensity)
        .setRestitution(MATERIAL_PHYSICS.steelRestitution)
        .setFriction(MATERIAL_PHYSICS.steelFriction)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    this.balls.push({ body, age: 0, leaving: -1, idle: 0 });
  }

  findByTag(index: number): Body | null {
    return this.balls.find((ball) => (ball.body.userData as BodyTag & { index: number }).index === index)?.body ?? null;
  }

  private remove(ball: Ball): void {
    if (ball.body.isValid()) this.world.removeRigidBody(ball.body);
    this.balls = this.balls.filter((other) => other !== ball);
  }

  /**
   * Ages the balls. A ball that has come to rest stays where it lies, among the pieces; one that
   * has rolled off the table or out of the room shrinks away and is removed.
   */
  update(dt: number): void {
    for (const ball of [...this.balls]) {
      ball.age += dt;
      if (ball.leaving < 0) {
        const position = toVec(ball.body.translation());
        const lost = position[1] < -1.5 || Math.hypot(position[0], position[2]) > 8;
        const v = ball.body.linvel();
        ball.idle = Math.hypot(v.x, v.y, v.z) < IDLE_SPEED ? ball.idle + dt : 0;
        if (lost || ball.idle > IDLE_SECONDS) ball.leaving = 0;
      } else {
        ball.leaving += dt;
        if (ball.leaving >= SHRINK_TIME) this.remove(ball);
      }
    }
  }

  /** Transforms for rendering; `scale` runs to zero as a ball leaves. */
  renderState(blend?: (body: Body) => { position: Vec3; rotation: Quat }): Array<{ position: Vec3; rotation: Quat; scale: number }> {
    return this.balls.map((ball) => ({
      position: blend ? blend(ball.body).position : toVec(ball.body.translation()),
      rotation: blend ? blend(ball.body).rotation : toQuat(ball.body.rotation()),
      scale: ball.leaving < 0 ? 1 : Math.max(0, 1 - ball.leaving / SHRINK_TIME),
    }));
  }
}
