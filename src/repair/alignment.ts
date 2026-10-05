import type { CrackEdge } from '../fracture/crack-graph';
import { quatAngleBetween, quatRotate, type Quat } from '../math/quat';
import { cross3, dot3, norm3, sub3, type Vec3 } from '../math/vec';

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

export interface AlignmentMetrics {
  /** RMS distance between matching points of the two sides, world units. */
  rms: number;
  /** Angle between the two shards' orientations, radians. */
  angle: number;
  /** Angle between the two sides' crack tangents, radians. */
  tangentError: number;
  /** How far the two fracture-face normals are from being exactly opposed, radians. */
  normalError: number;
}

const DEGREES = Math.PI / 180;

/** Entering and leaving thresholds differ so the ready state does not flicker at the boundary. */
export const ALIGN_ENTER = { rms: 0.055, angle: 9 * DEGREES, normal: 12 * DEGREES };
export const ALIGN_EXIT = { rms: 0.075, angle: 12 * DEGREES, normal: 16 * DEGREES };
/** The alignment assist starts fading in below `far` and is at full strength below `near`. */
export const ASSIST_RANGE = { near: 0.14, far: 0.18 };

/** Indices of up to `count` points spread evenly along a polyline, always including both ends. */
function spread(length: number, count: number): number[] {
  if (length <= count) return Array.from({ length }, (_, i) => i);
  return Array.from({ length: count }, (_, i) => Math.round((i * (length - 1)) / (count - 1)));
}

const transform = (pose: Pose, local: Vec3): Vec3 => {
  const p = quatRotate(pose.rotation, local);
  return [p[0] + pose.position[0], p[1] + pose.position[1], p[2] + pose.position[2]];
};

/**
 * Compares where the two sides of a crack edge currently are. Both sides store the same polyline
 * in their own shard's frame, so when the shards are mated the two world polylines coincide.
 */
export function measureAlignment(edge: CrackEdge, poseA: Pose, poseB: Pose): AlignmentMetrics {
  const picks = spread(edge.polylineLocalA.length, 7);
  let sum = 0;
  for (const i of picks) {
    const a = transform(poseA, edge.polylineLocalA[i]), b = transform(poseB, edge.polylineLocalB[i]);
    sum += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  }
  const rms = Math.sqrt(sum / picks.length);

  // Chord of the edge and through-thickness direction, in bowl space; the face normal is their cross product.
  const first = edge.polyline[0], last = edge.polyline[edge.polyline.length - 1];
  const middle = edge.polyline.length >> 1;
  const chord = norm3(sub3(last, first), [1, 0, 0]);
  const through = norm3(sub3(edge.polylineInner[middle], edge.polyline[middle]), [0, 1, 0]);
  const face = norm3(cross3(chord, through), [0, 0, 1]);

  const tangentA = quatRotate(poseA.rotation, chord), tangentB = quatRotate(poseB.rotation, chord);
  // Side A's face looks along +face, side B's along −face; mated, they are exactly opposed.
  const normalA = quatRotate(poseA.rotation, face), normalB = quatRotate(poseB.rotation, [-face[0], -face[1], -face[2]]);
  const clampAcos = (x: number) => Math.acos(Math.max(-1, Math.min(1, x)));
  return {
    rms,
    angle: quatAngleBetween(poseA.rotation, poseB.rotation),
    tangentError: clampAcos(dot3(tangentA, tangentB)),
    normalError: clampAcos(-dot3(normalA, normalB)),
  };
}

/** Applies the ready thresholds with hysteresis and returns the new aligned state. */
export function isAligned(wasAligned: boolean, m: AlignmentMetrics): boolean {
  const limit = wasAligned ? ALIGN_EXIT : ALIGN_ENTER;
  return m.rms < limit.rms && m.angle < limit.angle && m.tangentError < limit.angle && m.normalError < limit.normal;
}
