import { BowlSurface, OUTER } from './ceramic/uv-surface';
import {
  BOWL, clamp, CONTROL_NAMES, DEFAULT_CONTROLS, FRACTURE, INITIAL_SEED, lerp, MATERIAL_PHYSICS, MATERIALS, SIM, smoothstep, wallThicknessFor,
  type ControlName, type Controls, type MaterialName, type Mode, type Phase,
} from './config';
import { emitChips, emitCrumbs } from './effects/chips';
import { emitDust, ParticleSystem } from './effects/dust';
import { CameraImpulse } from './effects/impact-flash';
import { buildIntactBowl, fractureBowl, type FractureResult } from './fracture/fracture-system';
import type { CrackEdge } from './fracture/crack-graph';
import { CONTACT, fractureEnergy, strikerSpeed, type ImpactSpec } from './fracture/impact';
import type { ShardGeometry } from './fracture/shard-builder';
import type { Ray } from './gpu/camera';
import { PRESETS } from './gpu/materials';
import { WebGpuUnavailableError } from './gpu/context';
import { QUALITY_LEVELS, Renderer, type QualityLevel } from './gpu/renderer';
import { Modes } from './interaction/modes';
import { OrbitControls } from './interaction/orbit';
import { pickBody, pickCrack, type BodyHit, type CrackHit } from './interaction/picking';
import { PointerController, type PointerHost } from './interaction/pointer';
import { findOpenSpot, isOffStage, type Footprint } from './interaction/recover';
import { hashInts, mulberry32 } from './math/random';
import { QUAT_IDENTITY, quatConj, quatRotate, type Quat } from './math/quat';
import { add3, cross3, dot3, len3, norm3, scale3, sub3, type Vec2, type Vec3 } from './math/vec';
import { CARRY_SAG, Grab } from './physics/grab-joint';
import { Strikers } from './physics/striker';
import { fromVec, PhysicsWorld, toQuat, toVec, type Contact, type Overlap } from './physics/world';
import { RepairSystem, type RepairBodies } from './repair/repair-system';
import { buildSeamGeometry } from './repair/seam-geometry';
import { MobileSheet } from './ui/mobile-sheet';
import { installDebugHook } from './debug/hook';
import { addQualitySelector, bindPanel, mountInterface, setPauseButton, setSlider, type Interface, type PanelAction } from './ui/panel';
import { Coach, Hint, setStats, setStatus, showFallback } from './ui/status';

/** The bowl rests a hair above the plinth so its first contact is a clean one. */
const REST_HEIGHT = 0.004;
const DROP_HEIGHT = 2.2;
const INTACT = 0;

/**
 * How a piece in the hand is drawn to its place on the standing bowl, by how far from that place
 * the pointer is holding it (world units, across the view). It begins to turn the right way
 * round inside `turn`, is drawn in from `reach` and is fully home inside `core`. Once it sits
 * there it stays until the pointer has pulled further away than `release`, so a hand that
 * wavers does not shake it loose.
 */
const SEAT = { core: 0.3, reach: 1.0, turn: 2.0, release: 0.62 } as const;

/** Brush footprint along a crack, world units. */
const BRUSH_WIDTH = 0.11;
/** How near the pointer must be to a crack to paint it, in pixels: to start a stroke, and to keep one going. */
const BRUSH_REACH = { start: 15, stroke: 28 } as const;

const COACHING = 'Pick up a fragment and bring its matching edges close. Gold appears once the break is aligned.';

interface DropSequence {
  time: number;
  from: Vec3;
}

interface ScreenPoint {
  id: number;
  x: number;
  y: number;
}

export interface ScreenPoints {
  shards: ScreenPoint[];
  /** The middle of each crack, and a few points along it from one end to the other. */
  cracks: Array<ScreenPoint & { path: Array<[number, number]> }>;
  homes: ScreenPoint[];
}

export interface PieceState {
  id: number;
  /** The shard whose rigid body carries this one; bonded shards share it. */
  group: number;
  position: Vec3;
  /** Linear (units/s) and angular (rad/s) speed of the body. */
  speed: number;
  spin: number;
  asleep: boolean;
  /** True when the piece has left the table or slid out of reach. */
  offStage: boolean;
}

export interface AppStats {
  fragments: number;
  crackEdges: number;
  /** Total length of generated cracks, in metres. */
  crackLength: number;
  /** Length of cracks not yet bonded, in metres. */
  openCrackLength: number;
  goldFilled: number;
  cured: number;
  repaired: number;
  activeBodies: number;
  sleepingBodies: number;
  dustParticles: number;
  colliderFallbacks: number;
  /** Rigid pieces that have left the table or slid out of reach. */
  offStage: number;
  /** Milliseconds the last fracture took to generate. */
  fractureMs: number;
  /** Smoothed time between rendered frames, in milliseconds. */
  frameMs: number;
  /** Smoothed cost of one fixed simulation step, in milliseconds. */
  stepMs: number;
  /** Resolution scale currently chosen by the frame-time governor (1 = full). */
  quality: number;
  /** Render quality level: 'auto' adapts, 'high' and 'ultra' are fixed. */
  renderQuality: QualityLevel;
}

/**
 * The study itself: owns the simulation state and runs the fixed-step loop that ties the
 * fracture generator, the rigid-body world, the gold repair and the renderer together.
 */
export class App implements PointerHost {
  readonly canvas: HTMLCanvasElement;
  readonly controls: Controls = { ...DEFAULT_CONTROLS };
  seed = INITIAL_SEED;
  material: MaterialName = 'porcelain';
  paused = false;
  ready = false;

  private readonly modes: Modes;
  private readonly orbit: OrbitControls;
  private readonly pointer: PointerController;
  private readonly sheet: MobileSheet;
  private readonly hint: Hint;
  private readonly coach: Coach;
  private readonly strikers: Strikers;
  private readonly particles = new ParticleSystem();
  private readonly impulse: CameraImpulse;
  private readonly reducedMotion: boolean;

  private surface!: BowlSurface;
  private bowl!: ShardGeometry;
  private fracture: FractureResult | null = null;
  private repair: RepairSystem | null = null;
  private grab: Grab | null = null;
  private grabbed = -1;
  private grabPlane: Vec3 = [0, 0, 0];
  private grabPointer = { x: 0, y: 0 };
  /** True once the wheel has been used to push the held piece away or draw it nearer: its depth is then left alone. */
  private depthByHand = false;
  /** True while the standing part of the bowl is being held still for a piece to be fitted. */
  private steadying = false;
  /** The piece in the hand, the piece it is about to meet, and how nearly it fits (0…1). */
  private fit = { held: -1, mate: -1, amount: 0 };
  /** Where those two will touch, and how far round that place the cue reaches. */
  private meeting = { where: [0, 0, 0] as Vec3, reach: 1 };
  /** How strongly the piece in the hand is drawn to its place on the bowl (0…1), and whether it sits in it. */
  private seat = { pull: 0, latched: false };
  /** Guidance that is given once and not again. */
  private taught = { repair: false, seated: false, order: false, strays: false };
  /** Rigid pieces off the table or out of reach, recounted a few times a second. */
  private strays = 0;
  private ticks = 0;
  /** Simulation time at which a fresh fracture's contacts are tightened, or -1. */
  private tightenAt = -1;
  /** Earliest simulation time at which a settled fracture is checked for wedged pieces, or -1. */
  private easeAt = -1;
  private drop: DropSequence | null = null;

  private running = true;
  private lastFrame = 0;
  private accumulator = 0;
  private time = 0;
  private frameIndex = 0;
  private rebuildPending = false;
  private lastPuff = -1;
  private fractureMs = 0;
  private frameMs = 0;
  private stepMs = 0;
  /** Resolution scale chosen by the frame-time governor, and its bookkeeping. */
  private quality = 1;
  private scriptMs = 0;
  private governor = { since: 0, calm: 0, enabled: true };
  /** True when the resolution scale was fixed from the URL, and what it was fixed at. */
  private pinned = false;
  private pinnedScale = 1;
  private viewport = { width: 0, height: 0, layout: '' };
  private hoverCursor = '';

  constructor(
    private readonly ui: Interface,
    private readonly renderer: Renderer,
    private readonly physics: PhysicsWorld,
  ) {
    this.canvas = ui.canvas;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.hint = new Hint(ui);
    this.coach = new Coach(ui);
    this.modes = new Modes(() => this.onModeChange());
    this.orbit = new OrbitControls(renderer.camera, this.reducedMotion);
    this.impulse = new CameraImpulse(!this.reducedMotion);
    this.strikers = new Strikers(physics.world);
    this.sheet = new MobileSheet(ui, () => { this.viewport.layout = ''; });
    this.pointer = new PointerController(this);

    bindPanel(ui, {
      mode: (mode) => this.setMode(mode),
      material: (name) => this.setMaterial(name),
      control: (name, value) => this.setControl(name, value),
      action: (action, event) => this.onAction(action, event),
    });
    window.addEventListener('keydown', (event) => this.onKey(event));
    document.addEventListener('visibilitychange', () => { this.lastFrame = 0; });

    // `?q=0.8` pins the resolution scale (handy for comparable screenshots); otherwise it adapts.
    const pinned = Number(new URLSearchParams(window.location.search).get('q'));
    if (pinned > 0) {
      this.quality = clamp(pinned, 0.4, 1);
      this.pinnedScale = this.quality;
      this.pinned = true;
      this.governor.enabled = false;
    }
    // `?quality=high` or `?quality=ultra` starts at that level; the default adapts. `?debug`
    // adds a selector for it to the panel.
    const query = new URLSearchParams(window.location.search);
    if (query.has('debug')) addQualitySelector(ui, QUALITY_LEVELS, renderer.quality, (level) => this.setQuality(level as QualityLevel));
    const level = query.get('quality');
    if (level) this.setQuality(level as QualityLevel);

    this.spawnBowl();
    this.syncInterface();
  }

  start(): void {
    this.ready = true;
    this.hint.show('Drag the bowl and let it fall, or strike it.', 5200);
    requestAnimationFrame((ms) => this.frame(ms));
    // Run the fracture generator once on throwaway input so the first real break does not pay
    // for cold code. The result is discarded; no pattern is prepared in advance.
    const warm = () => fractureBowl(this.surface, { u: 0.31, v: 0.58, energy: 0.7 }, 1, this.controls);
    if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 2500 });
    else setTimeout(warm, 600);
  }

  /** Stops simulating and rendering, e.g. after the GPU device is lost. */
  stop(): void {
    this.running = false;
  }

  // ---- State ------------------------------------------------------------------------------------

  get intact(): boolean {
    return this.fracture === null;
  }

  get phase(): Phase {
    if (this.paused) return 'paused';
    if (!this.repair) return 'intact';
    const stats = this.repair.stats();
    if (stats.repaired >= 99.5) return 'repaired';
    return this.repair.started ? 'repairing' : 'fractured';
  }

  get stats(): AppStats {
    const counts = this.physics.counts();
    const repair = this.repair?.stats();
    return {
      fragments: this.repair ? this.repair.componentCount() : 1,
      crackEdges: this.fracture?.graph.edges.length ?? 0,
      crackLength: (repair?.totalLength ?? 0) * 0.1,
      openCrackLength: (repair?.openLength ?? 0) * 0.1,
      goldFilled: repair?.goldFilled ?? 0,
      cured: repair?.cured ?? 0,
      repaired: repair?.repaired ?? 0,
      activeBodies: counts.active,
      sleepingBodies: counts.sleeping,
      dustParticles: this.particles.count,
      offStage: this.strays,
      colliderFallbacks: this.physics.colliderFallbacks,
      fractureMs: this.fractureMs,
      frameMs: this.frameMs,
      stepMs: this.stepMs,
      quality: this.quality,
      renderQuality: this.renderer.quality,
    };
  }

  get cracks(): FractureResult['graph']['edges'] {
    return this.fracture?.graph.edges ?? [];
  }

  gpuInfo(): Record<string, unknown> {
    return this.renderer.info();
  }

  /** Where every shard is in the world, which rigid group carries it, and whether that group is at rest. */
  pieceStates(): PieceState[] {
    const states: PieceState[] = [];
    for (const piece of this.physics.pieces.values()) {
      const pose = this.physics.pose(piece.id)!;
      const v = piece.body.linvel(), w = piece.body.angvel();
      states.push({
        id: piece.id,
        group: piece.root,
        position: pose.position,
        speed: Math.hypot(v.x, v.y, v.z),
        spin: Math.hypot(w.x, w.y, w.z),
        asleep: piece.body.isSleeping(),
        offStage: isOffStage(toVec(piece.body.worldCom())),
      });
    }
    return states;
  }

  /** Pieces pressed into each other by more than `deeper` world units. */
  overlaps(deeper = 0.01): Overlap[] {
    return this.physics.overlaps(deeper);
  }

  cameraState(): { azimuth: number; elevation: number; distance: number } {
    const { azimuth, elevation, distance } = this.renderer.camera;
    return { azimuth, elevation, distance };
  }

  /**
   * Where the pieces and the middles of the cracks currently are on screen, in CSS pixels, and
   * where each loose piece belongs on the standing shell (its "home").
   */
  screenPoints(): ScreenPoints {
    const camera = this.renderer.camera;
    const shards: ScreenPoints['shards'] = [];
    const homes: ScreenPoints['homes'] = [];
    const shell = this.fracture ? this.physics.pieces.get(INTACT) : undefined;
    const shellPose = shell ? this.physics.pose(INTACT) : null;
    for (const piece of this.physics.pieces.values()) {
      const pose = this.physics.pose(piece.id);
      const p = pose ? camera.project(pose.position) : null;
      if (p) shards.push({ id: piece.id, x: p[0], y: p[1] });
      if (!shell || !shellPose || piece.body.handle === shell.body.handle) continue;
      const home = add3(shellPose.position, quatRotate(shellPose.rotation, sub3(piece.geometry.centroid, shell.geometry.centroid)));
      const h = camera.project(home);
      if (h) homes.push({ id: piece.id, x: h[0], y: h[1] });
    }
    const cracks: ScreenPoints['cracks'] = [];
    const onScreen = (edge: CrackEdge, index: number) => {
      const world = this.physics.worldPoint(edge.shardA, edge.polyline[index]);
      return world ? camera.project(world) : null;
    };
    for (const edge of this.cracks) {
      const last = edge.polyline.length - 1;
      const p = onScreen(edge, edge.polyline.length >> 1);
      if (!p) continue;
      const path: Array<[number, number]> = [];
      const stops = Math.min(last, 8);
      for (let i = 0; i <= stops; i++) {
        const q = onScreen(edge, Math.round((last * i) / stops));
        if (q) path.push([q[0], q[1]]);
      }
      cracks.push({ id: edge.id, x: p[0], y: p[1], path });
    }
    return { shards, cracks, homes };
  }

  // ---- Bowl lifecycle ---------------------------------------------------------------------------

  /** Builds a fresh intact bowl for the current thickness and stands it on the plinth. */
  private spawnBowl(): void {
    this.releaseGrab(false);
    this.drop = null;
    this.fracture = null;
    this.repair = null;
    this.particles.clear();
    this.physics.reset();
    this.strikers.rebind(this.physics.world);
    this.surface = new BowlSurface(wallThicknessFor(this.controls.thickness));
    this.bowl = buildIntactBowl(this.surface);
    this.physics.addPiece(this.bowl, [0, REST_HEIGHT, 0], [...QUAT_IDENTITY] as Quat, { reportContacts: true, sleeping: true });
    this.renderer.setShards([{ id: INTACT, mesh: this.bowl.mesh }]);
    this.renderer.setSeams(null);
    this.accumulator = 0;
    this.strays = 0;
    this.tightenAt = -1;
    this.easeAt = -1;
    this.coach.hide();
  }

  /** New intact bowl. A plain reset advances to the next deterministic seed. */
  reset(sameSeed = false): void {
    if (!sameSeed) this.seed = (this.seed + 1) >>> 0;
    this.paused = false;
    this.pointer.cancel();
    this.modes.reset();
    this.spawnBowl();
    this.syncInterface();
  }

  /**
   * Breaks the intact bowl at a material position with a given normalised energy. This is the one
   * place a fracture is created: real contacts and the automation hook both end up here.
   */
  breakAt(impact: ImpactSpec, cause: { point?: Vec3; direction?: Vec3; ball?: number } = {}): boolean {
    const piece = this.physics.pieces.get(INTACT);
    if (!this.intact || !piece) return false;
    const result = fractureBowl(this.surface, impact, this.seed, this.controls);
    if (!result) return false;
    this.fractureMs = result.elapsedMs;

    const body = piece.body;
    const rotation = toQuat(body.rotation());
    const origin = sub3(toVec(body.translation()), quatRotate(rotation, this.bowl.centroid));
    const linear = toVec(body.linvel()), angular = toVec(body.angvel());
    const centre = toVec(body.worldCom());
    this.releaseGrab(false);
    this.drop = null;
    this.physics.removePiece(INTACT);

    // Bowl-space geometry of the blow, used to send the pieces on their way.
    const spec = result.pattern.impact;
    const hit = this.surface.position(OUTER, spec.u, spec.v);
    const inward = scale3(this.surface.normal(OUTER, spec.u, spec.v), -1);
    const direction = cause.direction ? norm3(quatRotate(quatConj(rotation), cause.direction), inward) : inward;
    const rand = mulberry32(hashInts(result.pattern.rngSeed, 7));
    const reach = result.pattern.radius * 0.55;
    const energy = spec.energy;
    const shattered = result.pattern.shattered;

    // What struck the bowl gives up most of its momentum to the pieces round the contact. Share it
    // out by distance: the nearest are knocked inwards hard enough to fall into the bowl, while
    // the far side hardly feels it and simply falls away.
    const ball = cause.ball !== undefined ? this.strikers.findByTag(cause.ball) : null;
    const momentum = ball ? ball.mass() * len3(toVec(ball.linvel())) * 0.7 : 2.4 * Math.sqrt(energy);
    const reachBlow = result.pattern.radius * 1.1 + 0.25;
    let shares = 0;
    for (const shard of result.shards) {
      if (!shard.survivor) shares += Math.exp(-len3(sub3(shard.centroid, hit)) / reachBlow);
    }

    for (const shard of result.shards) {
      const fresh = this.physics.addPiece(shard, origin, rotation);
      const arm = sub3(toVec(fresh.body.translation()), centre);
      const carried = add3(linear, cross3(angular, arm));
      const away = sub3(shard.centroid, hit);
      const distance = len3(away);
      const jitter: Vec3 = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
      const turn = rand() - 0.5, share = 0.5 + rand();
      // What stays standing only feels the blow as a nudge.
      const hold = shard.survivor ? 0.06 : 1;
      const small = hold / (1 + shard.mass / 0.35), large = hold / (1 + shard.mass / 1.2);

      // The crushed zone bursts away from the contact: strongest beside it, never explosive.
      const burst = (1.3 + 4.4 * energy) * Math.exp(-distance / reach) * small;
      // The blow carries everything a little the way it was going, less with distance; the
      // pieces it actually hit take their share of its momentum on top.
      const struck = shard.survivor ? 0 : Math.min(7.5, (momentum * Math.exp(-distance / reachBlow)) / Math.max(shares, 1e-3) / Math.max(shard.mass, 0.02));
      const shove = (0.5 + 1.8 * energy) * Math.exp(-distance / (reach * 3 + 1.2)) * large + struck;
      // A wall that lets go all round releases its strain: each piece starts outwards from the
      // axis with a twist of its own, so no two fall alike.
      const out = norm3([shard.centroid[0], 0, shard.centroid[2]], [0, 0, 0]);
      const release = shattered ? (0.5 + 1.4 * energy) * share * large : 0;
      const local = add3(
        add3(scale3(norm3(away, inward), 0.6 * burst), scale3(direction, 0.55 * burst + shove)),
        add3(add3(scale3(out, release), scale3([-out[2], 0, out[0]], release * turn * 1.6)), scale3(jitter, 0.3 * burst)),
      );
      const velocity = add3(carried, quatRotate(rotation, local));
      const twist = (2 + 7 * energy) * Math.exp(-distance / reach) * hold + (shattered ? (1.6 + 3.4 * energy) * large : 0);
      const spin = add3(angular, quatRotate(rotation, scale3(jitter, twist)));
      fresh.body.setLinvel(fromVec(velocity), true);
      fresh.body.setAngvel(fromVec(spin), true);
    }

    // The striker has spent most of its energy breaking the wall; let it carry on, slowly.
    if (cause.ball !== undefined && cause.direction) {
      const ball = this.strikers.findByTag(cause.ball);
      if (ball) {
        const speed = len3(toVec(ball.linvel()));
        ball.setLinvel(fromVec(scale3(cause.direction, Math.max(2, speed * 0.3))), true);
      }
    }

    // Where the wall parts, a little powder and the odd crumb drop out of the new cracks.
    if (!this.reducedMotion || shattered) {
      const edges = result.graph.edges;
      const wanted = Math.round(clamp(result.graph.totalLength * 4.5, 24, this.reducedMotion ? 40 : 96));
      const points: Vec3[] = [];
      for (let i = 0; i < wanted; i++) {
        // Longer cracks shed more: pick an edge by length, then a place along it.
        let at = rand() * result.graph.totalLength, chosen = edges[0];
        for (const edge of edges) { chosen = edge; at -= edge.length; if (at <= 0) break; }
        const p = chosen.polyline[Math.min(chosen.polyline.length - 1, Math.floor(rand() * chosen.polyline.length))];
        points.push(add3(origin, quatRotate(rotation, p)));
      }
      const preset = PRESETS[this.material];
      emitCrumbs(this.particles, points, energy, [preset.glaze[0], preset.glaze[1], preset.glaze[2]], [preset.body[0], preset.body[1], preset.body[2]], result.pattern.rngSeed);
    }

    this.fracture = result;
    // Once the pieces have parted they no longer need the slack a fresh fracture is given.
    this.tightenAt = this.time + 0.4;
    this.easeAt = this.time + 1.2;
    this.repair = new RepairSystem(result.graph, result.shards);
    this.renderer.setShards(result.shards.map((shard) => ({ id: shard.id, mesh: shard.mesh })));
    this.renderer.setSeams(buildSeamGeometry(this.surface, result.graph, result.shards, this.repair.sampleOffsets));

    const point = cause.point ?? add3(origin, quatRotate(rotation, hit));
    this.burst(point, quatRotate(rotation, scale3(inward, -1)), spec.energy, true);
    this.impulse.kick(norm3(quatRotate(rotation, direction), [0, -1, 0]), spec.energy, this.renderer.camera.unitsPerPixel(point));
    this.modes.disarm();
    this.hint.show('Switch to Repair, bring matching edges together and trace them in gold.', 6000);
    this.syncInterface();
    return true;
  }

  private burst(point: Vec3, normal: Vec3, energy: number, broke: boolean): void {
    const preset = PRESETS[this.material];
    const body: Vec3 = [preset.body[0], preset.body[1], preset.body[2]];
    const glaze: Vec3 = [preset.glaze[0], preset.glaze[1], preset.glaze[2]];
    const dust: Vec3 = [lerp(body[0], 0.9, 0.55), lerp(body[1], 0.85, 0.55), lerp(body[2], 0.76, 0.55)];
    const seed = hashInts(this.seed, Math.round(this.time * 1000));
    emitDust(this.particles, point, normal, energy, dust, seed, { reducedMotion: this.reducedMotion, broke });
    if (broke) emitChips(this.particles, point, normal, energy, glaze, body, seed, this.reducedMotion);
  }

  /** A contact on the intact bowl: break it if the blow was hard enough, otherwise just puff. */
  private onContact(contact: Contact): void {
    const piece = this.physics.pieces.get(INTACT);
    if (!piece || !this.intact) return;
    const concentration = contact.other === 'ball' ? CONTACT.steel : CONTACT.table;
    const energy = fractureEnergy(contact.effectiveMass, contact.normalSpeed, concentration, this.controls);
    if (energy < FRACTURE.threshold) {
      // Too soft to break: a silent tap, with a wisp of dust if it was at least a knock.
      if (energy > 0.035 && this.time - this.lastPuff > 0.25) {
        this.lastPuff = this.time;
        this.burst(contact.point, scale3(contact.normal, -1), energy, false);
      }
      return;
    }

    const rotation = toQuat(piece.body.rotation());
    const inverse = quatConj(rotation);
    const local = add3(quatRotate(inverse, sub3(contact.point, toVec(piece.body.translation()))), this.bowl.centroid);
    const where = this.surface.materialOf(local);

    // Tangential part of the blow, expressed in the chart's (around, along-profile) axes.
    const direction = norm3(contact.relativeVelocity, contact.normal);
    const blow = quatRotate(inverse, direction);
    const here = this.surface.position(OUTER, where.u, where.v);
    const angle = where.u * Math.PI * 2;
    const around: Vec3 = [-Math.sin(angle), 0, Math.cos(angle)];
    const along = norm3(sub3(this.surface.position(OUTER, where.u, Math.min(1, where.v + 0.01)), here), [0, 1, 0]);
    const tangent: Vec2 = [dot3(blow, around), dot3(blow, along)];

    this.breakAt({ u: where.u, v: where.v, energy, tangent }, {
      point: contact.point,
      direction,
      ball: contact.other === 'ball' ? contact.ballIndex : undefined,
    });
  }

  // ---- Fixed step -------------------------------------------------------------------------------

  private readonly bodies: RepairBodies = {
    pose: (shard) => this.physics.pose(shard),
    // Bonded shards share a body, so these describe the rigid group a shard belongs to.
    mass: (shard) => this.physics.pieces.get(shard)?.body.mass() ?? 0,
    tack: (edge, a, b, anchors, stiffness, damping) => this.physics.tack(edge, a, b, anchors, stiffness, damping),
    untack: (edge) => this.physics.untack(edge),
    join: (a, b) => {
      const gone = this.physics.weld(a, b);
      // A held piece that has just become part of a larger one is let go: it has clicked home.
      if (gone && this.grab && this.grab.body.handle === gone.handle) {
        const grab = this.grab;
        this.grab = null;
        this.grabbed = -1;
        grab.abandon();
        this.pointer.cancel();
      }
    },
  };

  private tick(): void {
    const dt = SIM.dt;
    const started = performance.now();
    this.time += dt;
    this.updateDrop(dt);
    this.updateGrab(dt);

    if (this.tightenAt >= 0 && this.time >= this.tightenAt) {
      this.tightenAt = -1;
      this.physics.setContactSlack(true);
    }
    const watch = this.intact ? this.physics.pieces.get(INTACT) ?? null : null;
    const contact = this.physics.step(watch, watch ? this.strikers.bodies : []);
    this.strikers.update(dt);
    if (contact) this.onContact(contact);

    if (this.repair) {
      // A piece that sits in its place is steadied there like any other, hand on it or not.
      const inHand = this.drop || this.seat.latched ? -1 : this.grabbed;
      const bonded = this.repair.step(dt, this.bodies, this.controls, this.modes.mode === 'repair', inHand);
      if (bonded > 0 && this.repair.stats().repaired >= 99.5) this.hint.show('Mended. The breaks are part of it now.', 5200);
      if (this.ticks++ % 30 === 0) {
        this.countStrays();
        this.easeWedged();
      }
    }
    this.stepMs += (performance.now() - started - this.stepMs) * 0.05;
  }

  /** Advances the simulation by a span of time in fixed steps, whether or not it is paused. */
  step(seconds: number): void {
    const steps = Math.min(120 * 60, Math.max(0, Math.round(seconds / SIM.dt)));
    for (let i = 0; i < steps; i++) this.tick();
    this.particles.update(Math.min(seconds, 2));
    this.syncInterface();
  }

  // ---- Grabbing ---------------------------------------------------------------------------------


  private releaseGrab(throwIt: boolean): void {
    if (this.steadying) {
      this.physics.unsteady(INTACT);
      this.steadying = false;
    }
    if (this.seat.latched && !this.taught.seated) {
      this.taught.seated = true;
      this.hint.show('It holds. Now trace the closed crack in gold.', 5200);
    }
    this.fit = { held: -1, mate: -1, amount: 0 };
    this.seat = { pull: 0, latched: false };
    if (!this.grab) return;
    this.grab.release(this.time, throwIt);
    this.grab = null;
    this.grabbed = -1;
  }

  private updateGrab(dt: number): void {
    const grab = this.grab;
    if (!grab || this.drop) return;
    const camera = this.renderer.camera;
    const want = camera.onViewPlane(this.grabPointer.x, this.grabPointer.y, this.grabPlane);
    let centre = grab.centreFor(want);
    this.fit = { held: -1, mate: -1, amount: 0 };
    this.seat.pull = 0;

    // In Repair mode the hand is helped, never replaced. The pointer steers a piece across the
    // screen but cannot say how far away it should be or which way round, so as the piece nears
    // the place it came from it is turned to face it, its depth is eased to match, and over the
    // last few centimetres it is drawn in. It is the same rigid body throughout, carried on the
    // same spring: hold it somewhere else and that is where it goes.
    // What is left standing is the reference the rest is fitted to: carrying it, nothing guides it.
    const fitting = this.modes.mode === 'repair' && this.repair !== null && this.grabbed >= 0
      && this.repair.component(this.grabbed) !== this.repair.component(INTACT);
    const guide = fitting ? this.repair!.guidance(this.grabbed, this.bodies, camera.forward, INTACT) : null;
    const pose = guide ? this.physics.pose(this.grabbed) : null;
    if (guide && pose) {
      this.meeting = { where: guide.where, reach: guide.reach };
      // Where the body's centre of mass will be once the shard is in place, and how far from
      // there the pointer is holding it as the camera sees it.
      const arm = quatRotate(quatConj(pose.rotation), sub3(toVec(grab.body.worldCom()), pose.position));
      const home = add3(guide.target.position, quatRotate(guide.target.rotation, arm));
      const sight = sub3(centre, camera.eye);
      const depth = dot3(sub3(home, camera.eye), camera.forward) / Math.max(1e-6, dot3(sight, camera.forward));
      const across = len3(sub3(home, add3(camera.eye, scale3(sight, depth))));
      const depthError = dot3(sub3(home, centre), camera.forward);

      if (guide.seated) {
        const seat = this.seat;
        if (seat.latched && across > SEAT.release) seat.latched = false;
        grab.lean(guide.target.rotation, (1 - smoothstep(SEAT.core, SEAT.turn, across)) * dt * 8);
        seat.pull = seat.latched ? 1 : 1 - smoothstep(SEAT.core, SEAT.reach, across);
        if (!this.depthByHand || seat.pull > 0.5) this.grabPlane = add3(this.grabPlane, scale3(camera.forward, depthError * seat.pull * Math.min(1, dt * 6)));
        // The carrying spring lets a piece hang a little low; lift the target by as much, so
        // that home is where it comes to rest.
        const lifted: Vec3 = [home[0], home[1] + CARRY_SAG, home[2]];
        centre = [lerp(centre[0], lifted[0], seat.pull), lerp(centre[1], lifted[1], seat.pull), lerp(centre[2], lifted[2], seat.pull)];
        if (!seat.latched && seat.pull > 0.97 && guide.edge.aligned) seat.latched = true;
        if (seat.latched) grab.lean(guide.target.rotation, 1);
        // The two edges that are about to meet warm a little as they close.
        this.fit = { held: this.grabbed, mate: guide.mate, amount: 1 - smoothstep(SEAT.core, SEAT.reach * 1.3, across) };
      } else if (guide.distance < 1.6) {
        // A mate that is itself loose on the table: turn to face it and match its depth, no more.
        grab.lean(guide.target.rotation, (1 - smoothstep(0.4, 1.6, guide.distance)) * dt * 7);
        const near = this.depthByHand ? 0 : 1 - smoothstep(0.32, 1.0, across);
        this.grabPlane = add3(this.grabPlane, scale3(camera.forward, depthError * near * Math.min(1, dt * 5)));
        this.fit = { held: this.grabbed, mate: guide.mate, amount: 1 - smoothstep(0.1, 0.75, guide.distance) };
      }
    }
    grab.moveTo(want, this.time, centre);
    grab.steady(dt);
  }

  /**
   * Once, when a fracture has come to rest (or has had long enough to), pieces left pressed more
   * than two millimetres into one another are moved apart by that much. Nothing is rearranged:
   * the pile is the one the fall made, without the wedged overlaps.
   */
  private easeWedged(): void {
    if (this.easeAt < 0 || this.time < this.easeAt || this.grab) return;
    if (this.physics.counts().active > 0 && this.time < this.easeAt + 5) return;
    this.easeAt = -1;
    this.physics.easeApart(0.02, 0.06, INTACT);
  }

  // ---- Pieces that leave the table ----------------------------------------------------------------

  private countStrays(): void {
    const held = this.grab?.body.handle;
    let strays = 0;
    for (const group of this.physics.groups()) if (group.body.handle !== held && isOffStage(group.centre)) strays++;
    if (strays > this.strays && this.modes.mode === 'repair') this.teachRecovery();
    this.strays = strays;
  }

  private teachRecovery(): void {
    if (this.taught.strays || this.coach.visible) return;
    this.taught.strays = true;
    this.hint.show('A piece has left the table. Recover pieces brings it back.', 5600);
  }

  /**
   * Brings back the pieces that have fallen off the table or slid out of reach, and only those.
   * Each is set down as it lay, in open space beside or behind the bowl; nothing is fitted,
   * joined or painted, and nothing that was still within reach is touched.
   */
  recoverPieces(): number {
    if (!this.fracture) return 0;
    this.pointer.cancel();
    this.releaseGrab(false);
    const groups = this.physics.groups();
    const taken: Footprint[] = groups.filter((group) => !isOffStage(group.centre)).map((group) => ({ x: group.centre[0], z: group.centre[2], r: group.radius }));
    for (const ball of this.strikers.renderState()) taken.push({ x: ball.position[0], z: ball.position[2], r: MATERIAL_PHYSICS.strikerRadius });
    // The bowl is rebuilt where its standing part is; if that is what has gone, in the middle.
    const axis = this.physics.worldPoint(INTACT, [0, 0, 0]);
    const bowl = axis && !isOffStage(axis) ? { x: axis[0], z: axis[2] } : { x: 0, z: 0 };

    let recovered = 0;
    const placed: Footprint[] = [];
    const gap = 0.04;
    // Largest first: they are the hardest to find room for.
    for (const group of groups.filter((g) => isOffStage(g.centre)).sort((a, b) => b.radius - a.radius)) {
      const anchor = group.shards.includes(INTACT);
      const free = anchor && !taken.some((other) => Math.hypot(other.x - bowl.x, other.z - bowl.z) < other.r + group.radius);
      // An empty stretch of table if there is one; failing that, a gap among the pieces that
      // this one's own shape fits into without touching any of them.
      const spot = free ? bowl
        : findOpenSpot(group.radius, taken, bowl)
        ?? findOpenSpot(group.radius, placed, bowl, (x, z) => this.physics.fitsAt(group.body, x, z, gap));
      if (!spot) continue;
      this.physics.setDown(group.body, spot.x, spot.z, gap);
      taken.push({ x: spot.x, z: spot.z, r: group.radius });
      placed.push({ x: spot.x, z: spot.z, r: group.radius });
      recovered++;
    }
    this.countStrays();
    if (recovered > 0) this.hint.show(recovered === 1 ? 'One piece is back on the table.' : `${recovered} pieces are back on the table.`, 3200);
    else this.hint.show('There is no room on the table for them yet.', 3600);
    this.syncInterface();
    return recovered;
  }

  // ---- Drop test --------------------------------------------------------------------------------

  /** Lifts the intact bowl on a held spring and lets go, with a small seeded tilt. */
  dropTest(): void {
    const piece = this.physics.pieces.get(INTACT);
    if (!this.intact || !piece || this.drop || this.paused) return;
    this.pointer.cancel();
    this.releaseGrab(false);
    const from = toVec(piece.body.worldCom());
    this.grab = new Grab(this.physics.world, piece.body, from, this.time);
    this.grabbed = INTACT;
    this.drop = { time: 0, from };
    this.syncInterface();
  }

  private updateDrop(dt: number): void {
    const drop = this.drop, grab = this.grab;
    if (!drop || !grab) return;
    drop.time += dt;
    const lift = 0.6, hold = 0.14;
    const t = smoothstep(0, lift, drop.time);
    grab.moveTo([drop.from[0], drop.from[1] + DROP_HEIGHT * t, drop.from[2]], this.time);
    grab.steady(dt);
    if (drop.time < lift + hold) return;

    const body = grab.body;
    this.drop = null;
    this.releaseGrab(false);
    // Each seed lets go with its own slight tilt, so the bowl lands somewhere different.
    const rand = mulberry32(hashInts(this.seed, 0xd40b));
    const angle = rand() * Math.PI * 2;
    const tilt = 0.5 + rand() * 0.9;
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: Math.cos(angle) * tilt, y: (rand() - 0.5) * 0.6, z: Math.sin(angle) * tilt }, true);
    this.syncInterface();
  }

  // ---- PointerHost ------------------------------------------------------------------------------

  mode(): Mode {
    return this.modes.mode;
  }

  isPaused(): boolean {
    return this.paused;
  }

  tool(): Modes['tool'] {
    return this.modes.tool;
  }

  ray(x: number, y: number): Ray {
    return this.renderer.camera.ray(x, y);
  }

  pick(x: number, y: number): BodyHit | null {
    return pickBody(this.physics, this.renderer.camera.ray(x, y));
  }

  /**
   * The crack the brush would reach at a screen position. Gold goes on once a break is closed:
   * an open edge on a loose piece is not a target, so the pointer picks the piece up instead.
   */
  crackAt(x: number, y: number, stroke = false): CrackHit | null {
    if (!this.fracture) return null;
    return pickCrack(this.fracture.graph.edges, this.physics, this.renderer.camera, x, y, stroke ? BRUSH_REACH.stroke : BRUSH_REACH.start, true);
  }

  orbitBy(dx: number, dy: number): void {
    this.orbit.rotate(dx, dy);
  }

  zoomBy(factor: number): void {
    this.orbit.zoom(factor);
  }

  beginGrab(hit: BodyHit, x: number, y: number): boolean {
    if (hit.kind !== 'shard' || this.drop || this.paused) return false;
    this.releaseGrab(false);
    this.grab = new Grab(this.physics.world, hit.body, hit.point, this.time);
    this.grabbed = hit.id;
    // In Repair mode the part of the bowl that is standing is steadied while a piece is fitted to
    // it, as the other hand would do; it is let go again with the piece.
    this.steadying = this.modes.mode === 'repair' && this.fracture !== null && this.physics.steady(INTACT, hit.id) !== null;
    if (this.modes.mode === 'repair' && this.repair) {
      this.coach.hide();
      // A piece none of whose neighbours is back yet has nowhere to go: say so, once.
      const guide = this.repair.guidance(hit.id, this.bodies, undefined, INTACT);
      if (guide && !guide.seated && !this.taught.order && this.repair.component(hit.id) !== this.repair.component(INTACT)) {
        this.taught.order = true;
        this.hint.show('Its neighbours are not in place yet. Begin beside the standing part.', 5200);
      }
    }
    this.grabPlane = [...hit.point];
    this.grabPointer = { x, y };
    this.depthByHand = false;
    this.orbit.touch();
    this.setCursor('grabbing');
    return true;
  }

  moveGrab(x: number, y: number): void {
    this.grabPointer = { x, y };
    this.orbit.touch();
  }

  spinGrab(dx: number, dy: number): void {
    const camera = this.renderer.camera;
    this.grab?.turn([0, 1, 0], dx * 0.012);
    this.grab?.turn(camera.right, dy * 0.012);
  }

  pushGrab(amount: number): void {
    const camera = this.renderer.camera;
    const depth = dot3(sub3(this.grabPlane, camera.eye), camera.forward);
    const next = clamp(depth + amount, 1.5, 18);
    this.grabPlane = add3(this.grabPlane, scale3(camera.forward, next - depth));
    // Whoever reaches for the wheel is setting the depth themselves.
    this.depthByHand = true;
  }

  endGrab(throwIt: boolean): void {
    if (this.drop) return;
    // A piece that is being drawn to its place is put down there, not thrown.
    this.releaseGrab(throwIt && this.seat.pull < 0.5);
    this.setCursor(this.hoverCursor);
  }

  /** Throws a steel ball from the camera's side at the picked point. */
  strike(hit: BodyHit, ray: Ray): void {
    const from = add3(hit.point, scale3(ray.direction, -3.5));
    // Keep the launch point above the table and in front of the wall.
    if (from[1] < 0.3) from[1] = 0.3;
    this.strikers.launch(from, hit.point, strikerSpeed(this.controls.impact));
    this.modes.disarm();
  }

  paint(hit: CrackHit, amount: number): void {
    if (!this.repair) return;
    this.coach.hide();
    this.repair.paint(hit.edge, hit.s, amount, BRUSH_WIDTH, hit.side, this.controls);
  }

  hover(body: BodyHit | null, crack: CrackHit | null): void {
    this.renderer.setHighlight(body && body.kind === 'shard' && this.modes.tool !== 'strike' && !crack ? body.id : -1);
    if (this.modes.tool === 'strike') this.hoverCursor = 'strike';
    else if (crack) this.hoverCursor = 'brush';
    else if (body && body.kind === 'shard') this.hoverCursor = 'grab';
    else this.hoverCursor = '';
    if (!this.pointer.isGrabbing) this.setCursor(this.hoverCursor);
  }

  blocked(): void {
    this.hint.show('Paused. Resume to move or paint.', 2600);
  }

  private setCursor(cursor: string): void {
    if (this.canvas.dataset.cursor !== cursor) this.canvas.dataset.cursor = cursor;
  }

  // ---- Controls ---------------------------------------------------------------------------------

  setMode(mode: Mode): void {
    this.modes.setMode(mode);
  }

  private onModeChange(): void {
    this.pointer.cancel();
    if (this.modes.mode !== 'repair') this.coach.hide();
    if (this.modes.mode === 'repair' && this.intact) this.hint.show('Break the bowl first.', 3200);
    else if (this.modes.tool === 'strike') this.hint.show('Choose where the steel ball should land.', 4200);
    else if (this.modes.mode === 'repair' && !this.taught.repair) {
      // The first time there is something to mend, say how, beside the object itself.
      this.taught.repair = true;
      this.hint.hide();
      this.coach.show(COACHING, 18_000);
    } else if (this.modes.mode === 'repair' && this.strays > 0) this.teachRecovery();
    else if (this.modes.mode === 'repair' && this.modes.tool === 'brush' && !this.coach.visible) this.hint.show('Bring a piece to its place, then trace the closed crack in gold.', 4600);
    this.hoverCursor = this.modes.tool === 'strike' ? 'strike' : '';
    this.setCursor(this.hoverCursor);
    this.syncInterface();
  }

  setMaterial(name: MaterialName): void {
    if (!MATERIALS.includes(name)) return;
    // Recolours whatever is on the table; the fracture, if any, is left exactly as it is.
    this.material = name;
    this.renderer.setMaterial(name);
    this.syncInterface();
  }

  setControl(name: string, value: number): void {
    if (!CONTROL_NAMES.includes(name as ControlName) || !Number.isFinite(value)) return;
    const control = name as ControlName;
    this.controls[control] = clamp(Math.round(value), 0, 100);
    setSlider(this.ui, control, this.controls[control]);
    // Thickness reshapes the bowl, which is only possible while it is whole.
    if (control === 'thickness' && this.intact && !this.drop) this.rebuildPending = true;
  }

  /**
   * Render quality. 'auto' scales its resolution to hold the frame rate; 'high' and 'ultra' render
   * at a fixed, higher quality whatever that costs. Returns the level now in force.
   */
  setQuality(level: QualityLevel): QualityLevel {
    if (!QUALITY_LEVELS.includes(level)) return this.renderer.quality;
    this.renderer.setQuality(level);
    this.governor.enabled = this.renderer.adaptive && !this.pinned;
    this.governor.calm = 0;
    if (!this.renderer.adaptive) this.quality = 1;
    else if (this.pinned) this.quality = this.pinnedScale;
    this.viewport.layout = '';
    this.resize();
    if (this.ui.quality) this.ui.quality.value = level;
    return this.renderer.quality;
  }

  togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) {
      this.pointer.cancel();
      this.releaseGrab(false);
    }
    this.lastFrame = 0;
    this.syncInterface();
  }

  resetView(): void {
    this.orbit.reset();
  }

  /** Test helper: puts every shard back in its original place, at rest. Not reachable from the UI. */
  alignAllForTest(): void {
    if (!this.fracture) return;
    this.pointer.cancel();
    this.releaseGrab(false);
    for (const piece of this.physics.pieces.values()) {
      // Each body's origin is the centre of mass of its root shard.
      if (piece.root !== piece.id) continue;
      const c = piece.geometry.centroid;
      // Moved awake: a body teleported in its sleep keeps stale contacts and wakes up violently.
      piece.body.setTranslation({ x: c[0], y: c[1] + REST_HEIGHT, z: c[2] }, true);
      piece.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      piece.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      piece.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    for (const edge of this.fracture.graph.edges) edge.aligned = edge.shardB !== null;
  }

  /** Automation: fills cracks with resin directly, bypassing the pointer. */
  paintCrack(options: { edgeId?: number; amount?: number; from?: number; to?: number }): void {
    this.repair?.paintRange(options, this.controls);
  }

  private onAction(action: PanelAction, event: MouseEvent): void {
    switch (action) {
      case 'strike': this.modes.toggleStrike(); break;
      case 'drop': this.dropTest(); break;
      case 'brush': this.modes.toggleBrush(); break;
      case 'recover': this.recoverPieces(); break;
      case 'reset': this.reset(event.altKey); break;
      case 'pause': this.togglePause(); break;
      case 'reset-view': this.resetView(); break;
    }
    // On the phone, arming a tool should hand the screen back to the bowl.
    if (this.sheet.isSheet && this.sheet.isOpen && (action === 'strike' || action === 'drop')) this.sheet.setOpen(false);
  }

  private onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const typing = target ? /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) : false;
    switch (event.key) {
      case 'b': case 'B': if (!typing) this.setMode('break'); break;
      case 'r': case 'R': if (!typing) this.setMode('repair'); break;
      case 's': case 'S': if (!typing) this.modes.toggleStrike(); break;
      case 'g': case 'G': if (!typing) this.modes.toggleBrush(); break;
      case '0': if (!typing) this.resetView(); break;
      case ' ':
        // Leave Space to a focused button; anywhere else it pauses, and never scrolls the page.
        if (target && target.tagName === 'BUTTON') return;
        if (typing) return;
        event.preventDefault();
        this.togglePause();
        break;
      case 'Escape':
        this.pointer.cancel();
        this.modes.disarm();
        if (this.sheet.isOpen) this.sheet.setOpen(false);
        break;
    }
  }

  // ---- Frame ------------------------------------------------------------------------------------

  private syncInterface(): void {
    const ui = this.ui;
    const stats = this.stats;
    setStatus(ui, this.phase);
    setStats(ui, stats);
    for (const button of ui.modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === this.modes.mode));
    for (const button of ui.materialButtons) button.setAttribute('aria-pressed', String(button.dataset.material === this.material));
    ui.actionButtons.strike.setAttribute('aria-pressed', String(this.modes.tool === 'strike'));
    ui.actionButtons.brush.setAttribute('aria-pressed', String(this.modes.tool === 'brush'));
    ui.actionButtons.drop.disabled = !this.intact || this.drop !== null;
    // Only offered when there is something to bring back.
    ui.actionButtons.recover.hidden = !(this.modes.mode === 'repair' && this.strays > 0);
    if (ui.actionButtons.pause.getAttribute('aria-pressed') !== String(this.paused)) setPauseButton(ui, this.paused);
  }

  private resize(): void {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    const layout = `${width}x${height}:${this.sheet.isSheet}:${this.sheet.isOpen}:${window.devicePixelRatio}:${this.quality}:${this.renderer.quality}`;
    if (layout === this.viewport.layout) return;
    this.viewport = { width, height, layout };
    this.renderer.resize(width, height, window.devicePixelRatio || 1, this.quality);
    this.renderer.camera.setViewport(width, height, this.sheet.framing(width, height));
  }

  /**
   * Keeps the frame rate up on slow GPUs by trading resolution. It only reacts when the time is
   * going to the GPU: a frame that is long because the simulation is busy is left alone.
   */
  private govern(elapsed: number): void {
    const g = this.governor;
    if (!g.enabled) return;
    g.since += elapsed;
    if (g.since < 0.8) return;
    g.since = 0;
    const gpuBound = this.scriptMs < 8;
    if (this.frameMs > 19.5 && gpuBound && this.quality > 0.62) {
      this.quality = Math.max(0.6, +(this.quality - 0.1).toFixed(2));
      g.calm = 0;
    } else if (this.frameMs < 17.4) {
      // Comfortable for a good while: carefully try a little more resolution again.
      if (++g.calm >= 14 && this.quality < 1) {
        this.quality = Math.min(1, +(this.quality + 0.05).toFixed(2));
        g.calm = 6;
      }
    } else {
      g.calm = 0;
    }
  }

  private frame(ms: number): void {
    if (!this.running) return;
    requestAnimationFrame((next) => this.frame(next));
    const began = performance.now();
    const elapsed = this.lastFrame ? Math.min(0.1, (ms - this.lastFrame) / 1000) : 0;
    this.lastFrame = ms;
    if (elapsed > 0) {
      this.frameMs += (elapsed * 1000 - this.frameMs) * (this.frameMs ? 0.08 : 1);
      this.govern(elapsed);
    }

    if (this.rebuildPending) {
      this.rebuildPending = false;
      if (this.intact && !this.drop) this.spawnBowl();
    }

    if (!this.paused) {
      this.accumulator += elapsed;
      let steps = 0;
      while (this.accumulator >= SIM.dt && steps < SIM.maxCatchUpSteps) {
        this.tick();
        this.accumulator -= SIM.dt;
        steps++;
      }
      // If the tab stalled, drop the backlog rather than spiral.
      if (steps === SIM.maxCatchUpSteps) this.accumulator = 0;
      this.particles.update(elapsed);
      this.impulse.update(elapsed);
    }
    this.pointer.update(elapsed);
    this.orbit.update(elapsed);

    this.resize();
    const renderer = this.renderer;
    renderer.camera.shake = this.impulse.offset;
    if (this.coach.visible) {
      // Set over the place where the bowl is to be rebuilt, clear of its rim.
      const base = this.physics.worldPoint(INTACT, [0, 0, 0]) ?? [0, 0, 0];
      const over = renderer.camera.project([base[0], BOWL.height + 0.7, base[2]]);
      if (over) this.coach.place(over[0], over[1]);
    }
    for (const piece of this.physics.pieces.values()) {
      const pose = this.physics.pose(piece.id)!;
      const group = this.fit.amount > 0 && this.repair ? this.repair.component(piece.id) : -1;
      const meeting = group >= 0 && (group === this.repair!.component(this.fit.held) || piece.id === this.fit.mate) ? this.fit.amount : 0;
      renderer.setShardPose(piece.id, pose.position, pose.rotation, meeting);
    }
    renderer.setBalls(this.strikers.renderState());
    renderer.setSeamWidth(lerp(0.018, 0.064, this.controls.seamThickness / 100));
    renderer.setMending(this.modes.mode === 'repair');
    renderer.setMeeting(this.meeting.where, this.meeting.reach);
    if (this.repair) {
      this.repair.packGpu();
      renderer.updateResin(this.repair.gpuSamples, this.repair.gpuEdges);
    }
    renderer.setParticles(this.particles.instances, this.particles.pack());
    renderer.render(this.time);

    if (this.frameIndex++ % 6 === 0) this.syncInterface();
    this.scriptMs += (performance.now() - began - this.scriptMs) * 0.08;
  }
}

/**
 * Builds the page, brings up WebGPU and Rapier, and starts the study. If WebGPU cannot be had the
 * fallback overlay is shown instead; there is no WebGL path.
 */
export async function boot(root: HTMLElement): Promise<App | null> {
  const ui = mountInterface(root);
  let renderer: Renderer;
  try {
    renderer = await Renderer.create(ui.canvas);
  } catch (error) {
    if (!(error instanceof WebGpuUnavailableError)) console.warn('Kintsugi could not start WebGPU:', error);
    showFallback(ui);
    return null;
  }

  try {
    const physics = await PhysicsWorld.create();
    const app = new App(ui, renderer, physics);
    void renderer.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      app.stop();
      showFallback(ui, 'The GPU device was lost. Reload the page to begin again.');
    });
    installDebugHook(app);
    app.start();
    return app;
  } catch (error) {
    console.error('Kintsugi failed to start:', error);
    renderer.destroy();
    showFallback(ui);
    return null;
  }
}
