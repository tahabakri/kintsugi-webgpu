import type { Vec3 } from '../math/vec';

/**
 * The camera's flinch at a hard impact: a critically damped spring kicked once, so it travels out
 * and settles back without ringing. Kept under about three pixels on screen, and switched off
 * entirely for viewers who prefer reduced motion.
 */
export class CameraImpulse {
  offset: Vec3 = [0, 0, 0];
  private velocity: Vec3 = [0, 0, 0];
  private readonly frequency = 26;

  constructor(private readonly enabled: boolean) {}

  /**
   * @param direction unit vector to nudge along
   * @param energy normalised fracture energy, 0…1
   * @param unitsPerPixel world size of one pixel at the subject, so the shake is bounded in pixels
   */
  kick(direction: Vec3, energy: number, unitsPerPixel: number): void {
    if (!this.enabled || energy < 0.3) return;
    // Peak displacement of a critically damped spring kicked with velocity v is v / (e · ω).
    const peakPixels = 0.9 + 1.9 * Math.min(1, energy);
    const speed = peakPixels * unitsPerPixel * Math.E * this.frequency;
    this.velocity = [direction[0] * speed, direction[1] * speed, direction[2] * speed];
  }

  update(dt: number): void {
    if (!this.enabled) return;
    const w = this.frequency;
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < 3; i++) {
        const acceleration = -w * w * this.offset[i] - 2 * w * this.velocity[i];
        this.velocity[i] += acceleration * h;
        this.offset[i] += this.velocity[i] * h;
      }
    }
    if (Math.abs(this.offset[0]) + Math.abs(this.offset[1]) + Math.abs(this.offset[2]) < 1e-6 &&
        Math.abs(this.velocity[0]) + Math.abs(this.velocity[1]) + Math.abs(this.velocity[2]) < 1e-5) {
      this.offset = [0, 0, 0];
      this.velocity = [0, 0, 0];
    }
  }
}
