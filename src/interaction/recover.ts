import { BOWL, STAGE } from '../config';
import type { Vec3 } from '../math/vec';

/** A circle of table already spoken for: a piece lying there, or the place a recovered one was given. */
export interface Footprint {
  x: number;
  z: number;
  r: number;
}

/**
 * The part of the table a visitor can work on: what the camera can be brought to see, either
 * side of the bowl. The table itself runs on well past it.
 */
export const USABLE = { halfWidth: 5.2, below: -0.4 } as const;

/** Stage axes on the table: towards the viewer, and to the viewer's right. */
const FRONT: readonly [number, number] = [Math.sin(STAGE.azimuth), Math.cos(STAGE.azimuth)];
const SIDE: readonly [number, number] = [Math.cos(STAGE.azimuth), -Math.sin(STAGE.azimuth)];

/** Table position (x, z) as distances to the viewer's right of, and in front of, the stage centre. */
export const stagePosition = (x: number, z: number): { side: number; front: number } =>
  ({ side: x * SIDE[0] + z * SIDE[1], front: x * FRONT[0] + z * FRONT[1] });

/** True for a piece that has left the table, or slid so far along it that it is out of reach. */
export function isOffStage(centre: Vec3): boolean {
  if (centre[1] < USABLE.below) return true;
  const { side, front } = stagePosition(centre[0], centre[2]);
  return Math.abs(side) > USABLE.halfWidth || front > STAGE.tableFront;
}

/**
 * Where round the bowl recovered pieces are put, as angles from the direction of the viewer
 * (negative = the viewer's left, where the table is open; the controls are on the right). Beside
 * and behind the bowl first, so nothing lands between it and whoever is mending it; the front
 * only when a crowded table leaves nowhere else.
 */
const BEARINGS = [-110, -140, -80, 110, 140, -165, 80, 165, -125, -95, 125, 95, -155, 155, 180, -60, 60, -40, 40, -20, 20, 0]
  .map((degrees) => (degrees * Math.PI) / 180);
const RINGS = 10;
const RING_STEP = 0.4;

/**
 * An open place on the table for a piece of the given radius: clear of everything in `taken`, clear
 * of the bowl and the room it needs to be rebuilt, on the usable part of the table and away from
 * its edges. `bowl` is where the bowl's axis meets the table. `fits`, if given, has the last
 * word on each candidate: a table strewn with pieces has no empty circles left, but it still has
 * gaps a particular piece fits into. Returns null if there is nowhere.
 */
export function findOpenSpot(
  radius: number,
  taken: readonly Footprint[],
  bowl: { x: number; z: number },
  fits?: (x: number, z: number) => boolean,
): { x: number; z: number } | null {
  const clearance = 0.08;
  for (let ring = 0; ring < RINGS; ring++) {
    const reach = BOWL.rimRadius + radius + 0.35 + ring * RING_STEP;
    for (const bearing of BEARINGS) {
      const towards = Math.cos(bearing) * reach, across = Math.sin(bearing) * reach;
      const x = bowl.x + FRONT[0] * towards + SIDE[0] * across;
      const z = bowl.z + FRONT[1] * towards + SIDE[1] * across;
      const { side, front } = stagePosition(x, z);
      if (Math.abs(side) > USABLE.halfWidth - radius - 0.3) continue;
      if (front < -STAGE.wallDistance + radius + 0.15 || front > STAGE.tableFront - radius - 0.8) continue;
      if (taken.some((other) => Math.hypot(other.x - x, other.z - z) < other.r + radius + clearance)) continue;
      if (fits && !fits(x, z)) continue;
      return { x, z };
    }
  }
  return null;
}
