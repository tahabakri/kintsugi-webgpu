import type { Quat } from './quat';
import { cross3, dot3, norm3, sub3, type Vec3 } from './vec';

/** Column-major 4×4 matrix, laid out the way WGSL `mat4x4f` expects it. */
export type Mat4 = Float32Array;

export function mat4Multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/** Right-handed perspective with WebGPU's 0..1 clip depth. */
export function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

/** Right-handed orthographic projection with 0..1 clip depth. */
export function mat4Ortho(l: number, r: number, b: number, t: number, near: number, far: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = 1 / (near - far);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = near / (near - far);
  m[15] = 1;
  return m;
}

export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const z = norm3(sub3(eye, target), [0, 0, 1]);
  const x = norm3(cross3(up, z), [1, 0, 0]);
  const y = cross3(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[1] = y[0]; m[2] = z[0];
  m[4] = x[1]; m[5] = y[1]; m[6] = z[1];
  m[8] = x[2]; m[9] = y[2]; m[10] = z[2];
  m[12] = -dot3(x, eye); m[13] = -dot3(y, eye); m[14] = -dot3(z, eye);
  m[15] = 1;
  return m;
}

/** Rigid transform from a rotation and a translation, written into `out` at `offset`. */
export function writeRigid(out: Float32Array, offset: number, q: Quat, t: Vec3): void {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  out[offset] = 1 - 2 * (y * y + z * z);
  out[offset + 1] = 2 * (x * y + z * w);
  out[offset + 2] = 2 * (x * z - y * w);
  out[offset + 3] = 0;
  out[offset + 4] = 2 * (x * y - z * w);
  out[offset + 5] = 1 - 2 * (x * x + z * z);
  out[offset + 6] = 2 * (y * z + x * w);
  out[offset + 7] = 0;
  out[offset + 8] = 2 * (x * z + y * w);
  out[offset + 9] = 2 * (y * z - x * w);
  out[offset + 10] = 1 - 2 * (x * x + y * y);
  out[offset + 11] = 0;
  out[offset + 12] = t[0];
  out[offset + 13] = t[1];
  out[offset + 14] = t[2];
  out[offset + 15] = 1;
}

/** Homogeneous transform of a point; returns clip-space [x, y, z, w]. */
export function mat4TransformPoint(m: Mat4, p: Vec3): [number, number, number, number] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
  ];
}
