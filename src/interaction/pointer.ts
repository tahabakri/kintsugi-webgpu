import type { Mode, Tool } from '../config';
import type { Ray } from '../gpu/camera';
import type { BodyHit, CrackHit } from './picking';

/** What the pointer controller needs from the application. */
export interface PointerHost {
  readonly canvas: HTMLCanvasElement;
  mode(): Mode;
  tool(): Tool;
  isPaused(): boolean;
  ray(x: number, y: number): Ray;
  pick(x: number, y: number): BodyHit | null;
  /** The crack the brush would reach; `stroke` widens the reach for a stroke already under way. */
  crackAt(x: number, y: number, stroke?: boolean): CrackHit | null;
  orbitBy(dx: number, dy: number): void;
  zoomBy(factor: number): void;
  /** Returns false when the body cannot be held right now. */
  beginGrab(hit: BodyHit, x: number, y: number): boolean;
  moveGrab(x: number, y: number): void;
  spinGrab(dx: number, dy: number): void;
  /** Pushes the held piece away from (positive) or towards the camera. */
  pushGrab(amount: number): void;
  endGrab(throwIt: boolean): void;
  strike(hit: BodyHit, ray: Ray): void;
  /** Deposits resin; `amount` is in units of sample fill. */
  paint(hit: CrackHit, amount: number): void;
  hover(body: BodyHit | null, crack: CrackHit | null): void;
  /** Called when a paused study receives a gesture that would otherwise act on it. */
  blocked(): void;
}

type Action = 'none' | 'orbit' | 'grab' | 'paint' | 'gesture';

/**
 * Resin deposited per 5 px of stroke, and per second of holding the brush in place. One pass along
 * a crack is enough to fill it; a stroke across one leaves a pool that runs on along it.
 */
const PAINT_PER_STEP = 0.24;
const PAINT_PER_SECOND = 2.4;
const PAINT_STEP_PIXELS = 5;

/**
 * Turns pointer, wheel and touch input into orbiting, grabbing, striking and painting.
 *
 *   Break:  body under the pointer → grab (or strike target when armed); empty space → orbit.
 *   Repair: crack under the brush → paint; otherwise a shard → grab; empty space → orbit.
 *   Right-drag always orbits; wheel and pinch zoom; two fingers orbit.
 */
export class PointerController {
  private action: Action = 'none';
  private readonly touches = new Map<number, { x: number; y: number }>();
  private last = { x: 0, y: 0 };
  private pinch = 0;
  private centroid = { x: 0, y: 0 };
  private lastCrack: CrackHit | null = null;
  private hoverAt = { x: -1, y: -1, pending: false };

  constructor(private readonly host: PointerHost) {
    const canvas = host.canvas;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('lostpointercapture', this.onLost);
    canvas.addEventListener('pointerleave', () => { if (this.action === 'none') this.host.hover(null, null); });
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  get busy(): boolean {
    return this.action !== 'none';
  }

  get isGrabbing(): boolean {
    return this.action === 'grab';
  }

  /** Drops whatever the pointer is doing (Escape, mode change, reset). */
  cancel(): void {
    if (this.action === 'grab') this.host.endGrab(false);
    this.action = 'none';
    this.lastCrack = null;
  }

  /** Per-frame work: keep painting while the brush rests on a crack, and refresh the hover state. */
  update(dt: number): void {
    if (this.action === 'paint' && this.lastCrack && !this.host.isPaused()) {
      const crack = this.host.crackAt(this.last.x, this.last.y, true);
      if (crack) {
        this.lastCrack = crack;
        this.host.paint(crack, PAINT_PER_SECOND * dt);
      }
    }
    if (this.hoverAt.pending && this.action === 'none') {
      this.hoverAt.pending = false;
      this.refreshHover(this.hoverAt.x, this.hoverAt.y);
    }
  }

  private local(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.host.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private refreshHover(x: number, y: number): void {
    const host = this.host;
    if (host.isPaused()) { host.hover(null, null); return; }
    const crack = host.mode() === 'repair' && host.tool() === 'brush' ? host.crackAt(x, y) : null;
    host.hover(crack ? null : host.pick(x, y), crack);
  }

  private onDown = (event: PointerEvent): void => {
    const host = this.host;
    const { x, y } = this.local(event);
    host.canvas.focus({ preventScroll: true });
    try { host.canvas.setPointerCapture(event.pointerId); } catch { /* the pointer may already be gone */ }
    if (event.pointerType === 'touch') this.touches.set(event.pointerId, { x, y });

    if (this.touches.size >= 2) {
      // A second finger turns whatever was happening into a camera gesture.
      if (this.action === 'grab') host.endGrab(false);
      this.action = 'gesture';
      this.beginGesture();
      return;
    }

    this.last = { x, y };
    if (event.button === 2) { this.action = 'orbit'; return; }
    if (event.button !== 0) return;
    if (host.isPaused()) {
      host.blocked();
      this.action = 'orbit';
      return;
    }

    if (host.tool() === 'strike') {
      const hit = host.pick(x, y);
      if (hit && hit.kind === 'shard') {
        host.strike(hit, host.ray(x, y));
        this.action = 'none';
      } else {
        this.action = 'orbit';
      }
      return;
    }

    if (host.mode() === 'repair' && host.tool() === 'brush') {
      const crack = host.crackAt(x, y);
      if (crack) {
        this.action = 'paint';
        this.lastCrack = crack;
        host.paint(crack, PAINT_PER_STEP);
        return;
      }
    }

    const hit = host.pick(x, y);
    this.action = hit && host.beginGrab(hit, x, y) ? 'grab' : 'orbit';
  };

  private onMove = (event: PointerEvent): void => {
    const host = this.host;
    const { x, y } = this.local(event);
    if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, { x, y });
    if (this.action === 'gesture') { this.moveGesture(); return; }

    const dx = x - this.last.x, dy = y - this.last.y;
    switch (this.action) {
      case 'orbit':
        host.orbitBy(dx, dy);
        break;
      case 'grab':
        if (event.shiftKey) host.spinGrab(dx, dy);
        else host.moveGrab(x, y);
        break;
      case 'paint': {
        // Walk the stroke in short steps so a fast drag leaves no gaps.
        const distance = Math.hypot(dx, dy);
        const steps = Math.max(1, Math.min(40, Math.ceil(distance / PAINT_STEP_PIXELS)));
        for (let i = 1; i <= steps; i++) {
          const crack = host.crackAt(this.last.x + (dx * i) / steps, this.last.y + (dy * i) / steps, true);
          if (!crack) continue;
          this.lastCrack = crack;
          host.paint(crack, (PAINT_PER_STEP * distance) / (steps * PAINT_STEP_PIXELS));
        }
        break;
      }
      default:
        this.hoverAt = { x, y, pending: true };
    }
    this.last = { x, y };
  };

  private onUp = (event: PointerEvent): void => {
    this.touches.delete(event.pointerId);
    if (this.host.canvas.hasPointerCapture(event.pointerId)) this.host.canvas.releasePointerCapture(event.pointerId);
    if (this.action === 'gesture') {
      if (this.touches.size < 2) this.action = 'none';
      return;
    }
    if (this.action === 'grab') this.host.endGrab(event.type === 'pointerup');
    this.action = 'none';
    this.lastCrack = null;
    if (event.pointerType !== 'touch') {
      const { x, y } = this.local(event);
      this.hoverAt = { x, y, pending: true };
    } else {
      this.host.hover(null, null);
    }
  };

  private onLost = (event: PointerEvent): void => {
    this.touches.delete(event.pointerId);
    if (this.action === 'grab') this.host.endGrab(false);
    if (this.action !== 'gesture' || this.touches.size < 2) this.action = 'none';
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Normalise line/page scrolling to something like pixels.
    const delta = event.deltaY * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 240 : 1);
    if (this.action === 'grab') this.host.pushGrab(-delta * 0.0022);
    else this.host.zoomBy(Math.exp(delta * 0.0011));
  };

  private gesturePoints(): Array<{ x: number; y: number }> {
    return [...this.touches.values()].slice(0, 2);
  }

  private beginGesture(): void {
    const [a, b] = this.gesturePoints();
    this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    this.centroid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private moveGesture(): void {
    if (this.touches.size < 2) return;
    const [a, b] = this.gesturePoints();
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (this.pinch > 0 && distance > 0) this.host.zoomBy(this.pinch / distance);
    this.host.orbitBy(centre.x - this.centroid.x, centre.y - this.centroid.y);
    this.pinch = distance;
    this.centroid = centre;
  }
}
