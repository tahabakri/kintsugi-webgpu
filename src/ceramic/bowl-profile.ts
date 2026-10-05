import { BOWL, clamp, smoothstep } from '../config';

/** A point of the bowl's cross-section in the meridian plane, with its unit surface normal. */
export interface ProfileSample {
  r: number;
  y: number;
  nr: number;
  ny: number;
}

interface Point {
  r: number;
  y: number;
}

/** One stretch of the outer profile plus how many tessellation rows it should receive. */
interface Piece {
  points: Point[];
  rows: number;
}

const TABLE_SIZE = 2048;
const RIM_ARC_SEGMENTS = 6;

function line(a: Point, b: Point, rows: number): Piece {
  return { points: [a, b], rows };
}

/** Quadratic Bézier from a to b with the sharp corner as control point: a G1 fillet. */
function fillet(a: Point, corner: Point, b: Point, rows: number, samples = 10): Piece {
  const points: Point[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, s = 1 - t;
    points.push({
      r: s * s * a.r + 2 * s * t * corner.r + t * t * b.r,
      y: s * s * a.y + 2 * s * t * corner.y + t * t * b.y,
    });
  }
  return { points, rows };
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, rows: number, samples = 260): Piece {
  const points: Point[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, s = 1 - t;
    const a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
    points.push({ r: a * p0.r + b * p1.r + c * p2.r + d * p3.r, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return { points, rows };
}

function toward(from: Point, to: Point, distance: number): Point {
  const dr = to.r - from.r, dy = to.y - from.y;
  const l = Math.hypot(dr, dy) || 1;
  return { r: from.r + (dr / l) * distance, y: from.y + (dy / l) * distance };
}

/**
 * Outer cross-section from the centre of the underside to the rim: recessed base, raised foot ring,
 * rounded belly and a slightly flared lip. Row counts add up to BOWL.vSegments.
 */
function outerPieces(): Piece[] {
  const { footInner, footOuter, footTop, recess, rimRadius, height } = BOWL;
  const centre: Point = { r: 0, y: recess };
  const c1: Point = { r: footInner, y: recess };          // base meets inner foot wall
  const c2: Point = { r: footInner + 0.012, y: 0 };       // inner foot wall meets foot bottom
  const c3: Point = { r: footOuter, y: 0 };               // foot bottom meets outer foot wall
  const c4: Point = { r: footOuter - 0.012, y: footTop }; // foot neck, where the belly springs out

  const bellyDir = { r: 0.96, y: 0.28 };
  const bellyLen = Math.hypot(bellyDir.r, bellyDir.y);
  const neckCut = 0.06;
  const b0: Point = { r: c4.r + (bellyDir.r / bellyLen) * neckCut, y: c4.y + (bellyDir.y / bellyLen) * neckCut };
  const b1: Point = { r: b0.r + 0.69, y: b0.y + 0.2 };
  const b2: Point = { r: rimRadius - 0.22, y: height - 0.67 };
  const b3: Point = { r: rimRadius, y: height };

  const a1 = toward(c1, centre, 0.03), e1 = toward(c1, c2, 0.03);
  const a2 = toward(c2, c1, 0.022), e2 = toward(c2, c3, 0.022);
  const a3 = toward(c3, c2, 0.028), e3 = toward(c3, c4, 0.028);
  const a4 = toward(c4, c3, neckCut);

  const base: Piece[] = [
    line(centre, a1, 5),
    fillet(a1, c1, e1, 2),
    line(e1, a2, 1),
    fillet(a2, c2, e2, 2),
    line(e2, a3, 1),
    fillet(a3, c3, e3, 2),
    line(e3, a4, 2),
    fillet(a4, c4, b0, 2),
  ];
  const used = base.reduce((sum, piece) => sum + piece.rows, 0);
  return [...base, cubic(b0, b1, b2, b3, BOWL.vSegments - used)];
}

/**
 * The bowl's cross-section, parameterised by v = normalised arc length along the outer surface
 * (0 at the centre of the underside, 1 at the rim). The inner surface is expressed in the same
 * parameter so that outer(v) → inner(v) is the through-thickness direction a crack follows.
 */
export class BowlProfile {
  /** Outer arc length from pole to rim, in world units. */
  readonly length: number;
  /** v positions of the tessellation rows: rows[0] = 0, rows[vSegments] = 1. */
  readonly rows: Float64Array;
  readonly wallThickness: number;
  readonly rimSegments = RIM_ARC_SEGMENTS;

  private readonly outerTable = new Float64Array((TABLE_SIZE + 1) * 4);
  private readonly innerTable = new Float64Array((TABLE_SIZE + 1) * 4);

  constructor(wallThickness: number = BOWL.defaultWall) {
    this.wallThickness = wallThickness;
    const pieces = outerPieces();

    // Flatten to one polyline, remembering where each piece starts in arc length.
    const pts: Point[] = [];
    const pieceStart: number[] = [];
    const pieceEnd: number[] = [];
    const cumulative: number[] = [];
    let total = 0;
    for (const piece of pieces) {
      pieceStart.push(total);
      piece.points.forEach((p, i) => {
        if (pts.length > 0 && i === 0) return; // shared with the previous piece's last point
        if (pts.length > 0) {
          const prev = pts[pts.length - 1];
          total += Math.hypot(p.r - prev.r, p.y - prev.y);
        }
        pts.push(p);
        cumulative.push(total);
      });
      pieceEnd.push(total);
    }
    this.length = total;

    // Rows: evenly spaced by arc length inside each piece, so fillets always get their own rows.
    const rows: number[] = [0];
    pieces.forEach((piece, index) => {
      for (let k = 1; k <= piece.rows; k++) {
        rows.push((pieceStart[index] + ((pieceEnd[index] - pieceStart[index]) * k) / piece.rows) / total);
      }
    });
    rows[rows.length - 1] = 1;
    this.rows = Float64Array.from(rows);

    // Vertex normals of the polyline: average of the neighbouring segment normals (outward = tangent turned clockwise).
    const vn: Point[] = pts.map((_, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const tr = b.r - a.r, ty = b.y - a.y;
      const l = Math.hypot(tr, ty) || 1;
      return { r: ty / l, y: -tr / l };
    });

    const outer = this.outerTable;
    let segment = 0;
    for (let k = 0; k <= TABLE_SIZE; k++) {
      const s = (k / TABLE_SIZE) * total;
      while (segment < pts.length - 2 && cumulative[segment + 1] < s) segment++;
      const span = cumulative[segment + 1] - cumulative[segment];
      const t = span > 0 ? clamp((s - cumulative[segment]) / span) : 0;
      const a = pts[segment], b = pts[segment + 1];
      const na = vn[segment], nb = vn[segment + 1];
      const nr = na.r + (nb.r - na.r) * t, ny = na.y + (nb.y - na.y) * t;
      const nl = Math.hypot(nr, ny) || 1;
      outer[k * 4] = a.r + (b.r - a.r) * t;
      outer[k * 4 + 1] = a.y + (b.y - a.y) * t;
      outer[k * 4 + 2] = nr / nl;
      outer[k * 4 + 3] = ny / nl;
    }
    outer[0] = 0; // the pole sits exactly on the axis
    outer[2] = 0;
    outer[3] = -1;

    this.buildInner(pieceEnd[0] / total, pieceEnd[7] / total);
  }

  /** Wall thickness along the profile: the lip is slightly thicker than the wall. */
  thicknessAt(v: number): number {
    return this.wallThickness * (1 + 0.13 * smoothstep(0.9, 1, v));
  }

  private buildInner(vUnderside: number, vBelly: number): void {
    const outer = this.outerTable, inner = this.innerTable;
    const wallStart = Math.min(0.6, vBelly + 0.18 / this.length);
    const kWall = Math.ceil(wallStart * TABLE_SIZE);
    const vWall = kWall / TABLE_SIZE;

    // Walls: the inner surface is the outer one pushed inward along its normal.
    for (let k = kWall; k <= TABLE_SIZE; k++) {
      const t = this.thicknessAt(k / TABLE_SIZE);
      inner[k * 4] = outer[k * 4] - outer[k * 4 + 2] * t;
      inner[k * 4 + 1] = outer[k * 4 + 1] - outer[k * 4 + 3] * t;
    }

    // Base: a shallow dish that meets the wall offset curve with matching slope.
    const floorY = BOWL.recess + BOWL.baseThickness * (this.wallThickness / BOWL.defaultWall);
    const rWall = inner[kWall * 4], yWall = inner[kWall * 4 + 1];
    const slope = (inner[(kWall + 1) * 4 + 1] - yWall) / Math.max(1e-9, inner[(kWall + 1) * 4] - rWall);
    const rise = Math.max(1e-4, yWall - floorY);
    const power = Math.max(2, (slope * rWall) / rise);

    // Radius of the inner point for a given outer v. Under the flat base the two are stacked
    // vertically; around the foot ring the inner radius advances slowly so every outer→inner
    // segment stays inside the ceramic.
    const rUnderside = this.outerRadiusAtTable(Math.round(vUnderside * TABLE_SIZE));
    const rBelly = this.outerRadiusAtTable(Math.round(vBelly * TABLE_SIZE)) * 0.985;
    const stops: Array<[number, number]> = [
      [0, 0],
      [vUnderside, rUnderside],
      [vBelly, Math.min(rBelly, rWall * 0.97)],
      [vWall, rWall],
    ];
    for (let k = 0; k < kWall; k++) {
      const v = k / TABLE_SIZE;
      let i = 0;
      while (i < stops.length - 2 && v > stops[i + 1][0]) i++;
      const [v0, r0] = stops[i], [v1, r1] = stops[i + 1];
      const r = r0 + (r1 - r0) * clamp((v - v0) / (v1 - v0));
      inner[k * 4] = r;
      inner[k * 4 + 1] = floorY + rise * Math.pow(r / rWall, power);
    }

    // Normals point into the bowl's cavity (tangent turned counter-clockwise).
    for (let k = 0; k <= TABLE_SIZE; k++) {
      const a = Math.max(0, k - 1), b = Math.min(TABLE_SIZE, k + 1);
      const tr = inner[b * 4] - inner[a * 4], ty = inner[b * 4 + 1] - inner[a * 4 + 1];
      const l = Math.hypot(tr, ty) || 1;
      inner[k * 4 + 2] = -ty / l;
      inner[k * 4 + 3] = tr / l;
    }
    inner[2] = 0;
    inner[3] = 1;
  }

  private outerRadiusAtTable(k: number): number {
    return this.outerTable[k * 4];
  }

  private sample(table: Float64Array, v: number, out: ProfileSample): ProfileSample {
    const x = clamp(v) * TABLE_SIZE;
    const k = Math.min(TABLE_SIZE - 1, Math.floor(x));
    const t = x - k;
    const a = k * 4, b = a + 4;
    out.r = table[a] + (table[b] - table[a]) * t;
    out.y = table[a + 1] + (table[b + 1] - table[a + 1]) * t;
    const nr = table[a + 2] + (table[b + 2] - table[a + 2]) * t;
    const ny = table[a + 3] + (table[b + 3] - table[a + 3]) * t;
    const l = Math.hypot(nr, ny) || 1;
    out.nr = nr / l;
    out.ny = ny / l;
    return out;
  }

  outer(v: number, out: ProfileSample = { r: 0, y: 0, nr: 0, ny: 0 }): ProfileSample {
    return this.sample(this.outerTable, v, out);
  }

  inner(v: number, out: ProfileSample = { r: 0, y: 0, nr: 0, ny: 0 }): ProfileSample {
    return this.sample(this.innerTable, v, out);
  }

  /**
   * Rounded lip joining the outer rim edge (k = 0) to the inner rim edge (k = rimSegments).
   * The arc bulges along the direction the wall was travelling in.
   */
  rim(k: number, out: ProfileSample = { r: 0, y: 0, nr: 0, ny: 0 }): ProfileSample {
    const o = this.outer(1), i = this.inner(1);
    if (k <= 0) { out.r = o.r; out.y = o.y; out.nr = o.nr; out.ny = o.ny; return out; }
    if (k >= this.rimSegments) { out.r = i.r; out.y = i.y; out.nr = i.nr; out.ny = i.ny; return out; }
    const phi = (k / this.rimSegments) * Math.PI;
    const cr = (o.r + i.r) / 2, cy = (o.y + i.y) / 2;
    const hr = o.r - cr, hy = o.y - cy;
    const half = Math.hypot(hr, hy);
    // Wall tangent at the rim: outward normal turned counter-clockwise.
    const tr = -o.ny, ty = o.nr;
    const bulge = half * 0.92;
    out.r = cr + hr * Math.cos(phi) + tr * bulge * Math.sin(phi);
    out.y = cy + hy * Math.cos(phi) + ty * bulge * Math.sin(phi);
    const nr = (hr / half) * Math.cos(phi) + tr * Math.sin(phi);
    const ny = (hy / half) * Math.cos(phi) + ty * Math.sin(phi);
    const l = Math.hypot(nr, ny) || 1;
    out.nr = nr / l;
    out.ny = ny / l;
    return out;
  }

  /** Closest material coordinate v to a point of the meridian plane, and which surface it lies on. */
  nearest(r: number, y: number): { v: number; inner: boolean; distance: number } {
    let best = Infinity, bestK = 0, bestInner = false;
    const scan = (table: Float64Array, isInner: boolean, from: number, to: number, step: number) => {
      for (let k = from; k <= to; k += step) {
        const d = (table[k * 4] - r) ** 2 + (table[k * 4 + 1] - y) ** 2;
        if (d < best) { best = d; bestK = k; bestInner = isInner; }
      }
    };
    scan(this.outerTable, false, 0, TABLE_SIZE, 8);
    scan(this.innerTable, true, 0, TABLE_SIZE, 8);
    const table = bestInner ? this.innerTable : this.outerTable;
    scan(table, bestInner, Math.max(0, bestK - 8), Math.min(TABLE_SIZE, bestK + 8), 1);
    return { v: bestK / TABLE_SIZE, inner: bestInner, distance: Math.sqrt(best) };
  }
}
