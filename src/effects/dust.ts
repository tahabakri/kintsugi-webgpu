import { SIM, STAGE } from '../config';
import { PARTICLE_FLOATS } from '../gpu/layouts';
import { mulberry32 } from '../math/random';
import type { Vec3 } from '../math/vec';

export const MAX_PARTICLES = 500;

/** A mote of dust that hangs in the air and fades. */
export const KIND_MOTE = 0;
/** A flake of ceramic that falls, skips and then lies where it lands. */
export const KIND_CHIP = 1;
/** A grain of ceramic powder: falls quickly and stays put. */
export const KIND_GRAIN = 2;

export interface Particle {
  kind: number;
  position: Vec3;
  velocity: Vec3;
  age: number;
  life: number;
  size: number;
  rotation: number;
  spin: number;
  seed: number;
  colour: Vec3;
  opacity: number;
  /** True once a chip or a grain has come to rest; it then stays until the next reset. */
  resting?: boolean;
}

/**
 * Cheap visual particles for an impact: dust motes that hang, drift and fade within a couple of
 * seconds, and the debris of a break — chips and powder that fall and then lie on the table until
 * the bowl is reset. They are decoration only; nothing here is a rigid body.
 */
export class ParticleSystem {
  readonly particles: Particle[] = [];
  readonly instances = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);

  get count(): number {
    return this.particles.length;
  }

  clear(): void {
    this.particles.length = 0;
  }

  add(particle: Particle): void {
    if (this.particles.length < MAX_PARTICLES) this.particles.push(particle);
  }

  update(dt: number): void {
    const particles = this.particles;
    let kept = 0;
    for (const p of particles) {
      if (p.resting) { particles[kept++] = p; continue; }
      p.age += dt;
      const mote = p.kind === KIND_MOTE;
      if (mote && p.age >= p.life) continue;
      // Motes are light enough that the air nearly holds them; chips and grains are small stones.
      const gravity = mote ? SIM.gravity * 0.035 : SIM.gravity * 0.55;
      const drag = Math.exp(-dt * (mote ? 3.4 : p.kind === KIND_GRAIN ? 2.4 : 0.9));
      p.velocity[0] *= drag;
      p.velocity[1] = p.velocity[1] * drag - gravity * dt;
      p.velocity[2] *= drag;
      p.position[0] += p.velocity[0] * dt;
      p.position[1] += p.velocity[1] * dt;
      p.position[2] += p.velocity[2] * dt;
      p.rotation += p.spin * dt;

      const ahead = p.position[0] * Math.sin(STAGE.azimuth) + p.position[2] * Math.cos(STAGE.azimuth);
      const floor = ahead < STAGE.tableFront ? 0 : STAGE.floorY;
      if (p.position[1] < floor + p.size * 0.5) {
        p.position[1] = floor + p.size * 0.5;
        if (p.kind === KIND_CHIP && p.velocity[1] < -1.2) {
          p.velocity[1] *= -0.28;
          p.velocity[0] *= 0.55;
          p.velocity[2] *= 0.55;
          p.spin *= 0.5;
        } else if (mote) {
          p.velocity = [p.velocity[0] * 0.5, 0, p.velocity[2] * 0.5];
          // A mote that has settled fades out where it lies.
          p.life = Math.min(p.life, p.age + 0.45);
        } else {
          // Debris that fell off the table is gone; what landed on it stays.
          if (floor < 0) continue;
          p.velocity = [0, 0, 0];
          p.spin = 0;
          p.resting = true;
        }
      }
      particles[kept++] = p;
    }
    particles.length = kept;
  }

  /** Writes instance data for the renderer and returns the instance count. */
  pack(): number {
    const out = this.instances;
    const count = Math.min(MAX_PARTICLES, this.particles.length);
    for (let i = 0; i < count; i++) {
      const p = this.particles[i];
      const mote = p.kind === KIND_MOTE;
      const t = mote ? p.age / p.life : 0;
      // Motes fade in quickly so nothing pops and fade out slowly; debris simply appears.
      const fade = mote ? Math.min(1, t * 12) * (1 - t) ** 1.4 : Math.min(1, p.age * 30 + 0.2);
      const o = i * PARTICLE_FLOATS;
      out[o] = p.position[0];
      out[o + 1] = p.position[1];
      out[o + 2] = p.position[2];
      out[o + 3] = mote ? p.size * (1 + t * 1.8) : p.size;
      out[o + 4] = p.colour[0];
      out[o + 5] = p.colour[1];
      out[o + 6] = p.colour[2];
      out[o + 7] = p.opacity * fade;
      out[o + 8] = p.rotation;
      out[o + 9] = p.kind;
      out[o + 10] = p.seed;
      out[o + 11] = p.resting ? 1 : 0;
    }
    return count;
  }
}

/**
 * A puff of ceramic dust from a point of impact. `energy` is the normalised fracture energy;
 * 80–220 motes for a break, far fewer for a knock that did not break anything.
 */
export function emitDust(
  system: ParticleSystem,
  point: Vec3,
  normal: Vec3,
  energy: number,
  colour: Vec3,
  seed: number,
  options: { reducedMotion: boolean; broke: boolean },
): void {
  const rand = mulberry32(seed);
  let count = options.broke ? Math.round(80 + 140 * Math.min(1, Math.max(0, energy))) : Math.round(10 + 40 * energy);
  if (options.reducedMotion) count = Math.round(count * 0.55);
  const reach = options.broke ? 0.18 + 0.5 * energy : 0.06;
  for (let i = 0; i < count; i++) {
    // Mostly outwards along the surface normal, in a wide cone.
    const theta = rand() * Math.PI * 2, spread = Math.sqrt(rand());
    const side: Vec3 = [Math.cos(theta) * spread, (rand() - 0.25) * 0.8, Math.sin(theta) * spread];
    const speed = (0.6 + rand() * 3.4) * (0.5 + energy);
    const along = 0.4 + rand() * 0.9;
    system.add({
      kind: KIND_MOTE,
      position: [point[0] + side[0] * reach * rand(), point[1] + side[1] * reach * rand(), point[2] + side[2] * reach * rand()],
      velocity: [
        (normal[0] * along + side[0]) * speed,
        (normal[1] * along + side[1]) * speed + 0.8,
        (normal[2] * along + side[2]) * speed,
      ],
      age: 0,
      life: 0.7 + rand() * 1.2,
      size: 0.012 + rand() * 0.034,
      rotation: rand() * Math.PI * 2,
      spin: 0,
      seed: rand(),
      colour,
      opacity: 0.1 + rand() * 0.16,
    });
  }
}
