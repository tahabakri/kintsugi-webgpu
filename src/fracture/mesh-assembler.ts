import { INNER, OUTER, type BowlSurface, type SurfaceSide } from '../ceramic/uv-surface';
import { symmetricEigenvalues } from '../math/geometry';
import type { Vec3 } from '../math/vec';

/** Interleaved vertex layout shared by every ceramic mesh. */
export const VERTEX_FLOATS = 10; // position 3, normal 3, material uv 2, kind 1, aux 1
export const VERTEX_BYTES = VERTEX_FLOATS * 4;

export const KIND_OUTER = 0;
export const KIND_INNER = 1;
/** Exposed ceramic body on a fracture face. aux = 0 at the outer glaze … 1 at the inner glaze. */
export const KIND_FRACTURE = 2;
/** Glazed lip. aux = 0 at the outer edge … 1 at the inner edge. */
export const KIND_RIM = 3;

export interface MeshData {
  vertices: Float32Array;
  indices: Uint32Array;
}

export interface MassProperties {
  volume: number;
  centroid: Vec3;
  /** Principal moments of inertia about the centroid for unit density. */
  inertia: Vec3;
}

/**
 * Collects the triangles of one shard in bowl space. Glazed-surface vertices are shared through
 * their material coordinates, so a shard's outer and inner skins are properly indexed meshes.
 */
export class MeshAssembler {
  /** Interleaved vertex data and triangle indices; both grow on demand and are trimmed by build(). */
  data = new Float32Array(4096 * VERTEX_FLOATS);
  indices = new Uint32Array(16384);
  vertexCount = 0;
  indexCount = 0;
  /** Area of the outer glazed skin, accumulated while triangles are emitted. */
  outerArea = 0;
  fractureTriangles = 0;

  private readonly corners: Int32Array[];
  private readonly extras: Array<Map<string, number>> = [new Map(), new Map()];
  private readonly rimVertices = new Map<string, number>();
  private readonly poles = [-1, -1];
  private readonly scratch = new Float32Array(6);
  private readonly stride: number;

  constructor(private readonly surface: BowlSurface, private readonly columnStart: number) {
    this.stride = surface.V + 1;
    const size = (surface.U + 1) * this.stride;
    this.corners = [new Int32Array(size).fill(-1), new Int32Array(size).fill(-1)];
  }

  /** Reserves the next vertex slot and returns its float offset into the vertex data. */
  private allocate(): number {
    const offset = this.vertexCount * VERTEX_FLOATS;
    if (offset + VERTEX_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.vertexCount++;
    return offset;
  }

  raw(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number, kind: number, aux: number): number {
    const o = this.allocate(), d = this.data;
    d[o] = px; d[o + 1] = py; d[o + 2] = pz;
    d[o + 3] = nx; d[o + 4] = ny; d[o + 5] = nz;
    d[o + 6] = u; d[o + 7] = v; d[o + 8] = kind; d[o + 9] = aux;
    return o / VERTEX_FLOATS;
  }

  private surfacePoint(side: SurfaceSide, u: number, v: number): number {
    const o = this.allocate(), d = this.data;
    this.surface.point(side, u, v, d, o);
    d[o + 6] = u; d[o + 7] = v; d[o + 8] = side === OUTER ? KIND_OUTER : KIND_INNER; d[o + 9] = 0;
    return o / VERTEX_FLOATS;
  }

  /** Vertex at a grid corner given by chart column and row index. */
  corner(side: SurfaceSide, column: number, row: number): number {
    if (row === 0) return this.pole(side, column / this.surface.U);
    const slot = (column - this.columnStart) * this.stride + row;
    let index = this.corners[side][slot];
    if (index < 0) {
      const o = this.allocate(), d = this.data;
      this.surface.cornerPoint(side, column, row, d, o);
      d[o + 6] = column / this.surface.U; d[o + 7] = this.surface.rows[row];
      d[o + 8] = side === OUTER ? KIND_OUTER : KIND_INNER; d[o + 9] = 0;
      index = o / VERTEX_FLOATS;
      this.corners[side][slot] = index;
    }
    return index;
  }

  /** All of v = 0 is one point on the axis. */
  private pole(side: SurfaceSide, u: number): number {
    if (this.poles[side] < 0) this.poles[side] = this.surfacePoint(side, u, 0);
    return this.poles[side];
  }

  /** Vertex at arbitrary material coordinates (grid corners resolve to the shared corner vertex). */
  vertex(side: SurfaceSide, u: number, v: number): number {
    if (v === 0) return this.pole(side, u);
    const column = this.surface.columnOf(u);
    if (column >= 0) {
      const row = this.surface.rowOf(v);
      const offset = column - this.columnStart;
      if (row >= 0 && offset >= 0 && offset <= this.surface.U) return this.corner(side, column, row);
    }
    const key = `${u}:${v}`;
    let index = this.extras[side].get(key);
    if (index === undefined) {
      index = this.surfacePoint(side, u, v);
      this.extras[side].set(key, index);
    }
    return index;
  }

  /** Vertex k of the rounded lip at angle u. */
  rim(u: number, k: number): number {
    const key = `${u}:${k}`;
    let index = this.rimVertices.get(key);
    if (index === undefined) {
      const s = this.scratch;
      const last = this.surface.profile.rimSegments;
      // The two ends of the lip are the glazed surfaces' own rim points, bit for bit.
      if (k === 0) this.surface.point(OUTER, u, 1, s);
      else if (k === last) this.surface.point(INNER, u, 1, s);
      else this.surface.rimPoint(u, k, s);
      index = this.raw(s[0], s[1], s[2], s[3], s[4], s[5], u, 1, KIND_RIM, k / last);
      this.rimVertices.set(key, index);
    }
    return index;
  }

  triangle(a: number, b: number, c: number): void {
    if (a === b || b === c || a === c) return;
    if (this.indexCount + 3 > this.indices.length) {
      const grown = new Uint32Array(this.indices.length * 2);
      grown.set(this.indices);
      this.indices = grown;
    }
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  /**
   * Emits a convex material-space polygon on both glazed skins as a fan around vertex `apex`.
   * A counter-clockwise polygon in (u, v) faces inward on the outer skin, so that one is flipped.
   */
  skin(us: readonly number[], vs: readonly number[], apex = 0): void {
    const n = us.length;
    for (const side of [OUTER, INNER] as const) {
      const ids = new Array<number>(n);
      for (let i = 0; i < n; i++) ids[i] = this.vertex(side, us[i], vs[i]);
      for (let k = 1; k < n - 1; k++) {
        const a = ids[apex], b = ids[(apex + k) % n], c = ids[(apex + k + 1) % n];
        if (side === OUTER) {
          this.triangle(a, c, b);
          this.outerArea += this.triangleArea(a, b, c);
        } else {
          this.triangle(a, b, c);
        }
      }
    }
  }

  /** Full grid cell on both skins. */
  cell(column: number, row: number): void {
    const a = this.corner(OUTER, column, row), b = this.corner(OUTER, column + 1, row);
    const c = this.corner(OUTER, column + 1, row + 1), d = this.corner(OUTER, column, row + 1);
    this.triangle(a, c, b);
    this.triangle(a, d, c);
    this.outerArea += this.triangleArea(a, b, c) + this.triangleArea(a, c, d);
    const e = this.corner(INNER, column, row), f = this.corner(INNER, column + 1, row);
    const g = this.corner(INNER, column + 1, row + 1), h = this.corner(INNER, column, row + 1);
    this.triangle(e, f, g);
    this.triangle(e, g, h);
  }

  /** Rounded lip between two rim points; the polygon edge runs from ua to ub along v = 1. */
  lip(ua: number, ub: number): void {
    if (ua === ub) return;
    const segments = this.surface.profile.rimSegments;
    for (let k = 0; k < segments; k++) {
      const a0 = this.rim(ua, k), b0 = this.rim(ub, k), a1 = this.rim(ua, k + 1), b1 = this.rim(ub, k + 1);
      if (ub < ua) {
        this.triangle(a0, b0, b1);
        this.triangle(a0, b1, a1);
      } else {
        this.triangle(a0, b1, b0);
        this.triangle(a0, a1, b1);
      }
    }
  }

  position(index: number): Vec3 {
    const o = index * VERTEX_FLOATS;
    return [this.data[o], this.data[o + 1], this.data[o + 2]];
  }

  private triangleArea(a: number, b: number, c: number): number {
    const d = this.data;
    const ao = a * VERTEX_FLOATS, bo = b * VERTEX_FLOATS, co = c * VERTEX_FLOATS;
    const ux = d[bo] - d[ao], uy = d[bo + 1] - d[ao + 1], uz = d[bo + 2] - d[ao + 2];
    const vx = d[co] - d[ao], vy = d[co + 1] - d[ao + 1], vz = d[co + 2] - d[ao + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }

  /** Volume, centre of mass and inertia of the closed mesh, by summing signed tetrahedra. */
  massProperties(): MassProperties {
    const d = this.data, idx = this.indices, count = this.indexCount;
    let volume = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < count; i += 3) {
      const a = idx[i] * VERTEX_FLOATS, b = idx[i + 1] * VERTEX_FLOATS, c = idx[i + 2] * VERTEX_FLOATS;
      const det =
        d[a] * (d[b + 1] * d[c + 2] - d[b + 2] * d[c + 1]) -
        d[a + 1] * (d[b] * d[c + 2] - d[b + 2] * d[c]) +
        d[a + 2] * (d[b] * d[c + 1] - d[b + 1] * d[c]);
      volume += det;
      cx += det * (d[a] + d[b] + d[c]);
      cy += det * (d[a + 1] + d[b + 1] + d[c + 1]);
      cz += det * (d[a + 2] + d[b + 2] + d[c + 2]);
    }
    if (!(Math.abs(volume) > 1e-12)) return { volume: 0, centroid: [0, 0, 0], inertia: [0, 0, 0] };
    const centroid: Vec3 = [cx / (4 * volume), cy / (4 * volume), cz / (4 * volume)];

    // Second moments about the centroid, again per signed tetrahedron (origin, a, b, c).
    let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
    for (let i = 0; i < count; i += 3) {
      const a = idx[i] * VERTEX_FLOATS, b = idx[i + 1] * VERTEX_FLOATS, c = idx[i + 2] * VERTEX_FLOATS;
      const ax = d[a] - centroid[0], ay = d[a + 1] - centroid[1], az = d[a + 2] - centroid[2];
      const bx = d[b] - centroid[0], by = d[b + 1] - centroid[1], bz = d[b + 2] - centroid[2];
      const px = d[c] - centroid[0], py = d[c + 1] - centroid[1], pz = d[c + 2] - centroid[2];
      const det = ax * (by * pz - bz * py) - ay * (bx * pz - bz * px) + az * (bx * py - by * px);
      const sx = ax + bx + px, sy = ay + by + py, sz = az + bz + pz;
      xx += det * (ax * ax + bx * bx + px * px + sx * sx);
      yy += det * (ay * ay + by * by + py * py + sy * sy);
      zz += det * (az * az + bz * bz + pz * pz + sz * sz);
      xy += det * (ax * ay + bx * by + px * py + sx * sy);
      xz += det * (ax * az + bx * bz + px * pz + sx * sz);
      yz += det * (ay * az + by * bz + py * pz + sy * sz);
    }
    const k = 1 / 120;
    xx *= k; yy *= k; zz *= k; xy *= k; xz *= k; yz *= k;
    const inertia = symmetricEigenvalues([yy + zz, xx + zz, xx + yy, -xy, -xz, -yz]);
    return { volume: volume / 6, centroid, inertia: [Math.abs(inertia[0]), Math.abs(inertia[1]), Math.abs(inertia[2])] };
  }

  /** Final mesh with positions moved so the given centre is the origin. */
  build(centre: Vec3): MeshData {
    const vertices = this.data.slice(0, this.vertexCount * VERTEX_FLOATS);
    for (let i = 0; i < vertices.length; i += VERTEX_FLOATS) {
      vertices[i] -= centre[0];
      vertices[i + 1] -= centre[1];
      vertices[i + 2] -= centre[2];
    }
    return { vertices, indices: this.indices.slice(0, this.indexCount) };
  }
}

export { INNER, OUTER };
