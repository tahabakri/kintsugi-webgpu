import { BOWL, smoothstep } from '../config';
import { INNER, OUTER, type BowlSurface } from '../ceramic/uv-surface';
import { valueNoise3 } from '../math/random';
import type { Vec2, Vec3 } from '../math/vec';
import { clipAxis, makeSupport, polygonArea, supportParam, TAG_COLUMN, TAG_ROW, type Support, type TaggedPolygon } from './clipping';
import type { CrackSegment } from './crack-graph';
import { KIND_FRACTURE, MeshAssembler, type MeshData } from './mesh-assembler';
import { SURVIVOR, type FracturePattern } from './pattern';
import { EDGE_SEAM, type DiagramCell } from './power-diagram';
import { buildHulls } from './shard-colliders';

export interface ShardGeometry {
  id: number;
  /** Closed triangle mesh, positions relative to `centroid`. */
  mesh: MeshData;
  /** Centre of mass in bowl space; the shard's local frame is bowl space shifted by this. */
  centroid: Vec3;
  volume: number;
  mass: number;
  /** Principal moments of inertia about the centroid. */
  inertia: Vec3;
  /** Area of the outer glazed skin. */
  surfaceArea: number;
  /** Triangles on exposed fracture faces. */
  fractureTriangles: number;
  /** Convex pieces approximating the shard for collision, relative to `centroid`. */
  hulls: Float32Array[];
  boundingRadius: number;
  survivor: boolean;
}

/** Layers of quads across the wall thickness on a fracture face. */
const WALL_LAYERS = 3;
/** Peak displacement of fracture-face vertices, in world units. */
const ROUGHNESS = 0.012;
/** Distance over which roughness fades out towards the ends of a crack segment. */
const ROUGHNESS_TAPER = 0.05;

/** The fracture face along one crack segment, built once and used by both shards that share it. */
interface WallStrip {
  samples: Vec2[];
  /** (samples × (WALL_LAYERS + 1)) positions, row 0 on the outer skin. */
  positions: Float64Array;
  /** Matching unit normals for the shard whose boundary runs in the strip's direction. */
  normals: Float64Array;
  /** True when the strip runs the same way as its segment (counter-clockwise for the segment's faceA). */
  ordered: boolean;
}

function buildWallStrip(surface: BowlSurface, segment: CrackSegment): WallStrip {
  const first = segment.samples[0], last = segment.samples[segment.samples.length - 1];
  const ordered = supportParam(segment.support, first[0], first[1]) <= supportParam(segment.support, last[0], last[1]);
  const samples = ordered ? segment.samples : [...segment.samples].reverse();
  const n = samples.length, rows = WALL_LAYERS + 1;
  const positions = new Float64Array(n * rows * 3);
  const normals = new Float64Array(n * rows * 3);
  const outer: Vec3[] = samples.map(([u, v]) => surface.position(OUTER, u, v));
  const inner: Vec3[] = samples.map(([u, v]) => surface.position(INNER, u, v));

  const along = new Float64Array(n);
  for (let k = 1; k < n; k++) {
    along[k] = along[k - 1] + Math.hypot(outer[k][0] - outer[k - 1][0], outer[k][1] - outer[k - 1][1], outer[k][2] - outer[k - 1][2]);
  }
  const total = along[n - 1];

  for (let k = 0; k < n; k++) {
    const o = outer[k], i = inner[k];
    const a = outer[Math.max(0, k - 1)], b = outer[Math.min(n - 1, k + 1)];
    // Face normal for the strip's own direction: tangent × through-thickness.
    const tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const wx = i[0] - o[0], wy = i[1] - o[1], wz = i[2] - o[2];
    let nx = ty * wz - tz * wy, ny = tz * wx - tx * wz, nz = tx * wy - ty * wx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // Roughness vanishes at both ends so neighbouring strips meet on a clean line.
    const taper = smoothstep(0, ROUGHNESS_TAPER, Math.min(along[k], total - along[k]));
    for (let m = 0; m < rows; m++) {
      const t = m / WALL_LAYERS;
      let px = o[0] + wx * t, py = o[1] + wy * t, pz = o[2] + wz * t;
      if (m > 0 && m < WALL_LAYERS && taper > 0) {
        const noise =
          0.55 * valueNoise3(px * 9, py * 9, pz * 9) +
          0.3 * valueNoise3(px * 21 + 7.3, py * 21, pz * 21) +
          0.15 * valueNoise3(px * 47, py * 47 + 3.1, pz * 47);
        const d = ROUGHNESS * taper * noise;
        px += nx * d; py += ny * d; pz += nz * d;
      }
      const at = (k * rows + m) * 3;
      positions[at] = px; positions[at + 1] = py; positions[at + 2] = pz;
    }
  }

  // Shading normals from the displaced grid.
  for (let k = 0; k < n; k++) {
    for (let m = 0; m < rows; m++) {
      const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
      const m0 = Math.max(0, m - 1), m1 = Math.min(rows - 1, m + 1);
      const a = (k0 * rows + m) * 3, b = (k1 * rows + m) * 3, c = (k * rows + m0) * 3, d = (k * rows + m1) * 3;
      const tx = positions[b] - positions[a], ty = positions[b + 1] - positions[a + 1], tz = positions[b + 2] - positions[a + 2];
      const wx = positions[d] - positions[c], wy = positions[d + 1] - positions[c + 1], wz = positions[d + 2] - positions[c + 2];
      let nx = ty * wz - tz * wy, ny = tz * wx - tx * wz, nz = tx * wy - ty * wx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const at = (k * rows + m) * 3;
      normals[at] = nx / nl; normals[at + 1] = ny / nl; normals[at + 2] = nz / nl;
    }
  }
  return { samples, positions, normals, ordered };
}

/**
 * Adds one fracture face to a shard. `forward` is true when the shard's counter-clockwise boundary
 * runs in the strip's direction; the other shard gets the same surface facing the other way.
 */
function emitWall(asm: MeshAssembler, surface: BowlSurface, strip: WallStrip, forward: boolean): void {
  const n = strip.samples.length, rows = WALL_LAYERS + 1;
  const sign = forward ? 1 : -1;
  const ids = new Int32Array(n * rows);
  for (let k = 0; k < n; k++) {
    const [u, v] = strip.samples[k];
    for (let m = 0; m < rows; m++) {
      const at = (k * rows + m) * 3;
      ids[k * rows + m] = asm.raw(
        strip.positions[at], strip.positions[at + 1], strip.positions[at + 2],
        strip.normals[at] * sign, strip.normals[at + 1] * sign, strip.normals[at + 2] * sign,
        u, v, KIND_FRACTURE, m / WALL_LAYERS,
      );
    }
  }
  const before = asm.indexCount;
  for (let k = 0; k < n - 1; k++) {
    for (let m = 0; m < WALL_LAYERS; m++) {
      const a = ids[k * rows + m], b = ids[(k + 1) * rows + m], c = ids[(k + 1) * rows + m + 1], d = ids[k * rows + m + 1];
      if (forward) { asm.triangle(a, b, d); asm.triangle(b, c, d); }
      else { asm.triangle(a, d, b); asm.triangle(b, d, c); }
    }
  }

  // Where the crack runs out through the rim, close the rounded lip's cross-section.
  // The shard's boundary ends at the strip's last column when travelling forward.
  if (strip.samples[n - 1][1] === 1) emitRimCap(asm, surface, strip, n - 1, forward ? 1 : -1);
  if (strip.samples[0][1] === 1) emitRimCap(asm, surface, strip, 0, forward ? -1 : 1);
  asm.fractureTriangles += (asm.indexCount - before) / 3;
}

/** Half-disc between the lip's arc and the wall's end column; `facing` is ±1 along increasing u. */
function emitRimCap(asm: MeshAssembler, surface: BowlSurface, strip: WallStrip, column: number, facing: number): void {
  const rows = WALL_LAYERS + 1;
  const [u] = strip.samples[column];
  const segments = surface.profile.rimSegments;
  const p = new Float64Array(6);
  const at = column * rows * 3;
  const ox = strip.positions[at], oz = strip.positions[at + 2];
  const r = Math.hypot(ox, oz) || 1;
  const nx = (-oz / r) * facing, nz = (ox / r) * facing;

  // Boundary of the cap: outer rim point, the lip's arc, inner rim point, then back along the wall column.
  const ring: number[] = [];
  const add = (x: number, y: number, z: number, aux: number) => ring.push(asm.raw(x, y, z, nx, 0, nz, u, 1, KIND_FRACTURE, aux));
  add(strip.positions[at], strip.positions[at + 1], strip.positions[at + 2], 0);
  for (let k = 1; k < segments; k++) {
    surface.rimPoint(u, k, p);
    add(p[0], p[1], p[2], k / segments);
  }
  const end = at + WALL_LAYERS * 3;
  add(strip.positions[end], strip.positions[end + 1], strip.positions[end + 2], 1);
  for (let m = WALL_LAYERS - 1; m >= 1; m--) {
    const w = at + m * 3;
    add(strip.positions[w], strip.positions[w + 1], strip.positions[w + 2], m / WALL_LAYERS);
  }

  // Fan from the top of the arc, wound so the geometric normal agrees with `facing`.
  const apex = segments >> 1;
  const count = ring.length;
  const a = asm.position(ring[apex]), b = asm.position(ring[(apex + 1) % count]), c = asm.position(ring[(apex + 2) % count]);
  const gx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  const gz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const flip = gx * nx + gz * nz < 0;
  for (let k = 1; k < count - 1; k++) {
    const i0 = ring[apex], i1 = ring[(apex + k) % count], i2 = ring[(apex + k + 1) % count];
    if (flip) asm.triangle(i0, i2, i1);
    else asm.triangle(i0, i1, i2);
  }
}

/** Lips for every edge of a clipped polygon that lies on the rim. */
function emitLips(asm: MeshAssembler, poly: TaggedPolygon): void {
  for (let k = 0, n = poly.u.length; k < n; k++) {
    const l = k + 1 === n ? 0 : k + 1;
    if (poly.tag[k] === TAG_ROW && poly.v[k] === 1 && poly.v[l] === 1) asm.lip(poly.u[k], poly.u[l]);
  }
}

/** Grid columns [first, last) that a u-interval touches. */
function columnSpan(minU: number, maxU: number, U: number): [number, number] {
  let first = Math.floor(minU * U);
  while ((first + 1) / U <= minU) first++;
  while (first / U > minU) first--;
  let last = Math.ceil(maxU * U);
  while ((last - 1) / U >= maxU) last--;
  while (last / U < maxU) last++;
  return [first, last];
}

/**
 * Meshes one convex piece of a diagram cell on the tessellation grid. Grid cells that lie wholly
 * inside it are emitted as they are; the ones its edges pass through are clipped.
 */
function tessellateCell(asm: MeshAssembler, surface: BowlSurface, cell: DiagramCell): void {
  const supports: Support[] = [];
  const poly: TaggedPolygon = { u: [...cell.u], v: [...cell.v], tag: [] };
  for (let k = 0, n = cell.u.length; k < n; k++) {
    const l = k + 1 === n ? 0 : k + 1;
    const tag = cell.tag[k];
    if (tag >= 0) {
      supports.push(makeSupport(cell.u[k], cell.v[k], cell.u[l], cell.v[l]));
      poly.tag.push(supports.length - 1);
    } else {
      // The seam runs along a grid column; the rim and the pole along grid rows.
      poly.tag.push(tag === EDGE_SEAM ? TAG_COLUMN : TAG_ROW);
    }
  }

  const rows = surface.rows, U = surface.U;
  const minV = Math.min(...poly.v), maxV = Math.max(...poly.v);
  const firstBand = surface.bandOf(minV), lastBand = surface.bandOf(Math.max(minV, maxV - 1e-15));
  for (let j = firstBand; j <= lastBand; j++) {
    const v0 = rows[j], v1 = rows[j + 1];
    const strip = clipAxis(clipAxis(poly, 1, v0, false, supports), 1, v1, true, supports);
    if (strip.u.length < 3) continue;
    // The strip is convex, so it contains every grid cell between the points where both its
    // bottom and its top edge have begun and neither has ended.
    let minU = Infinity, maxU = -Infinity;
    let b0 = Infinity, b1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (let k = 0; k < strip.u.length; k++) {
      const u = strip.u[k];
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (strip.v[k] === v0) { if (u < b0) b0 = u; if (u > b1) b1 = u; }
      else if (strip.v[k] === v1) { if (u < t0) t0 = u; if (u > t1) t1 = u; }
    }
    const lo = Math.max(b0, t0), hi = Math.min(b1, t1);
    const [c0, c1] = columnSpan(minU, maxU, U);
    for (let c = c0; c < c1; c++) {
      const u0 = c / U, u1 = (c + 1) / U;
      if (u0 >= lo && u1 <= hi) {
        asm.cell(c, j);
        if (j === surface.V - 1) asm.lip(u1, u0);
        continue;
      }
      const piece = clipAxis(clipAxis(strip, 0, u0, false, supports), 0, u1, true, supports);
      if (piece.u.length < 3 || !(polygonArea(piece) > 1e-16)) continue;
      asm.skin(piece.u, piece.v);
      if (j === surface.V - 1) emitLips(asm, piece);
    }
  }
}

/** The intact bowl: every grid cell, and the lip all the way round. */
function tessellateWhole(asm: MeshAssembler, surface: BowlSurface): void {
  const U = surface.U, V = surface.V;
  for (let j = 0; j < V; j++) {
    for (let c = 0; c < U; c++) {
      asm.cell(c, j);
      if (j === V - 1) asm.lip((c + 1) / U, c / U);
    }
  }
}

/**
 * Builds the closed mesh, mass properties and collision hulls of every shard of a fracture
 * pattern. With no pattern it builds the intact bowl as a single "shard".
 */
export function buildShards(surface: BowlSurface, pattern: FracturePattern | null, segments: readonly CrackSegment[]): ShardGeometry[] {
  const faceCount = pattern ? pattern.faceCount : 1;
  const start = pattern ? pattern.columnStart : 0;
  const strips = segments.map((segment) => buildWallStrip(surface, segment));

  const shards: ShardGeometry[] = [];
  for (let face = 0; face < faceCount; face++) {
    const asm = new MeshAssembler(surface, start);
    if (!pattern) {
      tessellateWhole(asm, surface);
    } else {
      for (const index of pattern.faceCells[face]) tessellateCell(asm, surface, pattern.diagram.cells[index]);
      segments.forEach((segment, i) => {
        // Segment samples run counter-clockwise for faceA and clockwise for faceB.
        if (segment.faceA === face) emitWall(asm, surface, strips[i], strips[i].ordered);
        if (segment.faceB === face) emitWall(asm, surface, strips[i], !strips[i].ordered);
      });
    }

    const props = asm.massProperties();
    // A mesh that failed to close gives a meaningless volume; fall back to skin area × thickness.
    const closed = props.volume > 1e-9;
    const volume = closed ? props.volume : Math.max(1e-6, asm.outerArea * surface.wallThickness);
    const centroid: Vec3 = closed ? props.centroid : averagePosition(asm);
    const mesh = asm.build(centroid);
    let boundingRadius = 0;
    for (let i = 0; i < mesh.vertices.length; i += 10) {
      boundingRadius = Math.max(boundingRadius, Math.hypot(mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]));
    }
    shards.push({
      id: face,
      mesh,
      centroid,
      volume,
      mass: volume * BOWL.density,
      inertia: [props.inertia[0] * BOWL.density, props.inertia[1] * BOWL.density, props.inertia[2] * BOWL.density],
      surfaceArea: asm.outerArea,
      fractureTriangles: asm.fractureTriangles,
      hulls: buildHulls(surface, pattern, face, centroid),
      boundingRadius,
      survivor: face === SURVIVOR,
    });
  }
  return shards;
}

function averagePosition(asm: MeshAssembler): Vec3 {
  const count = asm.vertexCount;
  const sum: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const p = asm.position(i);
    sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2];
  }
  return count > 0 ? [sum[0] / count, sum[1] / count, sum[2] / count] : [0, 0, 0];
}

export { INNER, OUTER };
