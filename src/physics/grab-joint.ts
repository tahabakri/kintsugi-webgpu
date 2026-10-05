import RAPIER from '@dimforge/rapier3d-compat';
import { SIM } from '../config';
import { quatErrorVector, quatFromAxisAngle, quatMul, quatNormalize, quatSlerp, type Quat } from '../math/quat';
import { add3, clampLength3, len3, scale3, sub3, type Vec3 } from '../math/vec';
import { SHARD_DAMPING } from './shard-body';
import { fromVec, toQuat, toVec, type Body, type BodyTag } from './world';

/** How firmly a held piece keeps its orientation: natural frequency (rad/s) of the hold. */
const HOLD_FREQUENCY = 46;
/** Natural frequency (rad/s) of the spring that carries a held piece after the pointer. */
const CARRY_FREQUENCY = 62;
/** How far a piece hangs below where it is asked to be, on that spring under gravity. */
export const CARRY_SAG = SIM.gravity / (CARRY_FREQUENCY * CARRY_FREQUENCY);

/**
 * Holding a body with the pointer: a kinematic target follows the cursor and a spring joint drags
 * the body's picked point after it. Like a hand, the hold also resists the piece swinging round:
 * a soft torque keeps it near the orientation it was picked up in (or one it is being turned
 * to). Releasing hands the body the pointer's recent velocity.
 */
export class Grab {
  readonly body: Body;
  /** Orientation the hold is steadying the body towards. */
  orientation: Quat;
  /** Where the pointer wants the picked point to be. */
  point: Vec3;

  private readonly target: Body;
  /** From the picked point to the body's centre of mass at the moment it was picked up. */
  private readonly offset: Vec3;
  private readonly joint: RAPIER.ImpulseJoint;
  private readonly history: Array<{ time: number; point: Vec3 }> = [];

  constructor(private readonly world: RAPIER.World, body: Body, worldPoint: Vec3, time: number) {
    this.body = body;
    this.point = [...worldPoint];
    this.orientation = toQuat(body.rotation());
    // The spring acts on the centre of mass, carried by the same displacement as the cursor. A
    // piece then lifts straight instead of hanging from the picked point like a pendulum.
    const centre = toVec(body.worldCom());
    this.offset = sub3(centre, worldPoint);
    const local = toVec(body.localCom());
    this.target = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(centre[0], centre[1], centre[2])
        .setUserData({ kind: 'grab' } satisfies BodyTag),
    );
    // Stiff enough that the piece hangs within a few millimetres of the cursor under real
    // gravity, and close to critically damped so it does not bounce on the spring.
    const mass = Math.max(0.005, body.mass());
    const frequency = CARRY_FREQUENCY;
    this.joint = world.createImpulseJoint(
      RAPIER.JointData.spring(0, mass * frequency * frequency, 2 * 0.85 * mass * frequency, { x: 0, y: 0, z: 0 }, fromVec(local)),
      this.target, body, true,
    );
    body.setAngularDamping(1.5);
    body.wakeUp();
    this.history.push({ time, point: [...worldPoint] });
  }

  /** Where the body's centre of mass is asked to be when the pointer holds the picked point at `worldPoint`. */
  centreFor(worldPoint: Vec3): Vec3 {
    return add3(worldPoint, this.offset);
  }

  /**
   * Follows the pointer. `centre` overrides where the centre of mass is drawn to, for a piece
   * that is being eased somewhere other than exactly under the pointer.
   */
  moveTo(worldPoint: Vec3, time: number, centre: Vec3 = this.centreFor(worldPoint)): void {
    this.point = [...worldPoint];
    this.target.setNextKinematicTranslation(fromVec(centre));
    this.body.wakeUp();
    this.history.push({ time, point: [...worldPoint] });
    while (this.history.length > 2 && time - this.history[0].time > 0.12) this.history.shift();
  }

  /** Pointer velocity over the last ~0.1 s, the basis for a throw. */
  velocity(time: number): Vec3 {
    const first = this.history[0], last = this.history[this.history.length - 1];
    // Holding still before letting go means "put it down", not "throw it".
    if (!first || !last || last === first || time - last.time > 0.08) return [0, 0, 0];
    const span = Math.max(1 / 240, last.time - first.time);
    return clampLength3(scale3(sub3(last.point, first.point), 1 / span), SIM.maxThrowSpeed);
  }

  /** Turns the orientation being held about a world axis. */
  turn(axis: Vec3, angle: number): void {
    this.orientation = quatNormalize(quatMul(quatFromAxisAngle(axis, angle), this.orientation));
  }

  /** Moves the held orientation a fraction of the way towards another one. */
  lean(rotation: Quat, fraction: number): void {
    this.orientation = quatSlerp(this.orientation, rotation, Math.min(1, Math.max(0, fraction)));
  }

  /**
   * One step of the orientation hold: a critically damped torsion spring, integrated implicitly so
   * it is stable for any body, applied through the body's actual inertia.
   */
  steady(dt: number): void {
    const body = this.body;
    const error = quatErrorVector(this.orientation, toQuat(body.rotation())); // how far the body has turned past the hold
    const spin = toVec(body.angvel());
    const w = HOLD_FREQUENCY;
    const k = 1 / (1 + 2 * w * dt + w * w * dt * dt);
    const change: Vec3 = [
      -dt * (w * w * error[0] + (2 * w + w * w * dt) * spin[0]) * k,
      -dt * (w * w * error[1] + (2 * w + w * w * dt) * spin[1]) * k,
      -dt * (w * w * error[2] + (2 * w + w * w * dt) * spin[2]) * k,
    ];
    // Torque impulse for that change in angular velocity: world-space inertia times Δω.
    const i = body.effectiveAngularInertia();
    body.applyTorqueImpulse({
      x: i.m11 * change[0] + i.m12 * change[1] + i.m13 * change[2],
      y: i.m12 * change[0] + i.m22 * change[1] + i.m23 * change[2],
      z: i.m13 * change[0] + i.m23 * change[1] + i.m33 * change[2],
    }, true);
  }

  /** For when the held body has ceased to exist (it was welded into another): drop the target only. */
  abandon(): void {
    this.world.removeRigidBody(this.target);
  }

  release(time: number, throwIt = true): void {
    const velocity = this.velocity(time);
    this.world.removeImpulseJoint(this.joint, true);
    this.world.removeRigidBody(this.target);
    if (!this.body.isValid()) return;
    this.body.setAngularDamping(SHARD_DAMPING.angular);
    if (throwIt && len3(velocity) > 0.5) {
      // Blend rather than replace: the body already follows the hand through the spring.
      const current = toVec(this.body.linvel());
      this.body.setLinvel(fromVec(clampLength3(add3(scale3(current, 0.35), scale3(velocity, 0.65)), SIM.maxThrowSpeed)), true);
    }
  }
}
