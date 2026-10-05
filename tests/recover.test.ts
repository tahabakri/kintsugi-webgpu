import { describe, expect, it } from 'vitest';
import { BOWL, STAGE } from '../src/config';
import { findOpenSpot, isOffStage, stagePosition, USABLE, type Footprint } from '../src/interaction/recover';

const centre = { x: 0, z: 0 };

describe('pieces that leave the table', () => {
  it('tells a piece on the table from one that has fallen or slid out of reach', () => {
    expect(isOffStage([0, 0.4, 0])).toBe(false);
    expect(isOffStage([1.8, 0.05, -1.2])).toBe(false);
    // On the floor in front of the table.
    expect(isOffStage([0, STAGE.floorY + 0.1, 0])).toBe(true);
    // Still on the table top, but far along it.
    const side: [number, number] = [Math.cos(STAGE.azimuth), -Math.sin(STAGE.azimuth)];
    expect(isOffStage([side[0] * (USABLE.halfWidth - 0.1), 0.05, side[1] * (USABLE.halfWidth - 0.1)])).toBe(false);
    expect(isOffStage([side[0] * (USABLE.halfWidth + 0.5), 0.05, side[1] * (USABLE.halfWidth + 0.5)])).toBe(true);
    expect(isOffStage([-side[0] * 9, 0.05, -side[1] * 9])).toBe(true);
  });

  it('finds open table beside the bowl, clear of it and of the edges', () => {
    const spot = findOpenSpot(0.5, [], centre)!;
    expect(spot).not.toBeNull();
    const { side, front } = stagePosition(spot.x, spot.z);
    // Room is left for the bowl to be rebuilt, and the piece is nowhere near the front edge.
    expect(Math.hypot(spot.x, spot.z)).toBeGreaterThan(BOWL.rimRadius + 0.5);
    expect(Math.abs(side)).toBeLessThan(USABLE.halfWidth - 0.5);
    expect(front).toBeLessThan(STAGE.tableFront - 0.5 - 0.5);
    expect(front).toBeGreaterThan(-STAGE.wallDistance + 0.5);
    expect(isOffStage([spot.x, 0.1, spot.z])).toBe(false);
    // The open side of the table is the viewer's left: the controls are on the right.
    expect(side).toBeLessThan(0);
  });

  it('gives every recovered piece a place of its own', () => {
    const taken: Footprint[] = [{ x: 0, z: 0, r: 0.7 }, { x: 1.4, z: 1.9, r: 0.6 }];
    const placed: Footprint[] = [];
    for (const radius of [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.3, 0.2]) {
      const spot = findOpenSpot(radius, [...taken, ...placed], centre);
      expect(spot, `room for a piece of radius ${radius}`).not.toBeNull();
      placed.push({ ...spot!, r: radius });
    }
    for (let i = 0; i < placed.length; i++) {
      expect(isOffStage([placed[i].x, 0.1, placed[i].z])).toBe(false);
      for (const other of [...taken, ...placed.slice(0, i)]) {
        expect(Math.hypot(placed[i].x - other.x, placed[i].z - other.z)).toBeGreaterThan(placed[i].r + other.r);
      }
    }
  });

  it('follows the bowl if it has been moved, and gives up when there is no room', () => {
    const moved = { x: -1.2, z: 0.6 };
    const spot = findOpenSpot(0.4, [], moved)!;
    expect(Math.hypot(spot.x - moved.x, spot.z - moved.z)).toBeGreaterThan(BOWL.rimRadius + 0.4);
    expect(findOpenSpot(0.5, [{ x: 0, z: 0, r: 30 }], centre)).toBeNull();
  });
});
