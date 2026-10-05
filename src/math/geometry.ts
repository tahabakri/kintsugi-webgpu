import type { Vec2, Vec3 } from './vec';

/** Signed area of a polygon given as parallel coordinate arrays (positive when counter-clockwise). */
export function signedArea(xs: readonly number[], ys: readonly number[]): number {
  let area = 0;
  for (let i = 0, n = xs.length; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    area += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return area * 0.5;
}

export function polygonCentroid(xs: readonly number[], ys: readonly number[]): Vec2 {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, n = xs.length; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const w = xs[i] * ys[j] - xs[j] * ys[i];
    area += w;
    cx += (xs[i] + xs[j]) * w;
    cy += (ys[i] + ys[j]) * w;
  }
  if (Math.abs(area) < 1e-18) {
    let sx = 0, sy = 0;
    for (let i = 0; i < xs.length; i++) { sx += xs[i]; sy += ys[i]; }
    return [sx / xs.length, sy / xs.length];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

/** Andrew's monotone chain. Returns the hull counter-clockwise without collinear points. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique: Vec2[] = [];
  for (const p of sorted) {
    const last = unique[unique.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) unique.push(p);
  }
  if (unique.length < 3) return unique;
  const turn = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Squared distance from p to segment ab in the plane, plus the clamped parameter along ab. */
export function pointSegment2D(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d2: number; t: number } {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-20 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - ax - dx * t, ey = py - ay - dy * t;
  return { d2: ex * ex + ey * ey, t };
}

/** Arc length of a 3D polyline. */
export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
  }
  return total;
}

/**
 * Jacobi eigen-decomposition of a symmetric 3×3 matrix given as [xx, yy, zz, xy, xz, yz].
 * Returns eigenvalues; used for the principal inertia proxy of a shard.
 */
export function symmetricEigenvalues(m: readonly number[]): Vec3 {
  const a = [
    [m[0], m[3], m[4]],
    [m[3], m[1], m[5]],
    [m[4], m[5], m[2]],
  ];
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return [a[0][0], a[1][1], a[2][2]];
}
