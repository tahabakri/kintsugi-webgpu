import { quatSlerp, type Quat } from '../math/quat';
import type { Vec3 } from '../math/vec';

/** What a body must offer for its pose to be remembered. */
export interface PosedBody {
  handle: number;
  translation(): { x: number; y: number; z: number };
  rotation(): { x: number; y: number; z: number; w: number };
}

export interface BodyPose {
  position: Vec3;
  rotation: Quat;
}

/**
 * Remembers where every dynamic body was at the start of the last fixed step, so the renderer can
 * draw it between the last two steps. The simulation never reads this: it is only for drawing.
 */
export class PoseHistory {
  private readonly before = new Map<number, Float64Array>();

  /** Call once per fixed step, before stepping. */
  record(bodies: Iterable<PosedBody>): void {
    const seen = new Set<number>();
    for (const body of bodies) {
      seen.add(body.handle);
      let slot = this.before.get(body.handle);
      if (!slot) this.before.set(body.handle, slot = new Float64Array(7));
      const p = body.translation(), q = body.rotation();
      slot[0] = p.x; slot[1] = p.y; slot[2] = p.z; slot[3] = q.x; slot[4] = q.y; slot[5] = q.z; slot[6] = q.w;
    }
    for (const handle of this.before.keys()) if (!seen.has(handle)) this.before.delete(handle);
  }

  /** Pose between the last step's start (`alpha` 0) and where the body is now (`alpha` 1). */
  blend(body: PosedBody, alpha: number): BodyPose {
    const p = body.translation(), q = body.rotation();
    const now: BodyPose = { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
    const slot = this.before.get(body.handle);
    if (!slot || alpha >= 1) return now;
    const t = Math.max(0, alpha);
    // A body that has only just appeared has nothing to blend from.
    if (!Number.isFinite(slot[0])) return now;
    return {
      position: [slot[0] + (p.x - slot[0]) * t, slot[1] + (p.y - slot[1]) * t, slot[2] + (p.z - slot[2]) * t],
      rotation: quatSlerp([slot[3], slot[4], slot[5], slot[6]], now.rotation, t),
    };
  }
}
