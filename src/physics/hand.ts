import type { Vec3 } from '../math/vec';

/**
 * Pure maths for the hand that holds a piece: a critically damped target, the release velocity
 * fitted to recent hand samples, and the 3×3 helpers the point servo needs. Nothing here touches
 * the rigid-body world, so it can be tested on its own.
 */

/**
 * Advances `x` (with velocity `v`) one step of a critically damped spring pulling it towards
 * `goal`, in closed form so it is exact for any step. `omega` is the natural frequency in rad/s.
 * Both arrays are updated in place.
 */
export function smoothDamp(x: Vec3, v: Vec3, goal: Vec3, omega: number, dt: number): void {
  const decay = Math.exp(-omega * dt);
  for (let i = 0; i < 3; i++) {
    const error = x[i] - goal[i];
    const carry = v[i] + omega * error;
    x[i] = goal[i] + (error + carry * dt) * decay;
    v[i] = (v[i] - omega * carry * dt) * decay;
  }
}

export interface HandSample {
  time: number;
  position: Vec3;
}

/** How much recent hand motion counts, and how quickly older samples are forgotten (seconds). */
export const RELEASE_WINDOW = 0.13;
export const RELEASE_MEMORY = 0.045;

/** Weighted least-squares velocity of one axis; samples are (t relative to now, position, weight). */
function slope(t: number[], p: number[], w: number[]): number {
  let s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0;
  for (let i = 0; i < t.length; i++) {
    s0 += w[i]; s1 += w[i] * t[i]; s2 += w[i] * t[i] * t[i];
    t0 += w[i] * p[i]; t1 += w[i] * p[i] * t[i];
  }
  const denominator = s0 * s2 - s1 * s1;
  return denominator > 1e-12 ? (s0 * t1 - s1 * t0) / denominator : 0;
}

/**
 * Velocity of the hand at the moment of release, from the last ~130 ms of its path: a line fitted
 * by weighted least squares, recent samples counting most, then refitted without any sample that
 * sits far from the line (an event spike). A hand that has come to rest gives zero; one that is
 * still moving gives its speed, not an average of its whole gesture.
 */
export function releaseVelocity(samples: readonly HandSample[], now: number): Vec3 {
  const recent = samples.filter((s) => now - s.time <= RELEASE_WINDOW);
  if (recent.length < 3) return [0, 0, 0];
  const span = now - recent[0].time;
  if (span < 0.02) return [0, 0, 0];

  const t = recent.map((s) => s.time - now);
  const weight = t.map((x) => Math.exp(x / RELEASE_MEMORY));
  const axis = (i: number, keep: boolean[]): number => {
    const tt: number[] = [], pp: number[] = [], ww: number[] = [];
    recent.forEach((s, k) => { if (keep[k]) { tt.push(t[k]); pp.push(s.position[i]); ww.push(weight[k]); } });
    return slope(tt, pp, ww);
  };

  let keep = recent.map(() => true);
  let v: Vec3 = [axis(0, keep), axis(1, keep), axis(2, keep)];
  // Residuals against the line through the newest sample with the fitted slope.
  const last = recent[recent.length - 1].position;
  const residual = recent.map((s, k) => Math.hypot(
    s.position[0] - (last[0] + v[0] * t[k]), s.position[1] - (last[1] + v[1] * t[k]), s.position[2] - (last[2] + v[2] * t[k]),
  ));
  const sorted = [...residual].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const limit = Math.max(0.03, 4 * median);
  keep = residual.map((r) => r <= limit);
  const kept = keep.filter(Boolean).length;
  if (kept >= 3 && kept < recent.length) v = [axis(0, keep), axis(1, keep), axis(2, keep)];
  return v.every(Number.isFinite) ? v : [0, 0, 0];
}

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Inverse of a 3×3 matrix stored row by row, or null if it is singular. */
export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-18)) return null;
  const r = 1 / det;
  return [
    A * r, -(b * i - c * h) * r, (b * f - c * e) * r,
    B * r, (a * i - c * g) * r, -(a * f - c * d) * r,
    C * r, -(a * h - b * g) * r, (a * e - b * d) * r,
  ];
}

export const mulMat3Vec = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Effective inverse mass of a point at lever arm `r` (from the centre of mass) on a body of mass
 * `m` and world-space inverse inertia `inverseInertia`: how the point's velocity changes per unit
 * impulse applied there. Row-major 3×3.
 */
export function pointResponse(m: number, inverseInertia: Mat3, r: Vec3): Mat3 {
  const columns: Vec3[] = [];
  for (let j = 0; j < 3; j++) {
    const unit: Vec3 = [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0];
    const turn = mulMat3Vec(inverseInertia, cross(r, unit));
    const swing = cross(turn, r);
    columns.push([unit[0] / m + swing[0], unit[1] / m + swing[1], unit[2] / m + swing[2]]);
  }
  return [columns[0][0], columns[1][0], columns[2][0], columns[0][1], columns[1][1], columns[2][1], columns[0][2], columns[1][2], columns[2][2]];
}

/**
 * Impulse that makes a point on a body behave like a critically damped spring to a moving target,
 * whatever the body's mass: implicit in the step, so stable for any frequency. `error` is the
 * point's position minus the target, `rate` its velocity minus the target's, `response` the point's
 * effective inverse mass (see `pointResponse`). The spring's natural frequency is `omega` (rad/s)
 * and its damping ratio `zeta`.
 */
export function servoImpulse(error: Vec3, rate: Vec3, response: Mat3, omega: number, zeta: number, dt: number): Vec3 {
  const s = 1 + 2 * zeta * omega * dt + omega * omega * dt * dt;
  const wanted: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) wanted[i] = -(dt * omega * omega * error[i] + (2 * zeta * omega * dt + omega * omega * dt * dt) * rate[i]) / s;
  const mass = invert3(response);
  return mass ? mulMat3Vec(mass, wanted) : [0, 0, 0];
}
