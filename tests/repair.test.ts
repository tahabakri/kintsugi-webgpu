import { describe, expect, it } from 'vitest';
import { BowlSurface } from '../src/ceramic/uv-surface';
import { DEFAULT_CONTROLS } from '../src/config';
import type { CrackEdge } from '../src/fracture/crack-graph';
import { fractureBowl, type FractureResult } from '../src/fracture/fracture-system';
import { quatFromAxisAngle, quatRotate, type Quat } from '../src/math/quat';
import { add3, sub3, type Vec3 } from '../src/math/vec';
import { isAligned, measureAlignment, type Pose } from '../src/repair/alignment';
import { cureResin, JOIN_CURE, JOIN_FILL, repairStats, structuralRepair, summariseEdge } from '../src/repair/curing';
import { RepairSystem, type RepairBodies } from '../src/repair/repair-system';
import { coolResin, depositResin, depositResinFromEnd, exchangeAtNode, flowResin, resinVolume } from '../src/repair/resin';
import { buildSeamGeometry } from '../src/repair/seam-geometry';
import { SEAM_VERTEX_FLOATS } from '../src/gpu/layouts';

const surface = new BowlSurface();
const DT = 1 / 120;
const controls = { viscosity: DEFAULT_CONTROLS.viscosity, temperature: DEFAULT_CONTROLS.temperature, cureRate: DEFAULT_CONTROLS.cureRate };

function fracture(): FractureResult {
  const result = fractureBowl(surface, { u: 0.17, v: 0.64, energy: 0.72 }, 20260214, DEFAULT_CONTROLS);
  if (!result) throw new Error('fracture failed');
  return result;
}

/** The longest edge of a fresh fracture: plenty of samples to watch resin move along. */
function longEdge(result: FractureResult = fracture()): CrackEdge {
  return [...result.graph.edges].sort((a, b) => b.length - a.length)[0];
}

/** Rigid bodies that sit wherever the test puts them. */
function fakeBodies(result: FractureResult, place: (shard: number) => Pose) {
  const joins: Array<[number, number]> = [];
  /** Edges currently steadied by the assist, with the springs asked for. */
  const tacks = new Map<number, { a: number; b: number; anchors: Vec3[]; stiffness: number }>();
  const bodies: RepairBodies = {
    pose: (shard) => (result.shards[shard] ? place(shard) : null),
    mass: (shard) => result.shards[shard].mass,
    tack: (edge, a, b, anchors, stiffness) => { tacks.set(edge, { a, b, anchors, stiffness }); },
    untack: (edge) => { tacks.delete(edge); },
    join: (a, b) => { joins.push([a, b]); },
  };
  return { bodies, joins, tacks };
}

const IDENTITY: Quat = [0, 0, 0, 1];
/** Every shard exactly where it was in the unbroken bowl. */
const assembled = (result: FractureResult) => (shard: number): Pose => ({ position: [...result.shards[shard].centroid] as Vec3, rotation: IDENTITY });
/** Every shard pushed straight out from the bowl's axis: nothing mates with anything. */
const scattered = (result: FractureResult) => (shard: number): Pose => {
  const c = result.shards[shard].centroid;
  return { position: [c[0] * 3 + shard * 0.4, c[1] + 1 + shard * 0.3, c[2] * 3], rotation: quatFromAxisAngle([0.3, 1, 0.2], 0.5 + shard) };
};

describe('resin flow', () => {
  it('keeps fill inside [0, 1] whatever is brushed on', () => {
    const edge = longEdge();
    for (let i = 0; i < 400; i++) {
      depositResin(edge, (i * 0.37) % 1, 0.6 + (i % 5), 0.07, 0.8);
      flowResin(edge, DT, controls);
      for (const value of edge.resin.fill) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
    // A saturated edge takes no more.
    expect(depositResin(edge, 0.5, 5, 0.07, 0.8)).toBeLessThan(1e-3);
  });

  it('spreads a deposit along the crack while conserving its volume', () => {
    const edge = longEdge();
    depositResin(edge, 0.5, 0.9, 0.05, 0.6);
    const before = resinVolume(edge);
    const wetBefore = edge.resin.fill.filter((f) => f > 0.02).length;
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 480; i++) flowResin(edge, DT, { ...controls, cureRate: 0 });
    expect(resinVolume(edge)).toBeCloseTo(before, 5);
    expect(edge.resin.fill.filter((f) => f > 0.02).length).toBeGreaterThan(wetBefore);
    // Flow only levels: no sample ends up fuller than the peak it started from.
    expect(Math.max(...edge.resin.fill)).toBeLessThanOrEqual(1);
  });

  it('travels less far when the resin is more viscous, and further when it is warm', () => {
    const reach = (viscosity: number, temperature: number): number => {
      const edge = longEdge();
      depositResin(edge, 0.5, 1.2, 0.04, temperature);
      for (let i = 0; i < 360; i++) flowResin(edge, DT, { viscosity, temperature: 50, cureRate: 0 });
      return edge.resin.fill.filter((f) => f > 0.02).length;
    };
    const thin = reach(5, 0.6), thick = reach(95, 0.6);
    expect(thin).toBeGreaterThan(thick);
    expect(reach(50, 1)).toBeGreaterThanOrEqual(reach(50, 0.15));
  });

  it('only passes between edges that meet at a node', () => {
    const result = fracture();
    const { edges, nodes } = result.graph;
    const source = longEdge(result);
    depositResin(source, 0, 3, 0.2, 0.9);
    depositResin(source, 1, 3, 0.2, 0.9);
    for (let i = 0; i < 60; i++) {
      for (const edge of edges) flowResin(edge, DT, controls);
      for (const node of nodes) exchangeAtNode(node, edges, DT, controls, 1);
    }
    const touching = new Set<number>([source.id]);
    for (const node of nodes) {
      if (node.ends.some((end) => end.edge === source.id)) node.ends.forEach((end) => touching.add(end.edge));
    }
    // After half a second resin can have crossed one junction, not two.
    const reached = edges.filter((edge) => edge.resin.fill.some((f) => f > 0)).map((edge) => edge.id);
    const twoAway = new Set<number>(touching);
    for (const node of nodes) {
      if (node.ends.some((end) => touching.has(end.edge))) node.ends.forEach((end) => twoAway.add(end.edge));
    }
    for (const id of reached) expect(twoAway.has(id)).toBe(true);
    expect(reached.some((id) => id !== source.id)).toBe(true);
    expect(reached.length).toBeLessThan(edges.length);
  });

  it('cools towards ambient', () => {
    const edge = longEdge();
    depositResin(edge, 0.5, 1, 0.1, 1);
    const hot = Math.max(...edge.resin.temperature);
    for (let i = 0; i < 1200; i++) coolResin(edge, DT);
    expect(Math.max(...edge.resin.temperature)).toBeLessThan(hot * 0.6);
  });
});

describe('curing', () => {
  it('only ever increases, and faster for cooler resin and higher cure rates', () => {
    const run = (cureRate: number, temperature: number): number => {
      const edge = longEdge();
      depositResin(edge, 0.5, 4, 0.5, temperature);
      let previous = 0;
      for (let i = 0; i < 240; i++) {
        cureResin(edge, DT, { ...controls, cureRate });
        summariseEdge(edge);
        expect(edge.cure).toBeGreaterThanOrEqual(previous - 1e-7);
        expect(edge.cure).toBeLessThanOrEqual(1);
        previous = edge.cure;
      }
      return previous;
    };
    const slow = run(20, 0.2), fast = run(90, 0.2), hot = run(90, 1);
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeGreaterThan(hot);
    expect(slow).toBeGreaterThan(0);
  });

  it('counts only samples that hold enough resin towards structural cure', () => {
    const edge = longEdge();
    summariseEdge(edge);
    expect(edge.cure).toBe(0);
    expect(edge.fill).toBe(0);
    expect(structuralRepair(edge)).toBe(0);
  });
});

describe('alignment', () => {
  it('reads mated shards as aligned and separated ones as not', () => {
    const result = fracture();
    const edge = longEdge(result);
    const together = assembled(result);
    const mated = measureAlignment(edge, together(edge.shardA), together(edge.shardB!));
    expect(mated.rms).toBeLessThan(1e-9);
    expect(mated.angle).toBeLessThan(1e-6);
    expect(mated.normalError).toBeLessThan(1e-3);
    expect(isAligned(false, mated)).toBe(true);

    const apart = scattered(result);
    const loose = measureAlignment(edge, apart(edge.shardA), apart(edge.shardB!));
    expect(loose.rms).toBeGreaterThan(0.2);
    expect(isAligned(true, loose)).toBe(false);
  });

  it('uses hysteresis so the ready state does not flicker', () => {
    const borderline = { rms: 0.065, angle: 0.05, tangentError: 0.05, normalError: 0.05 };
    expect(isAligned(false, borderline)).toBe(false);
    expect(isAligned(true, borderline)).toBe(true);
    expect(isAligned(true, { ...borderline, angle: 0.3 })).toBe(false);
  });
});

describe('repair system', () => {
  it('never bonds shards that are apart, however much cured gold they carry', () => {
    const result = fracture();
    const repair = new RepairSystem(result.graph, result.shards);
    const { bodies, joins } = fakeBodies(result, scattered(result));
    repair.paintRange({ amount: 1 }, controls);
    for (let i = 0; i < 120 * 12; i++) repair.step(DT, bodies, { ...controls, cureRate: 100 }, true);
    const stats = repair.stats();
    expect(stats.goldFilled).toBeGreaterThan(99);
    expect(stats.cured).toBeGreaterThan(99);
    expect(result.graph.edges.every((edge) => !edge.joined && !edge.aligned)).toBe(true);
    expect(joins.length).toBe(0);
    expect(repair.componentCount()).toBe(result.shards.length);
    // Cured gold on separated pieces is progress, but far from a repair.
    expect(stats.repaired).toBeGreaterThan(0);
    expect(stats.repaired).toBeLessThan(40);
  });

  it('never bonds aligned shards without enough cured gold', () => {
    const result = fracture();
    const repair = new RepairSystem(result.graph, result.shards);
    const { bodies, joins } = fakeBodies(result, assembled(result));
    for (let i = 0; i < 240; i++) repair.step(DT, bodies, controls, true);
    expect(result.graph.edges.every((edge) => edge.aligned)).toBe(true);
    expect(joins.length).toBe(0);
    expect(repair.stats().repaired).toBe(0);

    // Half-filled is still not enough.
    repair.paintRange({ amount: 0.5 }, controls);
    for (let i = 0; i < 120 * 12; i++) repair.step(DT, bodies, { ...controls, cureRate: 100 }, true);
    expect(result.graph.edges[0].fill).toBeLessThan(JOIN_FILL);
    expect(joins.length).toBe(0);
  });

  it('bonds aligned edges once they are filled and cured, and ends as one piece', () => {
    const result = fracture();
    const repair = new RepairSystem(result.graph, result.shards);
    const { bodies, joins } = fakeBodies(result, assembled(result));
    repair.paintRange({ amount: 1 }, controls);
    let previous = 0;
    let firstBond = -1;
    for (let i = 0; i < 120 * 20; i++) {
      const bonded = repair.step(DT, bodies, controls, true);
      if (bonded > 0 && firstBond < 0) firstBond = i;
      const { repaired } = repair.stats();
      expect(repaired).toBeGreaterThanOrEqual(0);
      expect(repaired).toBeLessThanOrEqual(100);
      expect(repaired).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = repaired;
      if (repair.componentCount() === 1 && repaired > 99.9) break;
    }
    // Bonding waits for the cure; it does not happen the moment gold is brushed on.
    expect(firstBond).toBeGreaterThan(60);
    expect(result.graph.edges.every((edge) => edge.joined)).toBe(true);
    for (const edge of result.graph.edges) {
      expect(edge.fill).toBeGreaterThan(JOIN_FILL);
      expect(edge.cure).toBeGreaterThan(JOIN_CURE);
    }
    expect(repair.componentCount()).toBe(1);
    // One physical bond per merge of two groups: a spanning tree, never a redundant loop.
    expect(joins.length).toBe(result.shards.length - 1);
    expect(repair.stats().repaired).toBeCloseTo(100, 5);
    expect(repair.stats().openLength).toBe(0);
  });

  it('assists only shards that are nearly mated, and never one that is in the hand', () => {
    const result = fracture();
    const edge = longEdge(result);
    const together = assembled(result);
    const nudged = (offset: number) => (shard: number): Pose => {
      const pose = together(shard);
      return shard === edge.shardB ? { position: [pose.position[0], pose.position[1] + offset, pose.position[2]], rotation: IDENTITY } : pose;
    };
    const assisted = (offset: number, assist = true, held = -1) => {
      const repair = new RepairSystem(result.graph, result.shards);
      const { bodies, tacks } = fakeBodies(result, nudged(offset));
      repair.step(DT, bodies, controls, assist, held);
      return tacks;
    };
    // A few millimetres out: steadied, with springs that span the two shards.
    const near = assisted(0.05);
    expect(near.has(edge.id)).toBe(true);
    const tack = near.get(edge.id)!;
    expect([tack.a, tack.b].sort()).toEqual([edge.shardA, edge.shardB].sort());
    expect(tack.anchors.length).toBeGreaterThanOrEqual(3);
    expect(tack.stiffness).toBeGreaterThan(0);
    // Across a real gap: left alone.
    expect(assisted(0.4).has(edge.id)).toBe(false);
    // In Break mode there is no assist at all.
    expect(assisted(0.05, false).size).toBe(0);
    // A piece being held is not pulled out of the hand.
    expect(assisted(0.05, true, edge.shardB!).has(edge.id)).toBe(false);
    expect(assisted(0.05, true, edge.shardA).has(edge.id)).toBe(false);
  });

  it('lets go of a steadied edge once it is pulled apart, with hysteresis', () => {
    const result = fracture();
    const edge = longEdge(result);
    const together = assembled(result);
    let offset = 0.05;
    const place = (shard: number): Pose => {
      const pose = together(shard);
      return shard === edge.shardB ? { position: [pose.position[0], pose.position[1] + offset, pose.position[2]], rotation: IDENTITY } : pose;
    };
    const repair = new RepairSystem(result.graph, result.shards);
    const { bodies, tacks } = fakeBodies(result, place);
    repair.step(DT, bodies, controls, true);
    expect(tacks.has(edge.id)).toBe(true);
    // Between the engage and release distances an existing hold is kept…
    offset = 0.16;
    repair.step(DT, bodies, controls, true);
    expect(tacks.has(edge.id)).toBe(true);
    // …but it is not taken up afresh there, and it is dropped beyond the release distance.
    offset = 0.3;
    repair.step(DT, bodies, controls, true);
    expect(tacks.has(edge.id)).toBe(false);
    offset = 0.16;
    repair.step(DT, bodies, controls, true);
    expect(tacks.has(edge.id)).toBe(false);
  });

  it('reports statistics in range and packs them for the renderer', () => {
    const result = fracture();
    const repair = new RepairSystem(result.graph, result.shards);
    const { bodies } = fakeBodies(result, assembled(result));
    repair.paintRange({ edgeId: result.graph.edges[0].id, amount: 0.9, from: 0.2, to: 0.7 }, controls);
    repair.step(DT, bodies, controls, true);
    const stats = repairStats(result.graph.edges);
    for (const value of [stats.goldFilled, stats.cured, stats.repaired]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(stats.goldFilled).toBeGreaterThan(0);
    expect(stats.openLength).toBeCloseTo(stats.totalLength, 9);
    repair.packGpu();
    expect(repair.gpuSamples.length).toBe(repair.sampleCount * 4);
    expect(Array.from(repair.gpuSamples).every((x) => Number.isFinite(x) && x >= -1 && x <= 1)).toBe(true);
    expect(repair.gpuEdges[0]).toBe(1);
  });
});

describe('fitting by hand', () => {
  /** The shard left standing, a piece that touches it, and another piece that touches that one. */
  function trio(result: FractureResult): { anchor: number; one: number; two: number } {
    const anchor = result.shards.find((shard) => shard.survivor)!.id;
    const touching = (id: number) => new Set(result.graph.edges
      .filter((edge) => edge.shardB !== null && (edge.shardA === id || edge.shardB === id))
      .map((edge) => (edge.shardA === id ? edge.shardB! : edge.shardA)));
    for (const one of touching(anchor)) {
      for (const two of touching(one)) if (two !== anchor) return { anchor, one, two };
    }
    throw new Error('the fracture has no such three pieces');
  }

  it('knows which pieces are in place on the standing part', () => {
    const result = fracture();
    const { anchor, one } = trio(result);
    const place = (shard: number): Pose => (shard === anchor || shard === one ? assembled(result)(shard) : scattered(result)(shard));
    const repair = new RepairSystem(result.graph, result.shards);
    const { bodies } = fakeBodies(result, place);
    repair.step(DT, bodies, controls, true);

    const standing = Array.from(repair.standing(anchor));
    expect(standing[anchor]).toBe(1);
    expect(standing[one]).toBe(1);
    expect(standing.reduce((count, x) => count + x, 0)).toBe(2);
    // A piece in the hand is not in place, however well it happens to sit.
    expect(Array.from(repair.standing(anchor, one))).toEqual(standing.map((x, shard) => (shard === one ? 0 : x)));
    expect(repair.standing(anchor, anchor).every((x) => x === 0)).toBe(true);
  });

  it('guides a held piece to its own place on the standing part rather than to a loose neighbour', () => {
    const result = fracture();
    const { anchor, one, two } = trio(result);
    // The standing part has been moved and turned as a whole. The held piece is somewhere near
    // it, and a loose neighbour lies exactly against the held piece.
    const turn = quatFromAxisAngle([0, 1, 0], 0.4);
    const shift: Vec3 = [0.5, 0, -0.3];
    const carried = (shard: number): Pose => ({ position: add3(quatRotate(turn, result.shards[shard].centroid), shift), rotation: turn });
    const held: Pose = { position: [1.6, 1.1, 0.8], rotation: quatFromAxisAngle([1, 0, 0], 0.7) };
    const against = (shard: number): Pose => ({
      position: add3(held.position, quatRotate(held.rotation, sub3(result.shards[shard].centroid, result.shards[one].centroid))),
      rotation: held.rotation,
    });
    const place = (shard: number): Pose => (shard === one ? held : shard === two ? against(two) : shard === anchor ? carried(anchor) : scattered(result)(shard));
    const repair = new RepairSystem(result.graph, result.shards);
    const { bodies } = fakeBodies(result, place);
    repair.step(DT, bodies, controls, true);

    const guide = repair.guidance(one, bodies, undefined, anchor)!;
    expect(guide.seated).toBe(true);
    expect(guide.mate).toBe(anchor);
    // Its place is where it was in the bowl, carried along with the standing part.
    const home = carried(one);
    for (let axis = 0; axis < 3; axis++) expect(guide.target.position[axis]).toBeCloseTo(home.position[axis], 9);
    expect(guide.target.rotation).toEqual(turn);
    expect(guide.reach).toBeGreaterThan(0);

    // Without an anchor the nearest mate wins: the loose piece lying against it.
    const loose = repair.guidance(one, bodies)!;
    expect(loose.seated).toBe(false);
    expect(loose.mate).toBe(two);
    expect(loose.distance).toBeLessThan(1e-6);
    // The standing part is the reference; it has no place of its own to be guided to.
    expect(repair.guidance(anchor, bodies, undefined, anchor)!.seated).toBe(false);
  });

  it('carries a brush stroke round a junction into closed cracks, and only those', () => {
    const result = fracture();
    const repair = new RepairSystem(result.graph, result.shards);
    const { bodies } = fakeBodies(result, assembled(result));
    repair.step(DT, bodies, controls, true);
    const { edges, nodes } = result.graph;

    // A junction in the wall where three cracks meet, painted from one long enough that the
    // brush does not also reach the junction at its other end.
    let chosen: CrackEdge[] | null = null;
    let junction = nodes[0];
    for (const node of nodes) {
      const meeting = [...new Set(node.ends.map((end) => end.edge))].map((id) => edges[id]);
      const from = meeting.find((edge) => edge.length > 0.4);
      if (node.boundary !== null || meeting.length < 3 || !from) continue;
      chosen = [from, ...meeting.filter((edge) => edge !== from)];
      junction = node;
      break;
    }
    expect(chosen).not.toBeNull();
    const [first, second, third] = chosen!;
    const endOf = (edge: CrackEdge) => junction.ends.find((end) => end.edge === edge.id)!.end;
    const atJunction = (edge: CrackEdge) => edge.resin.fill[endOf(edge) === 0 ? 0 : edge.resin.fill.length - 1];
    const total = () => edges.reduce((sum, edge) => sum + edge.resin.fill.reduce((a, b) => a + b, 0), 0);
    // One of the three is still open.
    third.aligned = false;

    const put = repair.paint(first, endOf(first), 0.6, 0.11, null, controls);
    expect(atJunction(first)).toBeGreaterThan(0.5);
    expect(atJunction(second)).toBeGreaterThan(0.5);
    expect(second.painted).toBe(3);
    // Nothing reaches the open crack, or any crack that does not meet this junction, and what
    // was reported as deposited is exactly what is there.
    const reached = new Set(chosen!.filter((edge) => edge !== third));
    for (const edge of edges) if (!reached.has(edge)) expect(Math.max(...edge.resin.fill)).toBe(0);
    expect(total()).toBeCloseTo(put, 5);

    // In the middle of a crack a stroke stays on that crack.
    const before = total();
    const alone = repair.paint(first, 0.5, 0.3, 0.11, null, controls);
    for (const edge of edges) if (!reached.has(edge)) expect(Math.max(...edge.resin.fill)).toBe(0);
    expect(total()).toBeCloseTo(before + alone, 5);

    // Gold brushed onto the broken face of a loose piece stays on that face.
    const face = repair.paint(third, endOf(third), 0.6, 0.11, 0, controls);
    expect(face).toBeGreaterThan(0);
    expect(total()).toBeCloseTo(before + alone + face, 5);
    expect(third.resin.fill.reduce((a, b) => a + b, 0)).toBeCloseTo(face, 5);
  });

  it('lays the tail of a brush footprint from the shared end inwards', () => {
    const edge = longEdge();
    const fill = edge.resin.fill, last = fill.length - 1;
    const put = depositResinFromEnd(edge, 1, 0.02, 0.5, 0.11, 0.6);
    expect(put).toBeGreaterThan(0);
    // A few centimetres in, whatever the spacing of the samples, there is still some.
    const inside = Math.max(1, Math.round(0.05 / edge.resin.spacing));
    expect(fill[last]).toBeGreaterThan(fill[last - inside]);
    expect(fill[last - inside]).toBeGreaterThan(0);
    expect(fill[0]).toBe(0);
    expect(fill.reduce((a, b) => a + b, 0)).toBeCloseTo(put, 5);
    // However much is asked for, a sample only holds so much.
    depositResinFromEnd(edge, 1, 0, 50, 0.11, 0.6);
    expect(Math.max(...fill)).toBeLessThanOrEqual(1);
    // Further from the junction than the brush reaches, nothing arrives.
    expect(depositResinFromEnd(longEdge(), 0, 0.5, 0.5, 0.11, 0.6)).toBe(0);
  });
});

describe('seam geometry', () => {
  it('follows the crack graph: every vertex belongs to a real edge sample', () => {
    const result = fracture();
    const repair = new RepairSystem(result.graph, result.shards);
    const seams = buildSeamGeometry(surface, result.graph, result.shards, repair.sampleOffsets);
    expect(seams.edgeCount).toBe(result.graph.edges.length);
    expect(seams.sampleCount).toBe(repair.sampleCount);
    expect(seams.vertices.length % SEAM_VERTEX_FLOATS).toBe(0);
    expect(Array.from(seams.vertices).every(Number.isFinite)).toBe(true);
    const vertexCount = seams.vertices.length / SEAM_VERTEX_FLOATS;
    for (let i = 0; i < vertexCount; i += 53) {
      const o = i * SEAM_VERTEX_FLOATS;
      const sample = seams.vertices[o + 11], edgeIndex = seams.vertices[o + 12];
      expect(edgeIndex).toBeGreaterThanOrEqual(0);
      expect(edgeIndex).toBeLessThan(result.graph.edges.length);
      const first = repair.sampleOffsets[edgeIndex];
      expect(sample).toBeGreaterThanOrEqual(first);
      expect(sample).toBeLessThan(first + result.graph.edges[edgeIndex].resin.fill.length);
    }
    let covered = 0, maxIndex = 0;
    for (const range of seams.ranges) {
      expect(result.shards[range.shard]).toBeDefined();
      covered += range.count;
    }
    for (let i = 0; i < seams.indices.length; i++) maxIndex = Math.max(maxIndex, seams.indices[i]);
    expect(covered).toBe(seams.indices.length);
    expect(maxIndex).toBeLessThan(vertexCount);
  });
});
