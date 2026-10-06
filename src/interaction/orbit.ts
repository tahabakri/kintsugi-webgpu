import { clamp, STAGE } from '../config';
import { CAMERA_DEFAULTS, type Camera } from '../gpu/camera';

/** The camera stays in front of the back wall. */
const AZIMUTH_REACH = 1.12;
const ELEVATION_MIN = 0.035;
const ELEVATION_MAX = 1.2;
const IDLE_DELAY = 6;
/**
 * Rate (per second) at which the camera closes on where the pointer has asked it to be. Pointer
 * events arrive unevenly; this evens them out over about 40 ms, which is below what is noticed as
 * lag but enough that a drag does not move in steps.
 */
const FOLLOW = 38;

/**
 * Orbit, zoom and "reset view" for the camera, plus a barely perceptible idle sway that stops the
 * image from feeling frozen. The sway is disabled for viewers who prefer reduced motion.
 */
export class OrbitControls {
  private azimuth: number = CAMERA_DEFAULTS.azimuth;
  private elevation: number = CAMERA_DEFAULTS.elevation;
  private distance: number = CAMERA_DEFAULTS.distance;
  /** Where the camera is drawn on screen: it follows the values above. */
  private shownAzimuth: number = CAMERA_DEFAULTS.azimuth;
  private shownElevation: number = CAMERA_DEFAULTS.elevation;
  private shownDistance: number = CAMERA_DEFAULTS.distance;
  private easing = false;
  private idle = 0;
  private drift = 0;
  private driftPhase = 0;

  constructor(private readonly camera: Camera, private readonly reducedMotion: boolean) {}

  /** Marks user activity, which holds the idle sway off. */
  touch(): void {
    this.idle = 0;
  }

  rotate(dxPixels: number, dyPixels: number): void {
    this.easing = false;
    this.touch();
    this.azimuth = clamp(this.azimuth - dxPixels * 0.0052, STAGE.azimuth - AZIMUTH_REACH, STAGE.azimuth + AZIMUTH_REACH);
    this.elevation = clamp(this.elevation + dyPixels * 0.0042, ELEVATION_MIN, ELEVATION_MAX);
  }

  zoom(factor: number): void {
    this.easing = false;
    this.touch();
    this.distance = clamp(this.distance * factor, CAMERA_DEFAULTS.minDistance, CAMERA_DEFAULTS.maxDistance);
  }

  /** Eases back to the default view. */
  reset(): void {
    this.easing = true;
    this.touch();
  }

  get isDefault(): boolean {
    return (
      Math.abs(this.azimuth - CAMERA_DEFAULTS.azimuth) < 1e-3 &&
      Math.abs(this.elevation - CAMERA_DEFAULTS.elevation) < 1e-3 &&
      Math.abs(this.distance - CAMERA_DEFAULTS.distance) < 1e-2
    );
  }

  update(dt: number): void {
    if (this.easing) {
      const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 6.5);
      this.azimuth += (CAMERA_DEFAULTS.azimuth - this.azimuth) * k;
      this.elevation += (CAMERA_DEFAULTS.elevation - this.elevation) * k;
      this.distance += (CAMERA_DEFAULTS.distance - this.distance) * k;
      if (this.isDefault) {
        this.azimuth = CAMERA_DEFAULTS.azimuth;
        this.elevation = CAMERA_DEFAULTS.elevation;
        this.distance = CAMERA_DEFAULTS.distance;
        this.easing = false;
      }
    }

    // Idle sway: fades in after a few seconds without input, fades out the moment there is some.
    this.idle += dt;
    const wanted = !this.reducedMotion && this.idle > IDLE_DELAY ? 1 : 0;
    this.drift += (wanted - this.drift) * (1 - Math.exp(-dt * (wanted ? 0.5 : 5)));
    this.driftPhase += dt * this.drift;
    const sway = this.reducedMotion ? 0 : Math.sin(this.driftPhase * 0.21) * 0.028 * this.drift;

    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * FOLLOW);
    this.shownAzimuth += (this.azimuth - this.shownAzimuth) * k;
    this.shownElevation += (this.elevation - this.shownElevation) * k;
    this.shownDistance += (this.distance - this.shownDistance) * k;
    this.camera.azimuth = this.shownAzimuth + sway;
    this.camera.elevation = this.shownElevation;
    this.camera.distance = this.shownDistance;
  }
}
