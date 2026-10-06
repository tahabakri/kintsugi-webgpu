import { clamp, FRACTURE, type Controls } from '../config';
import { brittlenessFactor, thicknessFactor } from '../fracture/impact';
import { dist3, type Vec3 } from '../math/vec';

/** Where the thing the bowl hit belongs: the steel ball, the table top, or the rest of the stage. */
export type ImpactSource = 'ball' | 'table' | 'stage';

/** One contact of the intact bowl, as measured before the solver responded to it. */
export interface ImpactSample {
  source: ImpactSource;
  /** Which ball, for `source === 'ball'`. */
  ballIndex: number;
  /** Simulation time of the contact, in seconds. */
  time: number;
  /** Contact point and normal (pointing into the bowl) in the world. */
  point: Vec3;
  normal: Vec3;
  /** Contact point in the bowl's own space, and where it is on the bowl's surface. */
  localPoint: Vec3;
  u: number;
  v: number;
  relativeVelocity: Vec3;
  /** The other body's own velocity. */
  otherVelocity: Vec3;
  normalSpeed: number;
  tangentSpeed: number;
  effectiveMass: number;
  /** The bowl's own motion just before the contact. */
  bodyLinear: Vec3;
  bodyAngular: Vec3;
}

/**
 * How concentrated a contact is, relative to the bowl's flat foot standing on a table. The bowl
 * breaks when the energy it gives up is delivered through a small enough patch: a broad contact
 * spreads it, an edge or a point concentrates it. These are interpretable ratios of contact
 * patch size, not measured material constants.
 */
export const CONCENTRATION = {
  /** The foot ring, or the flat of the base, on something flat. */
  broad: 1,
  /** The curve of the wall meeting a flat surface along a line. */
  wall: 1.5,
  /** The thin rim meeting a flat surface. */
  edge: 2.2,
  /** A 1.3 cm steel sphere: a point. */
  steel: 28,
} as const;

/** Bowl latitude (v, 0 at the centre of the base, 1 at the rim) where the foot ends and the rim begins. */
const FOOT_TOP = 0.3;
const RIM_BOTTOM = 0.84;

/** Share of the tangential speed that counts towards the severity: a glancing blow breaks little. */
export const TANGENT_SHARE = 0.1;

/**
 * Normalised severity per unit of (energy × concentration) at default controls. Chosen so that the
 * bowl dropped foot-first onto the table survives a fall of about 5 cm, breaks from about 6 cm and
 * is shattered from about 30 cm; the rim breaks from about 3 cm.
 */
export const SEVERITY_SCALE = 1.1e-3;

export function contactConcentration(source: ImpactSource, v: number): number {
  if (source === 'ball') return CONCENTRATION.steel;
  if (v >= RIM_BOTTOM) return CONCENTRATION.edge;
  if (v >= FOOT_TOP) return CONCENTRATION.wall;
  return CONCENTRATION.broad;
}

export interface Severity {
  /** ½·m·v_n²: the energy of the blow along the contact normal. */
  rawEnergy: number;
  concentration: number;
  /** 0…1, the fracture model's energy. */
  normalized: number;
}

/**
 *   severity = ½·m_eff·(v_n² + share·v_t²) · concentration · brittleness / wall resistance,
 * scaled and clamped to 0…1. Tangential speed counts for a tenth as much as normal speed; its
 * direction is used later to steer the cracks.
 */
export function impactSeverity(sample: Pick<ImpactSample, 'source' | 'v' | 'normalSpeed' | 'tangentSpeed' | 'effectiveMass'>, controls: Pick<Controls, 'brittleness' | 'thickness'>): Severity {
  const rawEnergy = 0.5 * sample.effectiveMass * sample.normalSpeed ** 2;
  const driving = 0.5 * sample.effectiveMass * (sample.normalSpeed ** 2 + TANGENT_SHARE * sample.tangentSpeed ** 2);
  const concentration = contactConcentration(sample.source, sample.v);
  const scaled = (driving * concentration * SEVERITY_SCALE * brittlenessFactor(controls.brittleness)) / thicknessFactor(controls.thickness);
  return { rawEnergy, concentration, normalized: Number.isFinite(scaled) ? clamp(scaled, 0, FRACTURE.maxEnergy) : 0 };
}

/** What `ImpactEpisodes` needs to know about a sample it keeps. */
interface Episode {
  key: string;
  point: Vec3;
  start: number;
  best: ImpactSample;
  bestSeverity: number;
}

/**
 * One physical collision makes contacts on several consecutive steps, and on several of the
 * bowl's collision shapes. An episode gathers them for a short while and keeps the strongest, so
 * the fracture is judged once per collision, on its hardest moment.
 */
export class ImpactEpisodes {
  /** How long an episode stays open, in seconds. */
  static readonly WINDOW = 0.03;
  /** Contacts further apart than this (world units) are different collisions. */
  static readonly REGION = 2.2;

  private episodes: Episode[] = [];

  get open(): number {
    return this.episodes.length;
  }

  clear(): void {
    this.episodes = [];
  }

  add(sample: ImpactSample, severity: number): void {
    const key = sample.source === 'ball' ? `ball:${sample.ballIndex}` : sample.source;
    const episode = this.episodes.find((e) => e.key === key && sample.time - e.start <= ImpactEpisodes.WINDOW && dist3(e.point, sample.point) < ImpactEpisodes.REGION);
    if (!episode) {
      this.episodes.push({ key, point: sample.point, start: sample.time, best: sample, bestSeverity: severity });
      return;
    }
    if (severity > episode.bestSeverity) {
      episode.best = sample;
      episode.bestSeverity = severity;
    }
  }

  /**
   * Once any episode has run its course, returns the strongest contact of all that are open and
   * forgets them; until then returns null.
   */
  take(now: number): { sample: ImpactSample; severity: number } | null {
    if (!this.episodes.some((e) => now - e.start >= ImpactEpisodes.WINDOW - 1e-9)) return null;
    let best = this.episodes[0];
    for (const e of this.episodes) if (e.bestSeverity > best.bestSeverity) best = e;
    this.episodes = [];
    return { sample: best.best, severity: best.bestSeverity };
  }
}
