/**
 * Sutherland–Hodgman clipping of convex polygons whose edges remember what they lie on.
 *
 * Shards are meshed independently, yet their borders have to coincide exactly. To get that
 * without welding by tolerance, every point where a crack crosses a grid line is computed from
 * the crack's own supporting segment in a canonical order, never from a partially clipped edge.
 * Two shards that share a crack therefore produce bit-identical border vertices.
 */

/** Convex polygon as parallel arrays; tag[i] labels the edge from vertex i to vertex i + 1. */
export interface TaggedPolygon {
  u: number[];
  v: number[];
  tag: number[];
}

/** Edge lies on a horizontal grid line (constant v). */
export const TAG_ROW = -1;
/** Edge lies on a vertical grid line (constant u). */
export const TAG_COLUMN = -2;

/** A straight segment in material space, stored with its endpoints in lexicographic order. */
export interface Support {
  pu: number;
  pv: number;
  qu: number;
  qv: number;
}

export function makeSupport(au: number, av: number, bu: number, bv: number): Support {
  return au < bu || (au === bu && av <= bv) ? { pu: au, pv: av, qu: bu, qv: bv } : { pu: bu, pv: bv, qu: au, qv: av };
}

/** v at which the support crosses the vertical line at u. */
export function crossAtU(s: Support, u: number): number {
  return s.pv + (s.qv - s.pv) * ((u - s.pu) / (s.qu - s.pu));
}

/** u at which the support crosses the horizontal line at v. */
export function crossAtV(s: Support, v: number): number {
  return s.pu + (s.qu - s.pu) * ((v - s.pv) / (s.qv - s.pv));
}

/** Signed side of a point relative to the support's canonical direction (positive on its left). */
export function supportSide(s: Support, u: number, v: number): number {
  return (s.qu - s.pu) * (v - s.pv) - (s.qv - s.pv) * (u - s.pu);
}

/** Parameter of the projection of a point onto the support (0 at p, 1 at q). */
export function supportParam(s: Support, u: number, v: number): number {
  const du = s.qu - s.pu, dv = s.qv - s.pv;
  return ((u - s.pu) * du + (v - s.pv) * dv) / (du * du + dv * dv);
}

export function polygonArea(poly: TaggedPolygon): number {
  let area = 0;
  for (let i = 0, n = poly.u.length; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    area += poly.u[i] * poly.v[j] - poly.u[j] * poly.v[i];
  }
  return area * 0.5;
}

function dropDegenerate(poly: TaggedPolygon): TaggedPolygon {
  const out: TaggedPolygon = { u: [], v: [], tag: [] };
  const n = poly.u.length;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    // A zero-length edge carries no information: keep the later vertex and its tag.
    if (poly.u[i] === poly.u[j] && poly.v[i] === poly.v[j]) continue;
    out.u.push(poly.u[i]);
    out.v.push(poly.v[i]);
    out.tag.push(poly.tag[i]);
  }
  if (out.u.length < 3) return { u: [], v: [], tag: [] };
  return out;
}

/**
 * Keeps the part of `poly` on one side of an axis-aligned grid line.
 * axis 0 clips against u = c, axis 1 against v = c; `keepBelow` keeps coordinates <= c.
 */
export function clipAxis(
  poly: TaggedPolygon,
  axis: 0 | 1,
  c: number,
  keepBelow: boolean,
  supports: readonly Support[],
): TaggedPolygon {
  const n = poly.u.length;
  if (n === 0) return poly;
  const coord = axis === 0 ? poly.u : poly.v;
  let allInside = true, anyInside = false;
  for (let i = 0; i < n; i++) {
    const inside = keepBelow ? coord[i] <= c : coord[i] >= c;
    if (inside) anyInside = true;
    else allInside = false;
  }
  if (allInside) return poly;
  if (!anyInside) return { u: [], v: [], tag: [] };

  const lineTag = axis === 0 ? TAG_COLUMN : TAG_ROW;
  const out: TaggedPolygon = { u: [], v: [], tag: [] };
  const push = (u: number, v: number, tag: number) => { out.u.push(u); out.v.push(v); out.tag.push(tag); };
  const crossing = (i: number, j: number): [number, number] => {
    const tag = poly.tag[i];
    if (tag >= 0) {
      const s = supports[tag];
      return axis === 0 ? [c, crossAtU(s, c)] : [crossAtV(s, c), c];
    }
    // Edge on a grid line meeting the perpendicular grid line: the grid corner itself.
    if (tag === TAG_ROW && axis === 0) return [c, poly.v[i]];
    if (tag === TAG_COLUMN && axis === 1) return [poly.u[i], c];
    const t = (c - coord[i]) / (coord[j] - coord[i]);
    return axis === 0 ? [c, poly.v[i] + (poly.v[j] - poly.v[i]) * t] : [poly.u[i] + (poly.u[j] - poly.u[i]) * t, c];
  };

  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ina = keepBelow ? coord[i] <= c : coord[i] >= c;
    const inb = keepBelow ? coord[j] <= c : coord[j] >= c;
    if (ina && inb) {
      push(poly.u[i], poly.v[i], poly.tag[i]);
    } else if (ina) {
      if (coord[i] === c) {
        push(poly.u[i], poly.v[i], lineTag);
      } else {
        push(poly.u[i], poly.v[i], poly.tag[i]);
        const [xu, xv] = crossing(i, j);
        push(xu, xv, lineTag);
      }
    } else if (inb) {
      if (coord[j] !== c) {
        const [xu, xv] = crossing(i, j);
        push(xu, xv, poly.tag[i]);
      }
    }
  }
  return dropDegenerate(out);
}

/** Generic half-plane a·u + b·v (<= or >=) c used while building the power diagram. */
export interface Line {
  a: number;
  b: number;
  c: number;
}

/**
 * Keeps the part of `poly` where sign · (a·u + b·v − c) <= 0. New edges along the line get `lineTag`.
 * Positions of new vertices are interpolated here and replaced by canonical ones afterwards.
 */
export function clipLine(poly: TaggedPolygon, line: Line, sign: number, lineTag: number): TaggedPolygon {
  const n = poly.u.length;
  if (n === 0) return poly;
  const d = new Array<number>(n);
  let allInside = true, anyInside = false;
  for (let i = 0; i < n; i++) {
    d[i] = sign * (line.a * poly.u[i] + line.b * poly.v[i] - line.c);
    if (d[i] <= 0) anyInside = true;
    else allInside = false;
  }
  if (allInside) return poly;
  if (!anyInside) return { u: [], v: [], tag: [] };

  const out: TaggedPolygon = { u: [], v: [], tag: [] };
  const push = (u: number, v: number, tag: number) => { out.u.push(u); out.v.push(v); out.tag.push(tag); };
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ina = d[i] <= 0, inb = d[j] <= 0;
    if (ina && inb) {
      push(poly.u[i], poly.v[i], poly.tag[i]);
    } else if (ina) {
      if (d[i] === 0) {
        push(poly.u[i], poly.v[i], lineTag);
      } else {
        push(poly.u[i], poly.v[i], poly.tag[i]);
        const t = d[i] / (d[i] - d[j]);
        push(poly.u[i] + (poly.u[j] - poly.u[i]) * t, poly.v[i] + (poly.v[j] - poly.v[i]) * t, lineTag);
      }
    } else if (inb) {
      if (d[j] !== 0) {
        const t = d[i] / (d[i] - d[j]);
        push(poly.u[i] + (poly.u[j] - poly.u[i]) * t, poly.v[i] + (poly.v[j] - poly.v[i]) * t, poly.tag[i]);
      }
    }
  }
  return dropDegenerate(out);
}

/**
 * Part of a grid cell on one side of a crack support. The cell's own edges keep grid tags, the
 * new edge is tagged with `supportTag`, and the crossings are the support's canonical ones.
 * `keepPositive` keeps the side where supportSide(...) >= 0.
 */
export function clipCellBySupport(
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  support: Support,
  keepPositive: boolean,
  supportTag: number,
): TaggedPolygon {
  // Counter-clockwise cell: bottom, right, top, left.
  const cu = [u0, u1, u1, u0], cv = [v0, v0, v1, v1];
  const ctag = [TAG_ROW, TAG_COLUMN, TAG_ROW, TAG_COLUMN];
  const side = new Array<number>(4);
  for (let i = 0; i < 4; i++) {
    const s = supportSide(support, cu[i], cv[i]);
    side[i] = keepPositive ? -s : s; // inside when side <= 0
  }
  const out: TaggedPolygon = { u: [], v: [], tag: [] };
  const push = (u: number, v: number, tag: number) => { out.u.push(u); out.v.push(v); out.tag.push(tag); };
  const crossing = (i: number): [number, number] =>
    ctag[i] === TAG_ROW ? [crossAtV(support, cv[i]), cv[i]] : [cu[i], crossAtU(support, cu[i])];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    const ina = side[i] <= 0, inb = side[j] <= 0;
    if (ina && inb) {
      push(cu[i], cv[i], ctag[i]);
    } else if (ina) {
      if (side[i] === 0) {
        push(cu[i], cv[i], supportTag);
      } else {
        push(cu[i], cv[i], ctag[i]);
        const [xu, xv] = crossing(i);
        push(xu, xv, supportTag);
      }
    } else if (inb) {
      if (side[j] !== 0) {
        const [xu, xv] = crossing(i);
        push(xu, xv, ctag[i]);
      }
    }
  }
  return dropDegenerate(out);
}
