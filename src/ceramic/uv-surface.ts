import { BOWL } from '../config';
import type { Vec3 } from '../math/vec';
import { BowlProfile, type ProfileSample } from './bowl-profile';

export const OUTER = 0;
export const INNER = 1;
export type SurfaceSide = typeof OUTER | typeof INNER;

/**
 * The bowl as a surface of revolution over material coordinates:
 *   u = angle / 2π (periodic), v = normalised arc length along the outer profile.
 * It owns the tessellation grid (columns at u = i / U, rows at profile.rows[j]) that both the
 * intact bowl and every shard are meshed on, so neighbouring shards share vertices exactly.
 */
export class BowlSurface {
  readonly profile: BowlProfile;
  readonly U = BOWL.uSegments;
  readonly V = BOWL.vSegments;
  readonly rows: Float64Array;

  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly scratch: ProfileSample = { r: 0, y: 0, nr: 0, ny: 0 };
  /** Profile samples (r, y, nr, ny) at every grid row, per side. */
  private readonly rowProfile: Float64Array[];
  private cos = 1;
  private sin = 0;

  constructor(wallThickness: number = BOWL.defaultWall) {
    this.profile = new BowlProfile(wallThickness);
    this.rows = this.profile.rows;
    this.cosTable = new Float64Array(this.U);
    this.sinTable = new Float64Array(this.U);
    for (let i = 0; i < this.U; i++) {
      const angle = (i / this.U) * Math.PI * 2;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }
    this.rowProfile = [new Float64Array((this.V + 1) * 4), new Float64Array((this.V + 1) * 4)];
    for (let j = 0; j <= this.V; j++) {
      for (const side of [OUTER, INNER] as const) {
        const s = side === OUTER ? this.profile.outer(this.rows[j], this.scratch) : this.profile.inner(this.rows[j], this.scratch);
        this.rowProfile[side].set([s.r, s.y, s.nr, s.ny], j * 4);
      }
    }
  }

  get wallThickness(): number {
    return this.profile.wallThickness;
  }

  /** Column index when u lies exactly on a grid column, otherwise -1. */
  columnOf(u: number): number {
    const i = Math.round(u * this.U);
    return i / this.U === u ? i : -1;
  }

  /** Row index when v lies exactly on a grid row, otherwise -1. */
  rowOf(v: number): number {
    const rows = this.rows;
    let lo = 0, hi = rows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid] === v) return mid;
      if (rows[mid] < v) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Index of the row band containing v: rows[j] <= v <= rows[j + 1]. */
  bandOf(v: number): number {
    const rows = this.rows;
    let lo = 0, hi = rows.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rows[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Sets this.cos / this.sin for u. Grid columns come from a table indexed modulo U, so a column
   * reached through an unwrapped chart (u < 0 or u > 1) lands on bit-identical coordinates.
   */
  private setAngle(u: number): void {
    const i = Math.round(u * this.U);
    if (i / this.U === u) {
      const k = ((i % this.U) + this.U) % this.U;
      this.cos = this.cosTable[k];
      this.sin = this.sinTable[k];
      return;
    }
    const a = (u - Math.floor(u)) * Math.PI * 2;
    this.cos = Math.cos(a);
    this.sin = Math.sin(a);
  }

  /** Writes position (xyz) and unit normal (xyz) of a surface point into `out` at `offset`. */
  point(side: SurfaceSide, u: number, v: number, out: Float64Array | Float32Array | number[], offset = 0): void {
    const s = side === OUTER ? this.profile.outer(v, this.scratch) : this.profile.inner(v, this.scratch);
    this.setAngle(u);
    out[offset] = s.r * this.cos;
    out[offset + 1] = s.y;
    out[offset + 2] = s.r * this.sin;
    out[offset + 3] = s.nr * this.cos;
    out[offset + 4] = s.ny;
    out[offset + 5] = s.nr * this.sin;
  }

  /** Same as `point` for a grid corner, using the per-row profile cache. */
  cornerPoint(side: SurfaceSide, column: number, row: number, out: Float64Array | Float32Array | number[], offset = 0): void {
    const p = this.rowProfile[side], at = row * 4;
    const k = ((column % this.U) + this.U) % this.U;
    const c = this.cosTable[k], s = this.sinTable[k];
    out[offset] = p[at] * c;
    out[offset + 1] = p[at + 1];
    out[offset + 2] = p[at] * s;
    out[offset + 3] = p[at + 2] * c;
    out[offset + 4] = p[at + 3];
    out[offset + 5] = p[at + 2] * s;
  }

  position(side: SurfaceSide, u: number, v: number): Vec3 {
    const s = side === OUTER ? this.profile.outer(v, this.scratch) : this.profile.inner(v, this.scratch);
    this.setAngle(u);
    return [s.r * this.cos, s.y, s.r * this.sin];
  }

  normal(side: SurfaceSide, u: number, v: number): Vec3 {
    const s = side === OUTER ? this.profile.outer(v, this.scratch) : this.profile.inner(v, this.scratch);
    this.setAngle(u);
    return [s.nr * this.cos, s.ny, s.nr * this.sin];
  }

  /** Point k of the rounded lip at angle u (k = 0 outer edge … rimSegments inner edge). */
  rimPoint(u: number, k: number, out: Float64Array | Float32Array | number[], offset = 0): void {
    const s = this.profile.rim(k, this.scratch);
    this.setAngle(u);
    out[offset] = s.r * this.cos;
    out[offset + 1] = s.y;
    out[offset + 2] = s.r * this.sin;
    out[offset + 3] = s.nr * this.cos;
    out[offset + 4] = s.ny;
    out[offset + 5] = s.nr * this.sin;
  }

  /** Outer radius at v: the local scale between Δu and real distance around the bowl. */
  radiusAt(v: number): number {
    return this.profile.outer(v, this.scratch).r;
  }

  /** Real distance on the outer surface for a small step in material space, taken at latitude v. */
  metricLength(du: number, dv: number, v: number): number {
    return Math.hypot(du * Math.PI * 2 * this.radiusAt(v), dv * this.profile.length);
  }

  /** Material coordinates of the surface point closest to a position in bowl space. */
  materialOf(p: Vec3): { u: number; v: number; inner: boolean; distance: number } {
    const r = Math.hypot(p[0], p[2]);
    const hit = this.profile.nearest(r, p[1]);
    let u = Math.atan2(p[2], p[0]) / (Math.PI * 2);
    u -= Math.floor(u);
    return { u, v: hit.v, inner: hit.inner, distance: hit.distance };
  }
}

/** Shortest signed difference a − b on the unit circle of u, in (-0.5, 0.5]. */
export function wrapDelta(a: number, b: number): number {
  let d = a - b;
  d -= Math.round(d);
  return d;
}
