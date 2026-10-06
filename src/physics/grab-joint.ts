import { SIM } from '../config';
import { quatConj, quatErrorVector, quatFromAxisAngle, quatMul, quatNormalize, quatRotate, quatSlerp, type Quat } from '../math/quat';
import { add3, clampLength3, cross3, dot3, len3, scale3, sub3, type Vec3 } from '../math/vec';
import { invert3, pointResponse, releaseVelocity, servoImpulse, smoothDamp, RELEASE_WINDOW, type HandSample, type Mat3 } from './hand';
import { SHARD_DAMPING } from './shard-body';
import { fromVec, toQuat, toVec, type Body } from './world';

/** Natural frequency (rad/s) of the critically damped target the pointer drives. */
const HAND_FREQUENCY = 2 * Math.PI * 24;
/** Natural frequency (rad/s) and damping ratio of the servo that pulls the picked point to the hand. */
const SERVO_FREQUENCY = 2 * Math.PI * 18;
const SERVO_DAMPING = 1;
/** The hand can pull with at most this many times the piece's weight, so a heavy piece lags and swings. */
const GRIP_STRENGTH = 14;

/**
 * How firmly a held piece keeps its orientation: natural frequency (rad/s) of a torsion spring.
 * Loose when handling, so a piece gripped by its rim hangs a little tilted; firm when fitting.
 */
export const HOLD = { handling: 14, fitting: 46 } as const;

/** Angular damping while held, so a piece gripped off-centre swings once and settles. */
const HELD_ANGULAR_DAMPING = 2.4;

/** Fastest a piece may be let go at (world units per second); see `SIM.maxThrowSpeed`. */
export const MAX_THROW_SPEED = SIM.maxThrowSpeed;

/** What a release measured, for the debug hook. */
export interface ReleaseRecord {
  /** Hand velocity fitted to the last ~130 ms of its path. */
  estimated: Vec3;
  /** Velocity of the picked point just before and just after the release. */
  before: Vec3;
  after: Vec3;
  /** Body velocity just before and just after. */
  bodyBefore: Vec3;
  bodyAfter: Vec3;
  thrown: boolean;
}

/**
 * A hand holding a piece by the point that was clicked. The pointer only sets a target; every
 * fixed step the target is smoothed (critically damped), and a servo pulls the picked point to it
 * with an impulse applied at that point, so a grip on the rim lifts, tilts and swings the piece
 * differently from one near the middle. The piece is never moved directly. Gravity is carried by
 * the hand, up to a limit, and a soft torsion spring stops it swinging wildly. At release the
 * piece keeps the velocity it has, corrected by how far the servo was lagging the hand.
 */
export class Grab {
  readonly body: Body;
  /** Orientation the hold is steadying the body towards. */
  orientation: Quat;
  /** The smoothed hand: where the picked point is being drawn to. */
  readonly hand: Vec3;
  readonly handVelocity: Vec3 = [0, 0, 0];
  holdFrequency: number = HOLD.handling;

  /** What the last release measured. */
  static last: ReleaseRecord | null = null;

  private readonly pick: Vec3;
  private target: Vec3;
  private readonly samples: HandSample[] = [];
  private time = 0;

  constructor(body: Body, worldPoint: Vec3, time: number) {
    this.body = body;
    this.orientation = toQuat(body.rotation());
    const centre = toVec(body.worldCom());
    // The picked point in the body's frame, from its centre of mass, and in the world as a constant offset.
    this.pick = quatRotate(quatConj(this.orientation), sub3(worldPoint, centre));
    this.hand = [...worldPoint];
    this.target = [...worldPoint];
    this.time = time;
    this.samples.push({ time, position: [...worldPoint] });
    body.setAngularDamping(HELD_ANGULAR_DAMPING);
    body.wakeUp();
  }

  /**
   * Where the body's centre of mass is when the picked point is at `worldPoint`, given how the
   * body is turned now: a piece gripped away from its centre swings round the grip, so the
   * offset between the two is not the one it had when it was picked up.
   */
  centreFor(worldPoint: Vec3): Vec3 {
    return sub3(worldPoint, quatRotate(toQuat(this.body.rotation()), this.pick));
  }

  /**
   * The pointer's position, projected into the world. `fit` draws the picked point instead towards
   * where it would be with the centre of mass at `fit.centre` and the piece turned as it is being
   * held, by `fit.pull` (0…1): used when a piece is being drawn into its place.
   */
  setTarget(point: Vec3, fit?: { centre: Vec3; pull: number }): void {
    if (!fit || fit.pull <= 0) { this.target = [...point]; return; }
    const there = add3(fit.centre, quatRotate(this.orientation, this.pick));
    this.target = [
      point[0] + (there[0] - point[0]) * fit.pull,
      point[1] + (there[1] - point[1]) * fit.pull,
      point[2] + (there[2] - point[2]) * fit.pull,
    ];
  }

  /** Where the picked point is now, its lever arm from the centre of mass, and how fast it moves. */
  private pickedPoint(): { world: Vec3; arm: Vec3; velocity: Vec3 } {
    const body = this.body;
    const arm = quatRotate(toQuat(body.rotation()), this.pick);
    const world = add3(toVec(body.worldCom()), arm);
    const velocity = add3(toVec(body.linvel()), cross3(toVec(body.angvel()), arm));
    return { world, arm, velocity };
  }

  /** The held point and its velocity: for the debug hook. */
  get grip(): { world: Vec3; velocity: Vec3 } {
    const { world, velocity } = this.pickedPoint();
    return { world, velocity };
  }

  /** Velocity the hand would give the piece if it were let go now. */
  estimatedVelocity(): Vec3 {
    return releaseVelocity(this.samples, this.time);
  }

  /** Turns the orientation being held about a world axis. */
  turn(axis: Vec3, angle: number): void {
    this.orientation = quatNormalize(quatMul(quatFromAxisAngle(axis, angle), this.orientation));
  }

  /** Moves the held orientation a fraction of the way towards another one. */
  lean(rotation: Quat, fraction: number): void {
    this.orientation = quatSlerp(this.orientation, rotation, Math.min(1, Math.max(0, fraction)));
  }

  /** One fixed step: smooth the hand, then pull the piece's picked point after it. */
  step(dt: number, time: number): void {
    const body = this.body;
    if (!body.isValid()) return;
    this.time = time;
    smoothDamp(this.hand, this.handVelocity, this.target, HAND_FREQUENCY, dt);
    this.samples.push({ time, position: [...this.hand] });
    while (this.samples.length > 2 && time - this.samples[0].time > RELEASE_WINDOW * 1.5) this.samples.shift();

    const mass = body.mass();
    if (!(mass > 1e-6)) return;
    const { world, arm, velocity } = this.pickedPoint();
    const inertia = body.effectiveAngularInertia();
    const inverseInertia = invert3([inertia.m11, inertia.m12, inertia.m13, inertia.m12, inertia.m22, inertia.m23, inertia.m13, inertia.m23, inertia.m33] as Mat3);
    if (!inverseInertia) return;

    // Impulse at the picked point that makes it follow the hand like a critically damped spring,
    // however heavy the piece is; limited to what a hand can do, and carrying the piece's weight.
    const response = pointResponse(mass, inverseInertia, arm);
    let impulse = servoImpulse(sub3(world, this.hand), sub3(velocity, this.handVelocity), response, SERVO_FREQUENCY, SERVO_DAMPING, dt);
    impulse = clampLength3(impulse, mass * SIM.gravity * GRIP_STRENGTH * dt);
    impulse = add3(impulse, [0, mass * SIM.gravity * dt, 0]);
    body.applyImpulseAtPoint(fromVec(impulse), fromVec(world), true);

    this.steady(dt);
  }

  /**
   * One step of the orientation hold: a critically damped torsion spring, integrated implicitly so
   * it is stable for any body, applied through the body's actual inertia.
   */
  private steady(dt: number): void {
    const body = this.body;
    const error = quatErrorVector(this.orientation, toQuat(body.rotation()));
    const spin = toVec(body.angvel());
    const w = this.holdFrequency;
    const k = 1 / (1 + 2 * w * dt + w * w * dt * dt);
    const change: Vec3 = [
      -dt * (w * w * error[0] + (2 * w + w * w * dt) * spin[0]) * k,
      -dt * (w * w * error[1] + (2 * w + w * w * dt) * spin[1]) * k,
      -dt * (w * w * error[2] + (2 * w + w * w * dt) * spin[2]) * k,
    ];
    const i = body.effectiveAngularInertia();
    body.applyTorqueImpulse({
      x: i.m11 * change[0] + i.m12 * change[1] + i.m13 * change[2],
      y: i.m12 * change[0] + i.m22 * change[1] + i.m23 * change[2],
      z: i.m13 * change[0] + i.m23 * change[1] + i.m33 * change[2],
    }, true);
  }

  /** For when the held body has ceased to exist (it was welded into another): nothing to undo. */
  abandon(): void {
    // The hand holds no joint and no helper body, so there is nothing left to remove.
  }

  /**
   * Lets go. A piece carries on with the velocity it has, so the frame after the release looks
   * like the one before. The one correction: if the held point was moving more slowly along the
   * hand's direction than the hand itself (the servo was still catching up), it is given the
   * shortfall, at most a quarter of the hand's speed. It is never slowed, and a hand that has
   * stopped gives nothing.
   */
  release(time: number, throwIt = true): void {
    const body = this.body;
    if (!body.isValid()) return;
    this.time = time;
    body.setAngularDamping(SHARD_DAMPING.angular);
    const estimated = throwIt ? releaseVelocity(this.samples, time) : ([0, 0, 0] as Vec3);
    const gripBefore = this.pickedPoint().velocity;
    const bodyBefore = toVec(body.linvel());
    const speed = len3(estimated);
    if (throwIt && speed > 0.5) {
      const along = scale3(estimated, 1 / speed);
      const shortfall = Math.max(0, speed - dot3(gripBefore, along));
      const boost = Math.min(shortfall, 0.25 * speed);
      body.setLinvel(fromVec(clampLength3(add3(bodyBefore, scale3(along, boost)), MAX_THROW_SPEED)), true);
    }
    Grab.last = { estimated, before: gripBefore, after: this.pickedPoint().velocity, bodyBefore, bodyAfter: toVec(body.linvel()), thrown: throwIt };
  }
}
