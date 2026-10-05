import { clamp } from '../config';
import { mat4LookAt, mat4Multiply, mat4Perspective, mat4TransformPoint, type Mat4 } from '../math/mat';
import { add3, cross3, dot3, norm3, scale3, sub3, type Vec3 } from '../math/vec';

/** Where on screen the subject should sit and how much room it has, as given by the page layout. */
export interface Framing {
  /** Screen position of the orbit target, as fractions of the viewport. */
  centreX: number;
  centreY: number;
  /** Free space around that point, in CSS pixels. */
  halfWidth: number;
  halfHeight: number;
  /** How much of the usual margin round the subject to keep (1 by default; less on a narrow screen). */
  margin?: number;
}

export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

export const CAMERA_DEFAULTS = {
  /** A little to the left of the wall's normal, so the table's front edge runs across the frame at a slant. */
  azimuth: 0.46,
  elevation: 0.2,
  distance: 9.4,
  target: [0, 0.74, 0] as Vec3,
  fovY: (27 * Math.PI) / 180,
  minDistance: 4.6,
  maxDistance: 16,
} as const;

/** Half-extents of what must stay in frame at the default zoom: the bowl with room to breathe. */
const SUBJECT_HALF_WIDTH = 2.55;
const SUBJECT_HALF_HEIGHT = 1.55;

/**
 * Perspective orbit camera. The projection is shifted off-axis so the orbit target can sit away
 * from the centre of the canvas (clear of the masthead and the control panel) without tilting
 * verticals.
 */
export class Camera {
  azimuth: number = CAMERA_DEFAULTS.azimuth;
  elevation: number = CAMERA_DEFAULTS.elevation;
  distance: number = CAMERA_DEFAULTS.distance;
  target: Vec3 = [...CAMERA_DEFAULTS.target];
  readonly fovY = CAMERA_DEFAULTS.fovY;

  width = 1;
  height = 1;
  /** Extra pull-back so the subject fits the free part of the viewport. */
  fit = 1;
  shiftX = 0;
  shiftY = 0;
  /** Small additive offset from impact shake, in world units. */
  shake: Vec3 = [0, 0, 0];

  eye: Vec3 = [0, 2, 8];
  forward: Vec3 = [0, 0, -1];
  right: Vec3 = [1, 0, 0];
  up: Vec3 = [0, 1, 0];
  view: Mat4 = new Float32Array(16);
  projection: Mat4 = new Float32Array(16);
  viewProjection: Mat4 = new Float32Array(16);

  setViewport(width: number, height: number, framing: Framing): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.shiftX = framing.centreX * 2 - 1;
    this.shiftY = 1 - framing.centreY * 2;
    // Pixels per world unit at the target is (height / 2) / (tan(fov / 2) · distance).
    const tan = Math.tan(this.fovY / 2);
    const margin = framing.margin ?? 1;
    const forWidth = (SUBJECT_HALF_WIDTH * margin * this.height * 0.5) / (tan * Math.max(40, framing.halfWidth));
    const forHeight = (SUBJECT_HALF_HEIGHT * margin * this.height * 0.5) / (tan * Math.max(40, framing.halfHeight));
    this.fit = Math.max(1, Math.max(forWidth, forHeight) / CAMERA_DEFAULTS.distance);
  }

  update(): void {
    const d = this.distance * this.fit;
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const target = add3(this.target, this.shake);
    this.eye = add3(target, [Math.sin(this.azimuth) * ce * d, se * d, Math.cos(this.azimuth) * ce * d]);
    this.forward = norm3(sub3(target, this.eye));
    this.right = norm3(cross3(this.forward, [0, 1, 0]), [1, 0, 0]);
    this.up = cross3(this.right, this.forward);
    this.view = mat4LookAt(this.eye, target);
    this.projection = mat4Perspective(this.fovY, this.width / this.height, 0.1, 80);
    // Off-axis shift: adds shift · w to clip-space x and y.
    this.projection[8] = -this.shiftX;
    this.projection[9] = -this.shiftY;
    mat4Multiply(this.projection, this.view, this.viewProjection);
  }

  /** Ray through a point given in CSS pixels relative to the canvas. */
  ray(x: number, y: number): Ray {
    const nx = (x / this.width) * 2 - 1, ny = 1 - (y / this.height) * 2;
    const tan = Math.tan(this.fovY / 2);
    const sx = (nx - this.shiftX) * tan * (this.width / this.height);
    const sy = (ny - this.shiftY) * tan;
    const direction = norm3(add3(this.forward, add3(scale3(this.right, sx), scale3(this.up, sy))));
    return { origin: [...this.eye], direction };
  }

  /** Screen position in CSS pixels and clip depth; null when the point is behind the camera. */
  project(p: Vec3): [number, number, number] | null {
    const c = mat4TransformPoint(this.viewProjection, p);
    if (c[3] <= 1e-5) return null;
    return [(c[0] / c[3] * 0.5 + 0.5) * this.width, (0.5 - c[1] / c[3] * 0.5) * this.height, c[2] / c[3]];
  }

  /** Where the ray through a screen point meets the plane through `point` facing the camera. */
  onViewPlane(x: number, y: number, point: Vec3): Vec3 {
    const ray = this.ray(x, y);
    const t = dot3(sub3(point, ray.origin), this.forward) / dot3(ray.direction, this.forward);
    return add3(ray.origin, scale3(ray.direction, t));
  }

  /** World units covered by one CSS pixel at a given point. */
  unitsPerPixel(point: Vec3): number {
    const depth = Math.max(0.1, dot3(sub3(point, this.eye), this.forward));
    return (2 * Math.tan(this.fovY / 2) * depth) / this.height;
  }

  zoomBy(factor: number): void {
    this.distance = clamp(this.distance * factor, CAMERA_DEFAULTS.minDistance, CAMERA_DEFAULTS.maxDistance);
  }
}
