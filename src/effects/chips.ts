import { mulberry32 } from '../math/random';
import type { Vec3 } from '../math/vec';
import { KIND_CHIP, KIND_GRAIN, type ParticleSystem } from './dust';

/**
 * Tiny flakes of ceramic thrown off at the moment of fracture: 8–30 depending on the energy.
 * They fall, skip once or twice and then lie on the table. They are particles, not shards — the
 * pieces you can pick up are the generated rigid bodies.
 */
export function emitChips(
  system: ParticleSystem,
  point: Vec3,
  normal: Vec3,
  energy: number,
  glaze: Vec3,
  body: Vec3,
  seed: number,
  reducedMotion: boolean,
): void {
  const rand = mulberry32(seed ^ 0x2545f491);
  let count = Math.round(8 + 22 * Math.min(1, Math.max(0, energy)));
  if (reducedMotion) count = Math.round(count * 0.55);
  for (let i = 0; i < count; i++) {
    const theta = rand() * Math.PI * 2, spread = 0.3 + rand() * 0.9;
    const speed = (1.6 + rand() * 5.2) * (0.45 + energy * 0.8);
    // Some chips show the glaze, some the raw body.
    const colour = rand() > 0.45 ? glaze : body;
    system.add({
      kind: KIND_CHIP,
      position: [point[0] + (rand() - 0.5) * 0.12, point[1] + (rand() - 0.5) * 0.12, point[2] + (rand() - 0.5) * 0.12],
      velocity: [
        (normal[0] * 0.7 + Math.cos(theta) * spread) * speed,
        (normal[1] * 0.7 + rand() * 0.9) * speed + 1.5,
        (normal[2] * 0.7 + Math.sin(theta) * spread) * speed,
      ],
      age: 0,
      life: Infinity,
      size: 0.012 + rand() * 0.024,
      rotation: rand() * Math.PI * 2,
      spin: (rand() - 0.5) * 30,
      seed: rand(),
      colour,
      opacity: 0.95,
    });
  }
}

/**
 * The fine debris of a break: wherever a crack opens, a little powder and the odd crumb drop out
 * of it and stay on the table. `points` are places along the new cracks, in world space.
 */
export function emitCrumbs(
  system: ParticleSystem,
  points: readonly Vec3[],
  energy: number,
  glaze: Vec3,
  body: Vec3,
  seed: number,
): void {
  const rand = mulberry32(seed ^ 0x6a09e667);
  for (const point of points) {
    const crumb = rand() < 0.12;
    const theta = rand() * Math.PI * 2;
    const speed = (crumb ? 0.4 + rand() * 1.6 : 0.2 + rand() * 0.9) * (0.6 + energy * 0.6);
    system.add({
      kind: crumb ? KIND_CHIP : KIND_GRAIN,
      position: [point[0] + (rand() - 0.5) * 0.05, point[1] + (rand() - 0.5) * 0.05, point[2] + (rand() - 0.5) * 0.05],
      velocity: [Math.cos(theta) * speed, (rand() - 0.3) * speed, Math.sin(theta) * speed],
      age: 0,
      life: Infinity,
      size: crumb ? 0.01 + rand() * 0.02 : 0.004 + rand() * 0.009,
      rotation: rand() * Math.PI * 2,
      spin: crumb ? (rand() - 0.5) * 20 : 0,
      seed: rand(),
      colour: crumb && rand() > 0.6 ? glaze : body,
      opacity: crumb ? 0.95 : 0.55 + rand() * 0.35,
    });
  }
}
