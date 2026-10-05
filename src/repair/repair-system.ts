import { clamp } from '../config';
import type { CrackEdge, CrackGraph, CrackNode } from '../fracture/crack-graph';
import type { ShardGeometry } from '../fracture/shard-builder';
import { quatRotate } from '../math/quat';
import { add3, dot3, len3, sub3, type Vec3 } from '../math/vec';
import { ASSIST_RANGE, isAligned, measureAlignment, type Pose } from './alignment';
import { cureResin, readyToJoin, repairStats, summariseEdge, type RepairStats } from './curing';
import { brushTemperature, coolResin, depositResin, depositResinFromEnd, exchangeAtNode, flowResin, resinIsLive, type ResinControls } from './resin';

/** What the repair logic needs from the rigid-body world; small enough to fake in unit tests. */
export interface RepairBodies {
  pose(shard: number): Pose | null;
  mass(shard: number): number;
  /**
   * Steadies two nearly mated shards with soft springs between matching points, given in bowl
   * coordinates. `stiffness` and `damping` are per spring.
   */
  tack(edge: number, a: number, b: number, anchors: Vec3[], stiffness: number, damping: number): void;
  untack(edge: number): void;
  /** Bonds two shards rigidly in their original mating pose. */
  join(a: number, b: number): void;
}

/** Where a held shard would have to be to mate with its nearest open neighbour. */
export interface Guidance {
  edge: CrackEdge;
  mate: number;
  target: Pose;
  /** Distance between the two sides of the edge right now, world units (see `guidance`). */
  distance: number;
  /** True when the mate is in place on the standing part of the bowl, so the target is the shard's own place in it. */
  seated: boolean;
  /** Where the two sides of the edge will meet, in the world, and how far round it they reach now. */
  where: Vec3;
  reach: number;
}

/** How much a gap along the line of sight counts when judging which mate a held shard is over. */
const DEPTH_WEIGHT = 0.3;

/** A ready edge bonds at once when its sides are this close, or after waiting this long. */
const BOND = { rms: 0.02, patience: 0.6 } as const;

const ASSIST = {
  /** Natural frequency (rad/s) and damping ratio of the springs that ease mated shards together. */
  frequency: 130,
  damping: 1,
  /** A shard has to be turned at least this nearly right (radians) before the assist engages. */
  engageAngle: 0.45,
  releaseAngle: 0.7,
} as const;

/**
 * Gold repair of one fracture: per-edge resin fields that flow and cure, the alignment state of
 * every crack, a restrained assist that eases nearly mated shards together, and the bonds that
 * form once aligned edges hold enough cured resin.
 */
export class RepairSystem {
  readonly edges: CrackEdge[];
  readonly nodes: CrackNode[];
  /** Offset of each edge's first sample in the packed GPU arrays. */
  readonly sampleOffsets: Int32Array;
  readonly sampleCount: number;
  /** Per sample: fill, cure, temperature, flow. */
  readonly gpuSamples: Float32Array;
  /** Per edge: show side A, show side B, mated, ready. */
  readonly gpuEdges: Float32Array;
  joints = 0;

  private readonly parent: Int32Array;
  private readonly centroids: Vec3[];
  private readonly radii: number[];
  /** Seconds each edge has spent ready to bond. */
  private readonly readyFor: Float32Array;
  /** Edges currently steadied by the alignment assist. */
  private readonly tacked = new Set<number>();
  /** How many crack edges each shard has. */
  private readonly degree: Int32Array;
  /** Every shard's pose this step, the same as seven numbers from the step before, and whether it changed. */
  private readonly poses: Array<Pose | null>;
  private readonly lastPose: Float64Array;
  private readonly moved: Uint8Array;
  /** Per edge: the gap and the turn between its two sides when last measured, and whether they have been. */
  private readonly gap: Float32Array;
  private readonly turn: Float32Array;
  private readonly measured: Uint8Array;
  /** Per edge: whether it holds resin that can still flow or cure this step. */
  private readonly live: Uint8Array;

  constructor(graph: CrackGraph, shards: readonly ShardGeometry[]) {
    this.edges = graph.edges;
    this.nodes = graph.nodes;
    this.centroids = shards.map((shard) => shard.centroid);
    this.radii = shards.map((shard) => shard.boundingRadius);
    this.parent = new Int32Array(shards.length).map((_, i) => i);
    this.sampleOffsets = new Int32Array(this.edges.length);
    let offset = 0;
    this.edges.forEach((edge, i) => {
      this.sampleOffsets[i] = offset;
      offset += edge.resin.fill.length;
    });
    this.sampleCount = offset;
    this.readyFor = new Float32Array(this.edges.length);
    this.degree = new Int32Array(shards.length);
    for (const edge of this.edges) {
      this.degree[edge.shardA]++;
      if (edge.shardB !== null) this.degree[edge.shardB]++;
    }
    this.gpuSamples = new Float32Array(Math.max(1, offset) * 4);
    this.gpuEdges = new Float32Array(Math.max(1, this.edges.length) * 4);
    this.poses = new Array<Pose | null>(shards.length).fill(null);
    this.lastPose = new Float64Array(shards.length * 7).fill(Number.NaN);
    this.moved = new Uint8Array(shards.length);
    this.gap = new Float32Array(this.edges.length);
    this.turn = new Float32Array(this.edges.length);
    this.measured = new Uint8Array(this.edges.length);
    this.live = new Uint8Array(this.edges.length);
  }

  // ---- Rigid components -----------------------------------------------------------------------

  /** Representative shard of the rigid group a shard belongs to. */
  component(shard: number): number {
    const parent = this.parent;
    while (parent[shard] !== shard) {
      parent[shard] = parent[parent[shard]];
      shard = parent[shard];
    }
    return shard;
  }

  /** Number of separate rigid pieces: bonded shards count as one. */
  componentCount(): number {
    let count = 0;
    for (let i = 0; i < this.parent.length; i++) if (this.component(i) === i) count++;
    return count;
  }

  /**
   * Which shards are in place on the standing part of the bowl: the anchor's own rigid group and
   * everything held to it across cracks that are closed, whether bonded or mated and waiting for
   * gold. The group of `without` (a shard in the hand, say) never counts.
   */
  standing(anchor: number, without = -1): Uint8Array {
    const inPlace = new Uint8Array(this.parent.length);
    const skip = without >= 0 ? this.component(without) : -1;
    if (anchor < 0 || anchor >= inPlace.length || this.component(anchor) === skip) return inPlace;
    inPlace[anchor] = 1;
    for (let grew = true; grew;) {
      grew = false;
      for (const edge of this.edges) {
        if (edge.shardB === null || !(edge.joined || edge.aligned)) continue;
        const a = inPlace[edge.shardA], b = inPlace[edge.shardB];
        if (a === b) continue;
        const next = a ? edge.shardB : edge.shardA;
        if (this.component(next) === skip) continue;
        inPlace[next] = 1;
        grew = true;
      }
    }
    return inPlace;
  }

  // ---- Brush ----------------------------------------------------------------------------------

  /**
   * Brushes resin onto an edge at parameter s (0…1). `side` records which shard's face received
   * it (0 = A, 1 = B); null means both, which is the case when the shards are already together.
   */
  paint(edge: CrackEdge, s: number, amount: number, width: number, side: 0 | 1 | null, controls: ResinControls): number {
    if (edge.joined && edge.fill >= 0.999) return 0;
    edge.painted |= side === null ? 3 : side === 0 ? 1 : 2;
    const temperature = brushTemperature(controls.temperature);
    let deposited = depositResin(edge, s, amount, width, temperature);
    if (side !== null || !edge.aligned) return deposited;

    // A brush is wider than a point. Within its footprint of a junction it also wets the start of
    // the other closed cracks that meet there, so one stroke carries on round a corner. It never
    // reaches a crack that does not share the junction, or one that is still open.
    for (const end of [0, 1] as const) {
      const beyond = (end === 0 ? clamp(s) : 1 - clamp(s)) * edge.length;
      if (beyond >= width * 2) continue;
      const node = this.nodes[end === 0 ? edge.nodeStart : edge.nodeEnd];
      if (!node || node.boundary === 'pole') continue;
      for (const other of node.ends) {
        const next = this.edges[other.edge];
        if (next === edge || !next.aligned || next.shardB === null || (next.joined && next.fill >= 0.999)) continue;
        const put = depositResinFromEnd(next, other.end, beyond, amount, width, temperature);
        if (put > 0) { next.painted = 3; deposited += put; }
      }
    }
    return deposited;
  }

  /** Fills a stretch of one edge, or of every edge, evenly. Used by the automation hook. */
  paintRange(options: { edgeId?: number; amount?: number; from?: number; to?: number }, controls: ResinControls): void {
    const amount = Math.max(0, options.amount ?? 0.4);
    const from = clamp(options.from ?? 0), to = clamp(options.to ?? 1);
    const targets = options.edgeId === undefined ? this.edges : this.edges.filter((edge) => edge.id === options.edgeId);
    const temperature = brushTemperature(controls.temperature);
    for (const edge of targets) {
      if (edge.shardB === null) continue;
      const { fill, cure, temperature: heat } = edge.resin;
      const n = fill.length;
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0;
        if (t < Math.min(from, to) || t > Math.max(from, to)) continue;
        const add = Math.min(amount, 1 - fill[i]);
        if (!(add > 0)) continue;
        const after = fill[i] + add;
        heat[i] = (heat[i] * fill[i] + temperature * add) / after;
        cure[i] = (cure[i] * fill[i]) / after;
        fill[i] = after;
      }
      edge.painted = 3;
      summariseEdge(edge);
    }
  }

  // ---- Simulation -------------------------------------------------------------------------------

  /**
   * Advances the repair by one fixed step. `assist` enables the alignment assist (Repair mode);
   * `held` is a shard in the hand, whose group the assist leaves alone until it is let go.
   * Returns how many edges bonded during the step.
   */
  step(dt: number, bodies: RepairBodies, controls: ResinControls, assist: boolean, held = -1): number {
    // Most of the time most of the pieces lie still and most of the cracks are dry or set, so the
    // step only looks at what can change: cracks between shards that moved, and cracks whose
    // resin is still liquid.
    const { edges, poses, lastPose, moved, measured, live } = this;
    for (let s = 0; s < poses.length; s++) {
      const pose = poses[s] = bodies.pose(s);
      const o = s * 7;
      if (!pose) { moved[s] = 1; lastPose[o] = Number.NaN; continue; }
      const p = pose.position, q = pose.rotation;
      moved[s] = lastPose[o] === p[0] && lastPose[o + 1] === p[1] && lastPose[o + 2] === p[2]
        && lastPose[o + 3] === q[0] && lastPose[o + 4] === q[1] && lastPose[o + 5] === q[2] && lastPose[o + 6] === q[3] ? 0 : 1;
      lastPose[o] = p[0]; lastPose[o + 1] = p[1]; lastPose[o + 2] = p[2];
      lastPose[o + 3] = q[0]; lastPose[o + 4] = q[1]; lastPose[o + 5] = q[2]; lastPose[o + 6] = q[3];
    }
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (edge.shardB === null) { edge.aligned = false; continue; }
      // A bonded edge is rigid: its two sides stay exactly as they were set.
      if (edge.joined) continue;
      const poseA = poses[edge.shardA], poseB = poses[edge.shardB];
      if (!poseA || !poseB) { edge.aligned = false; measured[i] = 0; continue; }
      if (measured[i] && !moved[edge.shardA] && !moved[edge.shardB]) continue;
      const m = measureAlignment(edge, poseA, poseB);
      edge.aperture = m.rms;
      edge.aligned = isAligned(edge.aligned, m);
      this.gap[i] = m.rms;
      this.turn[i] = m.angle;
      measured[i] = 1;
    }

    for (let i = 0; i < edges.length; i++) {
      live[i] = resinIsLive(edges[i]) ? 1 : 0;
      if (!live[i]) continue;
      coolResin(edges[i], dt);
      flowResin(edges[i], dt, controls);
    }
    for (const node of this.nodes) {
      let any = false;
      for (const end of node.ends) if (live[end.edge]) { any = true; break; }
      if (!any) continue;
      // Resin crosses a junction freely between cracks that are closed; into one that is still
      // open it can only creep, round the corner of the shard it is on.
      exchangeAtNode(node, edges, dt, controls, 1, 0.04);
      // A crack that has just taken liquid resin through the junction is live from here on.
      for (const end of node.ends) {
        if (live[end.edge]) continue;
        const { fill, cure } = edges[end.edge].resin;
        const at = end.end === 0 ? 0 : fill.length - 1;
        if (fill[at] > 0 && cure[at] < 1) live[end.edge] = 1;
      }
    }
    for (let i = 0; i < edges.length; i++) {
      if (!live[i]) continue;
      cureResin(edges[i], dt, controls);
      summariseEdge(edges[i]);
    }

    this.updateTacks(bodies, assist, held);

    let joined = 0;
    this.edges.forEach((edge, index) => {
      if (!readyToJoin(edge)) { this.readyFor[index] = 0; return; }
      const a = this.component(edge.shardA), b = this.component(edge.shardB!);
      if (a !== b) {
        // Bonding sets the two groups exactly into their original relative pose. Wait until the
        // assist has drawn them that close, so the bond closes a hair's breadth rather than a gap;
        // if something keeps them a few millimetres apart, the set gold pulls them in anyway.
        this.readyFor[index] += dt;
        if (edge.aperture > BOND.rms && this.readyFor[index] < BOND.patience) return;
        this.untackAll(bodies);
        bodies.join(edge.shardA, edge.shardB!);
        this.parent[a] = b;
        this.joints++;
      }
      edge.joined = true;
      edge.aperture = 0;
      joined++;
    });
    return joined;
  }

  /**
   * The alignment assist. Two shards whose matching edges have been brought within
   * ASSIST_RANGE.near of each other, the right way round, are steadied by soft springs towards
   * their original relative pose; the springs let go again beyond ASSIST_RANGE.far. They draw a
   * piece the last few millimetres home and keep it there against gravity until the gold has
   * cured. They never act on a piece that is in the hand, never reach across a real gap, and are
   * not a bond: switch back to Break and the pieces fall apart again.
   */
  private updateTacks(bodies: RepairBodies, assist: boolean, held: number): void {
    if (!assist && this.tacked.size === 0) return;
    const heldGroup = held >= 0 ? this.component(held) : -1;
    for (const edge of this.edges) {
      const tacked = this.tacked.has(edge.id);
      let want = false;
      if (assist && this.measured[edge.id] && !edge.joined && edge.shardB !== null) {
        const a = this.component(edge.shardA), b = this.component(edge.shardB);
        const inHand = heldGroup >= 0 && (a === heldGroup || b === heldGroup);
        want = a !== b && !inHand
          && this.gap[edge.id] < (tacked ? ASSIST_RANGE.far : ASSIST_RANGE.near)
          && this.turn[edge.id] < (tacked ? ASSIST.releaseAngle : ASSIST.engageAngle);
      }
      if (want && !tacked) {
        const a = edge.shardA, b = edge.shardB!;
        // Springs at both ends of the edge and at each shard's centre: together they resist
        // sliding apart and turning about any axis.
        const anchors: Vec3[] = [edge.polyline[0], edge.polyline[edge.polyline.length - 1], this.centroids[a], this.centroids[b]];
        // Sized to the lighter piece, with headroom for neighbours that may hang from it, and
        // shared between that piece's edges so that all its holds together stay soft enough
        // for the time step.
        const lighter = bodies.mass(a) <= bodies.mass(b) ? a : b;
        const mass = (Math.max(1e-4, bodies.mass(lighter)) * 2.5) / Math.max(1, this.degree[lighter]);
        const stiffness = (mass * ASSIST.frequency * ASSIST.frequency) / anchors.length;
        const damping = (2 * ASSIST.damping * mass * ASSIST.frequency) / anchors.length;
        bodies.tack(edge.id, a, b, anchors, stiffness, damping);
        this.tacked.add(edge.id);
      } else if (!want && tacked) {
        bodies.untack(edge.id);
        this.tacked.delete(edge.id);
      }
    }
  }

  private untackAll(bodies: RepairBodies): void {
    for (const id of this.tacked) bodies.untack(id);
    this.tacked.clear();
  }

  /** Number of edges the assist is currently steadying. */
  get assisted(): number {
    return this.tacked.size;
  }

  /**
   * The open edge of a held shard's group that is nearest its mate, and where the shard would have
   * to be for that edge to close. Given `view` (the direction the camera looks), a gap along it
   * counts for less: a hand moves a piece across the screen, not in depth, so a piece held over
   * its place is near it even while it is still in front of it.
   */
  guidance(shard: number, bodies: RepairBodies, view?: Vec3, anchor = -1): Guidance | null {
    const group = this.component(shard);
    const held = bodies.pose(shard);
    if (!held) return null;
    // With an anchor (the part of the bowl left standing), a mate that is in place on it wins
    // over any loose one, and the shard's target is its own place in the anchor's frame: every
    // piece is then fitted to the same bowl, not to a neighbour that may sit a hair off.
    const anchorPose = anchor >= 0 && this.component(anchor) !== group ? bodies.pose(anchor) : null;
    const standing = anchorPose ? this.standing(anchor, shard) : null;
    let best: Guidance | null = null;
    for (const edge of this.edges) {
      if (edge.joined || edge.shardB === null) continue;
      const inA = this.component(edge.shardA) === group, inB = this.component(edge.shardB) === group;
      if (inA === inB) continue;
      const mine = inA ? edge.shardA : edge.shardB, mate = inA ? edge.shardB : edge.shardA;
      const poseMine = bodies.pose(mine), poseMate = bodies.pose(mate);
      if (!poseMine || !poseMate) continue;
      const middle = edge.polyline[edge.polyline.length >> 1];
      const here = add3(poseMine.position, quatRotate(poseMine.rotation, sub3(middle, this.centroids[mine])));
      const there = add3(poseMate.position, quatRotate(poseMate.rotation, sub3(middle, this.centroids[mate])));
      const gap = sub3(there, here);
      let distance = len3(gap);
      if (view) {
        const depth = dot3(gap, view);
        distance = Math.hypot(Math.sqrt(Math.max(0, distance * distance - depth * depth)), depth * DEPTH_WEIGHT);
      }
      const seated = standing !== null && standing[mate] === 1;
      if (best && (best.seated !== seated ? best.seated : distance >= best.distance)) continue;
      // The whole held group is rigid, so the held shard mates when it shares the mate's frame.
      const frame = seated ? anchorPose! : poseMate, origin = seated ? anchor : mate;
      best = {
        edge,
        mate,
        distance,
        seated,
        where: [(here[0] + there[0]) / 2, (here[1] + there[1]) / 2, (here[2] + there[2]) / 2],
        reach: Math.max(0.45, edge.length * 0.6) + len3(gap) / 2,
        target: {
          position: add3(frame.position, quatRotate(frame.rotation, sub3(this.centroids[shard], this.centroids[origin]))),
          rotation: frame.rotation,
        },
      };
    }
    return best;
  }

  stats(): RepairStats {
    return repairStats(this.edges);
  }

  /** True once any resin has been brushed on or any edge has bonded. */
  get started(): boolean {
    return this.edges.some((edge) => edge.joined || edge.fill > 0.004);
  }

  /** Copies the simulation state into the flat arrays the gold shader reads. */
  packGpu(): void {
    const samples = this.gpuSamples, flags = this.gpuEdges;
    this.edges.forEach((edge, index) => {
      const { fill, cure, temperature, flow } = edge.resin;
      let at = this.sampleOffsets[index] * 4;
      for (let i = 0; i < fill.length; i++) {
        samples[at++] = fill[i];
        samples[at++] = cure[i];
        samples[at++] = temperature[i];
        samples[at++] = flow[i];
      }
      const mated = edge.shardB !== null && edge.aligned;
      const o = index * 4;
      // Together, the two sides share one seam; apart, each painted face carries its own resin.
      flags[o] = mated || (edge.painted & 1) !== 0 ? 1 : 0;
      flags[o + 1] = !mated && (edge.painted & 2) !== 0 ? 1 : 0;
      flags[o + 2] = mated ? 1 : 0;
      flags[o + 3] = mated && !edge.joined && edge.fill > 0.05 ? 1 : 0;
    });
  }
}
